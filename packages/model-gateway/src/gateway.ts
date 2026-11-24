import { z } from "zod";
import type { Logger } from "@codemugs/logging";
import { costMicros, estimateTokens, isValidPrice } from "./cost.js";
import { ModelError, ProviderFailure, type ModelErrorCode, type ModelUsage } from "./errors.js";
import type { ModelPolicy } from "./policy.js";
import { redact } from "./redact.js";
import { renderPrompt } from "./render.js";
import {
  DATA_CLASSES,
  type CallContext,
  type DataClass,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ProviderResponse,
} from "./types.js";

/** The bounds of a request. They are the gateway's and not the caller's, so a caller cannot ask for more. */
export const GATEWAY_LIMITS = {
  maxPromptCharacters: 1_000_000,
  maxInstructionCharacters: 100_000,
  maxDataParts: 200,
  maxOutputTokens: 64_000,
  minTimeoutMs: 1,
  maxTimeoutMs: 600_000,
  defaultTimeoutMs: 120_000,
} as const;

const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ORGANISATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASSES: ReadonlySet<string> = new Set(DATA_CLASSES);

export interface GatewayOptions {
  readonly providers: readonly ModelProvider[];
  readonly policy: ModelPolicy;
  readonly logger?: Logger;
  /** How long a call may take before it is given up, in milliseconds. */
  readonly timeoutMs?: number;
  /** Random bytes for the boundary of a prompt's data blocks. Only a test changes this. */
  readonly random?: (bytes: number) => Uint8Array;
  readonly now?: () => number;
}

export interface ModelGateway {
  /**
   * Asks a model and gives back an answer that has been checked against the schema that was asked for,
   * with what it cost. It fails with a `ModelError` and nothing else, whose message holds nothing of
   * the request or the answer.
   */
  call<T>(context: CallContext, request: ModelRequest<T>): Promise<ModelResult<T>>;
}

class Aborted extends Error {}
const ABORTED = new Aborted("aborted");

/** Gives up waiting for `work` when `signal` aborts, even if the work itself never looks at the signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      work.catch(() => undefined);
      reject(ABORTED);
      return;
    }
    const onAbort = (): void => {
      reject(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("the provider failed"));
      },
    );
  });
}

function checkProviders(providers: readonly ModelProvider[]): void {
  if (providers.length === 0) throw new RangeError("the model gateway needs at least one provider");
  const names = new Set<string>();
  for (const provider of providers) {
    const { capabilities } = provider;
    if (
      !NAME.test(provider.name) ||
      names.has(provider.name) ||
      provider.model.length === 0 ||
      !isValidPrice(provider.price) ||
      !Number.isSafeInteger(capabilities.maxContextTokens) ||
      capabilities.maxContextTokens < 1 ||
      !Number.isSafeInteger(capabilities.maxOutputTokens) ||
      capabilities.maxOutputTokens < 1
    ) {
      throw new RangeError("a model provider is not valid or its name is used twice");
    }
    names.add(provider.name);
  }
}

function checkRequest<T>(context: CallContext, request: ModelRequest<T>): void {
  const characters =
    request.instructions.length + request.data.reduce((sum, part) => sum + part.content.length, 0);
  const valid =
    ORGANISATION.test(context.organisationId) &&
    NAME.test(request.task) &&
    request.instructions.length > 0 &&
    request.instructions.length <= GATEWAY_LIMITS.maxInstructionCharacters &&
    request.data.length <= GATEWAY_LIMITS.maxDataParts &&
    request.data.every((part) => LABEL.test(part.label) && CLASSES.has(part.dataClass)) &&
    Number.isSafeInteger(request.maxOutputTokens) &&
    request.maxOutputTokens >= 1 &&
    request.maxOutputTokens <= GATEWAY_LIMITS.maxOutputTokens &&
    characters <= GATEWAY_LIMITS.maxPromptCharacters;
  if (!valid) throw new ModelError("invalid_request");
}

/** One surrounding code fence is allowed, because models add one; anything else that is not JSON is not. */
function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fenced?.[1] !== undefined) body = fenced[1];
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Whether the provider said what it used, in whole numbers. A provider that does not cannot be accounted. */
function hasUsage(response: ProviderResponse): boolean {
  return (
    typeof response.text === "string" &&
    Number.isSafeInteger(response.inputTokens) &&
    response.inputTokens >= 0 &&
    Number.isSafeInteger(response.outputTokens) &&
    response.outputTokens >= 0
  );
}

/** Why an answer that was given cannot be used, if it cannot, before its content is looked at. */
function answerFault(
  response: ProviderResponse,
  maxOutputTokens: number,
): ModelErrorCode | undefined {
  if (response.finish === "refused") return "refused";
  if (response.finish === "length") return "output_truncated";
  // An adapter that reports more output than was allowed, or an answer far longer than the limit, is not to be trusted.
  if (response.outputTokens > maxOutputTokens) return "provider_unavailable";
  if (response.text.length > maxOutputTokens * 16) return "output_invalid";
  return undefined;
}

/** What goes in a log of a request that has not been checked: its task and organisation only if they are well formed. */
function loggable<T>(
  context: CallContext,
  request: ModelRequest<T>,
): { task: string; organisationId: string } {
  return {
    task: typeof request.task === "string" && NAME.test(request.task) ? request.task : "invalid",
    organisationId:
      typeof context.organisationId === "string" && ORGANISATION.test(context.organisationId)
        ? context.organisationId
        : "invalid",
  };
}

