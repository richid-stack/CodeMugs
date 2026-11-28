import { z } from "zod";
import type { Logger } from "@codemugs/logging";
import { CircuitBreaker, type BreakerState } from "./breaker.js";
import type {
  BudgetClaim,
  BudgetGrant,
  BudgetLedger,
  BudgetReservation,
  BudgetUsageRecord,
} from "./budget.js";
import { costMicros, estimateTokens, isValidPrice } from "./cost.js";
import {
  ModelError,
  ProviderFailure,
  totalCharged,
  totalCost,
  type ModelAttempt,
  type ModelErrorCode,
  type ModelUsage,
} from "./errors.js";
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
  type ProviderRequest,
} from "./types.js";
import type { RenderedPrompt } from "./render.js";

/** The bounds of a request. They are the gateway's and not the caller's, so a caller cannot ask for more. */
export const GATEWAY_LIMITS = {
  maxPromptCharacters: 1_000_000,
  maxInstructionCharacters: 100_000,
  maxDataParts: 200,
  maxOutputTokens: 64_000,
  minTimeoutMs: 1,
  maxTimeoutMs: 600_000,
  defaultTimeoutMs: 120_000,
  maxAttempts: 10,
  defaultAttempts: 3,
  maxFailureThreshold: 100,
  defaultFailureThreshold: 5,
  maxCooldownMs: 3_600_000,
  defaultCooldownMs: 30_000,
} as const;

const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
/** The longest name of a model that a ledger keeps. */
const MAX_MODEL_NAME = 200;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORGANISATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASSES: ReadonlySet<string> = new Set(DATA_CLASSES);

export interface GatewayOptions {
  /** In the order to try them: the first that has room is asked first, and the next only when it fails in a way that is its own. */
  readonly providers: readonly ModelProvider[];
  readonly policy: ModelPolicy;
  /**
   * What may be spent. There is no default, because one that spends without limit is not one to fall back
   * on: a deployment gives a ledger with limits, and a test gives `unlimitedBudget()`.
   */
  readonly budget: BudgetLedger;
  readonly logger?: Logger;
  /** How long each attempt at a provider may take before it is given up, in milliseconds. */
  readonly timeoutMs?: number;
  /** How many providers may be tried for one call. Default 3. With the time limit, this bounds how long a call can take. */
  readonly maxAttempts?: number;
  /** When a provider is taken out of use after failures, and for how long. */
  readonly breaker?: {
    /** Failures in a row that are the provider's before it is not called. Default 5. */
    readonly failureThreshold?: number;
    /** How long it is left alone before one call is let through to see whether it is back, in milliseconds. Default 30,000. */
    readonly cooldownMs?: number;
  };
  /** Random bytes for the boundary of a prompt's data blocks. Only a test changes this. */
  readonly random?: (bytes: number) => Uint8Array;
  readonly now?: () => number;
}

export interface ProviderStatus {
  readonly name: string;
  readonly model: string;
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
}

export interface ModelGateway {
  /**
   * Asks a model and gives back an answer that has been checked against the schema that was asked for,
   * with what it cost. When a provider fails in a way that is its own (it cannot be reached, it limits
   * the requests, it is too slow) the next that has room is asked, up to the limit of attempts. It fails
   * with a `ModelError` and nothing else, whose message holds nothing of the request or the answer.
   */
  call<T>(context: CallContext, request: ModelRequest<T>): Promise<ModelResult<T>>;
  /** Whether each provider is in use, for a health check. */
  providers(): readonly ProviderStatus[];
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

/** What an attempt was, for a ledger that keeps usage: names, a code and counts. */
function usageOf(attempt: ModelAttempt): BudgetUsageRecord {
  return {
    provider: attempt.provider,
    model: attempt.model,
    outcome: attempt.outcome,
    ...(attempt.usage === undefined
      ? {}
      : { inputTokens: attempt.usage.inputTokens, outputTokens: attempt.usage.outputTokens }),
  };
}

function validClasses(classes: readonly DataClass[] | undefined): boolean {
  if (classes === undefined) return true;
  const list: unknown = classes;
  return (
    Array.isArray(list) && list.every((one: unknown) => typeof one === "string" && CLASSES.has(one))
  );
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
      provider.model.length > MAX_MODEL_NAME ||
      !isValidPrice(provider.price) ||
      !Number.isSafeInteger(capabilities.maxContextTokens) ||
      capabilities.maxContextTokens < 1 ||
      !Number.isSafeInteger(capabilities.maxOutputTokens) ||
      capabilities.maxOutputTokens < 1 ||
      !validClasses(capabilities.dataClasses)
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
    (context.taskId === undefined ||
      (typeof context.taskId === "string" && TASK_ID.test(context.taskId))) &&
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
): { task: string; organisationId: string; taskId?: string } {
  return {
    task: typeof request.task === "string" && NAME.test(request.task) ? request.task : "invalid",
    organisationId:
      typeof context.organisationId === "string" && ORGANISATION.test(context.organisationId)
        ? context.organisationId
        : "invalid",
    ...(context.taskId === undefined
      ? {}
      : {
          taskId:
            typeof context.taskId === "string" && TASK_ID.test(context.taskId)
              ? context.taskId
              : "invalid",
        }),
  };
}

function inRange(value: number, low: number, high: number): boolean {
  return Number.isSafeInteger(value) && value >= low && value <= high;
}

interface Prepared {
  readonly prompt: RenderedPrompt;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly redactions: number;
}

type AttemptOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly attempt: ModelAttempt }
  | { readonly ok: false; readonly error: ModelError; readonly attempt: ModelAttempt };

