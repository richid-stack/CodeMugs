import { z } from "zod";
import type { Logger } from "@codemugs/logging";
import { costMicros, estimateTokens, isValidPrice } from "./cost.js";
import { ModelError, ProviderFailure } from "./errors.js";
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
function parseJson(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fenced?.[1] !== undefined) body = fenced[1];
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ModelError("output_invalid");
  }
}

function checkResponse(response: ProviderResponse, maxOutputTokens: number): void {
  const counted =
    Number.isSafeInteger(response.inputTokens) &&
    response.inputTokens >= 0 &&
    Number.isSafeInteger(response.outputTokens) &&
    response.outputTokens >= 0;
  // A provider that does not say what it used cannot be accounted, which is a fault of the adapter.
  if (!counted || typeof response.text !== "string") throw new ModelError("provider_unavailable");
  if (response.finish === "refused") throw new ModelError("refused");
  if (response.finish === "length") throw new ModelError("output_truncated");
  if (response.text.length > maxOutputTokens * 16) throw new ModelError("output_invalid");
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
        let permitted: ReadonlySet<DataClass>;
        try {
          permitted = await options.policy.permittedClasses(context.organisationId);
        } catch {
          throw new ModelError("policy_unavailable");
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
          estimateTokens(
            prompt.system.length + prompt.user.length + JSON.stringify(jsonSchema).length,
          ) + request.maxOutputTokens;
        provider = options.providers.find(
          ({ capabilities }) =>
            needed <= capabilities.maxContextTokens &&
            request.maxOutputTokens <= capabilities.maxOutputTokens,
        );
        if (provider === undefined) throw new ModelError("no_capable_provider");

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

        // 6. The answer is checked, and is data until it has been.
        checkResponse(response, request.maxOutputTokens);
        const parsed = request.output.safeParse(parseJson(response.text));
        if (!parsed.success) throw new ModelError("output_invalid");

        const cost = costMicros(response.inputTokens, response.outputTokens, provider.price);
        options.logger?.info("model call", {
          task: request.task,
          organisationId: context.organisationId,
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
          task: request.task,
          organisationId: context.organisationId,
          ...(provider === undefined ? {} : { provider: provider.name, model: provider.model }),
          outcome: failure.code,
          durationMs: now() - started,
        });
        throw failure;
      }
    },
  };
}