export function createModelGateway(options: GatewayOptions): ModelGateway {
  checkProviders(options.providers);
  const timeoutMs = options.timeoutMs ?? GATEWAY_LIMITS.defaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < GATEWAY_LIMITS.minTimeoutMs ||
    timeoutMs > GATEWAY_LIMITS.maxTimeoutMs
  ) {
    throw new RangeError("the timeout of the model gateway is out of range");
  }
  const now = options.now ?? Date.now;

  return {
    async call<T>(context: CallContext, request: ModelRequest<T>): Promise<ModelResult<T>> {
      const started = now();
      let provider: ModelProvider | undefined;
      try {
        checkRequest(context, request);
        if (context.signal?.aborted) throw new ModelError("aborted");

        // 1. What may leave the platform. A class that the policy does not name does not.
        // The wait for the policy is given up when the caller leaves, and the caller is looked at once more just before the provider is called (step 5).
        let permitted: ReadonlySet<DataClass>;
        try {
          const pending = options.policy.permittedClasses(context.organisationId);
          permitted =
            context.signal === undefined ? await pending : await abortable(pending, context.signal);
        } catch {
          throw new ModelError(context.signal?.aborted ? "aborted" : "policy_unavailable");
        }
        if (request.data.some((part) => !permitted.has(part.dataClass))) {
          throw new ModelError("not_permitted");
        }

        // 2. Nothing that looks like a secret leaves. The platform's own instructions must not hold one at all.
        if (redact(request.instructions).total > 0) throw new ModelError("invalid_request");
        let redactions = 0;
        const data = request.data.map((part) => {
          const cleaned = redact(part.content);
          redactions += cleaned.total;
          return { ...part, content: cleaned.text };
        });

        // 3. Instructions and data apart, and the shape of the answer.
        const prompt = renderPrompt(request.instructions, data, options.random);
        let jsonSchema: Readonly<Record<string, unknown>>;
        try {
          jsonSchema = z.toJSONSchema(request.output);
        } catch {
          throw new ModelError("invalid_request");
        }
        if (jsonSchema["type"] !== "object") throw new ModelError("invalid_request");

        // 4. A provider that can take it.
        const needed =
          estimateTokens(prompt.system) +
          estimateTokens(prompt.user) +
          estimateTokens(JSON.stringify(jsonSchema)) +
          request.maxOutputTokens;
        provider = options.providers.find(
          ({ capabilities }) =>
            needed <= capabilities.maxContextTokens &&
            request.maxOutputTokens <= capabilities.maxOutputTokens,
        );
        if (provider === undefined) throw new ModelError("no_capable_provider");
        // Nothing is sent for a caller who has gone, however long the steps before took.
        if (context.signal?.aborted) throw new ModelError("aborted");

        // 5. The call, given up when the time is up or the caller leaves, whatever the adapter does.
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal =
          context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
        let response: ProviderResponse;
        try {
          response = await abortable(
            provider.complete({
              model: provider.model,
              system: prompt.system,
              user: prompt.user,
              jsonSchema,
              maxOutputTokens: request.maxOutputTokens,
              signal,
            }),
            signal,
          );
        } catch (error) {
          if (context.signal?.aborted) throw new ModelError("aborted");
          if (timeout.aborted) throw new ModelError("timeout");
          if (error instanceof ProviderFailure) throw new ModelError(error.code);
          throw new ModelError("provider_unavailable");
        }

        // 6. What the call used is worked out first, because it is billed whether or not the answer can be
        // used, and a failure from here on carries it.
        if (!hasUsage(response)) throw new ModelError("provider_unavailable");
        let cost: number;
        try {
          cost = costMicros(response.inputTokens, response.outputTokens, provider.price);
        } catch {
          throw new ModelError("provider_unavailable");
        }
        const used: ModelUsage = {
          provider: provider.name,
          model: provider.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costMicros: cost,
        };

        // 7. The answer is checked, and is data until it has been.
        const fault = answerFault(response, request.maxOutputTokens);
        if (fault !== undefined) throw new ModelError(fault, used);
        const json = parseJson(response.text);
        if (!json.ok) throw new ModelError("output_invalid", used);
        const parsed = request.output.safeParse(json.value);
        if (!parsed.success) throw new ModelError("output_invalid", used);

        options.logger?.info("model call", {
          ...loggable(context, request),
          provider: provider.name,
          model: provider.model,
          outcome: "ok",
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costMicros: cost,
          redactions,
          durationMs: now() - started,
        });
        return {
          value: parsed.data,
          provider: provider.name,
          model: provider.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costMicros: cost,
          redactions,
        };
      } catch (error) {
        // Whatever went wrong, the caller gets a ModelError, and the log gets its code and no more.
        const failure =
          error instanceof ModelError ? error : new ModelError("provider_unavailable");
        options.logger?.warn("model call failed", {
          ...loggable(context, request),
          ...(provider === undefined ? {} : { provider: provider.name, model: provider.model }),
          outcome: failure.code,
          ...(failure.usage === undefined
            ? {}
            : {
                inputTokens: failure.usage.inputTokens,
                outputTokens: failure.usage.outputTokens,
                costMicros: failure.usage.costMicros,
              }),
          durationMs: now() - started,
        });
        throw failure;
      }
    },
  };
}