/** Whether an outcome says that the provider is down or slow or limiting, as opposed to anything else. */
const PROVIDER_FAULTS: ReadonlySet<ModelErrorCode> = new Set([
  "provider_unavailable",
  "rate_limited",
  "timeout",
]);

export function createModelGateway(options: GatewayOptions): ModelGateway {
  checkProviders(options.providers);
  const timeoutMs = options.timeoutMs ?? GATEWAY_LIMITS.defaultTimeoutMs;
  const maxAttempts = options.maxAttempts ?? GATEWAY_LIMITS.defaultAttempts;
  const failureThreshold =
    options.breaker?.failureThreshold ?? GATEWAY_LIMITS.defaultFailureThreshold;
  const cooldownMs = options.breaker?.cooldownMs ?? GATEWAY_LIMITS.defaultCooldownMs;
  if (
    !inRange(timeoutMs, GATEWAY_LIMITS.minTimeoutMs, GATEWAY_LIMITS.maxTimeoutMs) ||
    !inRange(maxAttempts, 1, GATEWAY_LIMITS.maxAttempts) ||
    !inRange(failureThreshold, 1, GATEWAY_LIMITS.maxFailureThreshold) ||
    !inRange(cooldownMs, 1, GATEWAY_LIMITS.maxCooldownMs)
  ) {
    throw new RangeError("a limit of the model gateway is out of range");
  }
  const now = options.now ?? Date.now;
  const entries = options.providers.map((provider) => ({
    provider,
    breaker: new CircuitBreaker(failureThreshold, cooldownMs, now),
  }));

  /** One call to one provider, given up on when the time is up or the caller leaves, whatever the adapter does. */
  async function attempt<T>(
    provider: ModelProvider,
    request: ModelRequest<T>,
    prepared: Prepared,
    context: CallContext,
    worstMicros: number,
  ): Promise<AttemptOutcome<T>> {
    // What is taken from the budget (see `ModelAttempt.chargedMicros`): the cost if the provider said, the
    // worst case if it may have billed and did not say, and nothing if it cannot have.
    const failed = (
      code: ModelErrorCode,
      chargedMicros: number,
      usage?: ModelUsage,
    ): AttemptOutcome<T> => ({
      ok: false,
      error: new ModelError(code),
      attempt: {
        provider: provider.name,
        model: provider.model,
        outcome: code,
        chargedMicros,
        ...(usage === undefined ? {} : { usage }),
      },
    });

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal =
      context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
    const providerRequest: ProviderRequest = {
      model: provider.model,
      system: prepared.prompt.system,
      user: prepared.prompt.user,
      jsonSchema: prepared.jsonSchema,
      maxOutputTokens: request.maxOutputTokens,
      signal,
    };
    let response: ProviderResponse;
    try {
      response = await abortable(provider.complete(providerRequest), signal);
    } catch (error) {
      if (context.signal?.aborted) return failed("aborted", worstMicros);
      if (timeout.aborted) return failed("timeout", worstMicros);
      if (error instanceof ProviderFailure) {
        // A provider that says it could not be reached, limited the requests or rejected the request did
        // not bill; one that says that it was too slow may have.
        return failed(error.code, error.kind === "timeout" ? worstMicros : 0);
      }
      return failed("provider_unavailable", worstMicros);
    }

    // What the call used is worked out first, because it is billed whether or not the answer can be
    // used, and a failure from here on carries it.
    if (!hasUsage(response)) return failed("provider_unavailable", worstMicros);
    let cost: number;
    try {
      cost = costMicros(response.inputTokens, response.outputTokens, provider.price);
    } catch {
      return failed("provider_unavailable", worstMicros);
    }
    const used: ModelUsage = {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costMicros: cost,
    };

    // The answer is checked, and is data until it has been.
    const fault = answerFault(response, request.maxOutputTokens);
    if (fault !== undefined) return failed(fault, cost, used);
    const json = parseJson(response.text);
    if (!json.ok) return failed("output_invalid", cost, used);
    // A schema that throws on an answer (a refinement can) is an answer that does not fit, and it was billed.
    let parsed: z.ZodSafeParseResult<T>;
    try {
      parsed = request.output.safeParse(json.value);
    } catch {
      return failed("output_invalid", cost, used);
    }
    if (!parsed.success) return failed("output_invalid", cost, used);
    return {
      ok: true,
      value: parsed.data,
      attempt: {
        provider: provider.name,
        model: provider.model,
        outcome: "ok",
        usage: used,
        chargedMicros: cost,
      },
    };
  }

  /**
   * Tells the ledger what an attempt was charged. Money has been spent by now, so a ledger that fails
   * here does not fail the call: the reservation stays, which counts it as spent at its worst case, and
   * the log says so (a code and an amount, nothing of the request).
   */
  async function settle<T>(
    reservation: BudgetReservation,
    chargedMicros: number,
    record: BudgetUsageRecord | undefined,
    context: CallContext,
    request: ModelRequest<T>,
  ): Promise<void> {
    try {
      // Nothing was charged and nothing was reported: the room is given back and there is no usage to
      // keep. A provider that reported usage is recorded whatever it cost, a price of nothing included.
      if (chargedMicros === 0 && record?.inputTokens === undefined) await reservation.release();
      else await reservation.settle(chargedMicros, record);
    } catch {
      options.logger?.warn("model budget settle failed", {
        ...loggable(context, request),
        chargedMicros,
      });
    }
  }

  return {
    providers: () =>
      entries.map(({ provider, breaker }) => ({
        name: provider.name,
        model: provider.model,
        ...breaker.status(),
      })),

    async call<T>(context: CallContext, request: ModelRequest<T>): Promise<ModelResult<T>> {
      const started = now();
      const attempts: ModelAttempt[] = [];
      // What stopped the call for want of room, for the log: the organisation's budget or the task's.
      let refusedBy: "organisation" | "task" | undefined;
      const totals = (): {
        inputTokens: number;
        outputTokens: number;
        costMicros: number;
        chargedMicros: number;
      } => ({
        inputTokens: attempts.reduce((sum, one) => sum + (one.usage?.inputTokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, one) => sum + (one.usage?.outputTokens ?? 0), 0),
        costMicros: totalCost(attempts),
        chargedMicros: totalCharged(attempts),
      });
      try {
        checkRequest(context, request);
        if (context.signal?.aborted) throw new ModelError("aborted");

        // 1. What may leave the platform. A class that the policy does not name does not.
        // The wait for the policy is given up when the caller leaves, and the caller is looked at again
        // before each provider is called (step 5).
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
        const prepared: Prepared = { prompt, jsonSchema, redactions };

        // 4. The providers that have room for it, in the order given.
        const inputEstimate =
          estimateTokens(prompt.system) +
          estimateTokens(prompt.user) +
          estimateTokens(JSON.stringify(jsonSchema));
        const needed = inputEstimate + request.maxOutputTokens;
        // A provider that may not be sent a class that the request holds is not a candidate, for
        // this call or for a failover: the organisation's policy and the provider's terms must both allow it.
        const classes = new Set(request.data.map((part) => part.dataClass));
        const allowed = entries.filter(({ provider: { capabilities } }) => {
          const { dataClasses } = capabilities;
          return (
            dataClasses === undefined || [...classes].every((one) => dataClasses.includes(one))
          );
        });
        if (allowed.length === 0) throw new ModelError("no_permitted_provider");
        const candidates = allowed.filter(
          ({ provider: { capabilities } }) =>
            needed <= capabilities.maxContextTokens &&
            request.maxOutputTokens <= capabilities.maxOutputTokens,
        );
        if (candidates.length === 0) throw new ModelError("no_capable_provider");

        // 5. The first that is in use and answers. Another is tried only for a failure that is the
        // provider's own, and not for an answer that was given and is no good (which was paid for, and
        // is the caller's to decide about).
        let last: ModelErrorCode = "provider_unavailable";
        for (const { provider, breaker } of candidates) {
          if (attempts.length >= maxAttempts) break;
          // Nothing is sent for a caller who has gone, however long the steps before took.
          if (context.signal?.aborted) throw new ModelError("aborted", [...attempts]);
          if (!breaker.tryAcquire()) continue;

          // 6. Room in the budget for the worst that this attempt can cost: the input as guessed (which
          // errs towards too big) and all the output that is allowed. Nothing is sent without it. A ledger
          // that cannot be read sends nothing either, and a reservation that is granted after the caller
          // has left is given back.
          let worst: number;
          try {
            worst = costMicros(inputEstimate, request.maxOutputTokens, provider.price);
          } catch {
            breaker.release();
            throw new ModelError("budget_exceeded", [...attempts]);
          }
          const claim: BudgetClaim = {
            organisationId: context.organisationId,
            ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
            micros: worst,
          };
          let pending: Promise<BudgetGrant> | undefined;
          let grant: BudgetGrant;
          try {
            pending = options.budget.reserve(claim);
            grant =
              context.signal === undefined
                ? await pending
                : await abortable(pending, context.signal);
          } catch {
            breaker.release();
            if (pending !== undefined) {
              void pending
                .then((late) => (late.ok ? late.reservation.release() : undefined))
                .catch(() => undefined);
            }
            throw new ModelError(context.signal?.aborted ? "aborted" : "budget_unavailable", [
              ...attempts,
            ]);
          }
          if (!grant.ok) {
            breaker.release();
            refusedBy = grant.limit;
            throw new ModelError("budget_exceeded", [...attempts]);
          }
          // The caller may have left in the moment between the grant and here. The attempt looks at the
          // signal only after it has called the provider, so this is the last place where nothing is sent.
          if (context.signal?.aborted) {
            breaker.release();
            await settle(grant.reservation, 0, undefined, context, request);
            throw new ModelError("aborted", [...attempts]);
          }

          const outcome = await attempt(provider, request, prepared, context, worst);
          attempts.push(outcome.attempt);
          await settle(
            grant.reservation,
            outcome.attempt.chargedMicros,
            usageOf(outcome.attempt),
            context,
            request,
          );
          const code = outcome.ok ? "ok" : outcome.error.code;
          if (code === "aborted") breaker.release();
          else if (PROVIDER_FAULTS.has(code as ModelErrorCode)) breaker.failure();
          else breaker.success();

          if (outcome.ok) {
            const spent = totals();
            options.logger?.info("model call", {
              ...loggable(context, request),
              provider: provider.name,
              model: provider.model,
              outcome: "ok",
              attempts: attempts.length,
              ...spent,
              redactions,
              durationMs: now() - started,
            });
            return {
              value: outcome.value,
              provider: provider.name,
              model: provider.model,
              inputTokens: outcome.attempt.usage?.inputTokens ?? 0,
              outputTokens: outcome.attempt.usage?.outputTokens ?? 0,
              costMicros: spent.costMicros,
              chargedMicros: spent.chargedMicros,
              attempts: [...attempts],
              redactions,
            };
          }
          last = outcome.error.code;
          if (!outcome.error.retryable) throw new ModelError(last, [...attempts]);
          options.logger?.warn("model attempt failed", {
            ...loggable(context, request),
            provider: provider.name,
            model: provider.model,
            outcome: last,
            attempt: attempts.length,
            durationMs: now() - started,
          });
        }
        // Every provider that had room failed in a way that is its own, or none is in use.
        throw new ModelError(last, [...attempts]);
      } catch (error) {
        // Whatever went wrong, the caller gets a ModelError, and the log gets its code and no more.
        const failure =
          error instanceof ModelError
            ? error
            : new ModelError("provider_unavailable", [...attempts]);
        const lastAttempt = failure.attempts[failure.attempts.length - 1];
        options.logger?.warn("model call failed", {
          ...loggable(context, request),
          ...(lastAttempt === undefined
            ? {}
            : { provider: lastAttempt.provider, model: lastAttempt.model }),
          outcome: failure.code,
          ...(refusedBy === undefined ? {} : { limit: refusedBy }),
          attempts: failure.attempts.length,
          ...(failure.attempts.length === 0 ? {} : { chargedMicros: failure.chargedMicros }),
          ...(failure.attempts.some((one) => one.usage !== undefined)
            ? {
                inputTokens: failure.attempts.reduce(
                  (sum, one) => sum + (one.usage?.inputTokens ?? 0),
                  0,
                ),
                outputTokens: failure.attempts.reduce(
                  (sum, one) => sum + (one.usage?.outputTokens ?? 0),
                  0,
                ),
                costMicros: failure.costMicros,
              }
            : {}),
          durationMs: now() - started,
        });
        throw failure;
      }
    },
  };
}
