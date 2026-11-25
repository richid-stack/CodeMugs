export type ModelErrorCode =
  /** The request is not well formed: a label, a size, a schema that is not an object, a secret in the instructions. */
  | "invalid_request"
  /** The organisation's policy does not let a class of data go to a model provider. */
  | "not_permitted"
  /** The policy could not be read, so nothing is sent (it fails closed). */
  | "policy_unavailable"
  /** No configured provider can take a request of this size. */
  | "no_capable_provider"
  /** The provider could not be reached or failed. */
  | "provider_unavailable"
  /** The provider said that it is being asked too often. */
  | "rate_limited"
  /** The provider did not answer in time. */
  | "timeout"
  /** The provider refused the request itself (not a limit, not an outage): sending it again will not help. */
  | "provider_rejected"
  /** The model stopped at the limit of the output, so the answer is cut short. */
  | "output_truncated"
  /** The model declined to answer. */
  | "refused"
  /** The answer is not JSON of the shape that was asked for. */
  | "output_invalid"
  /** The caller gave up. */
  | "aborted"
  /** The organisation's budget for the month, or the task's, has no room for the call. Sending it again will not help until the budget changes. */
  | "budget_exceeded"
  /** The budget could not be read, so nothing is sent (it fails closed). */
  | "budget_unavailable";

const MESSAGES: Readonly<Record<ModelErrorCode, string>> = {
  invalid_request: "the request is not valid",
  not_permitted: "the organisation's policy does not allow this data to be sent to a model",
  policy_unavailable: "the policy for model requests could not be read",
  no_capable_provider: "no provider can take a request of this size",
  provider_unavailable: "the model provider is not available",
  rate_limited: "the model provider is limiting requests",
  timeout: "the model provider did not answer in time",
  provider_rejected: "the model provider rejected the request",
  output_truncated: "the model's answer was cut short",
  refused: "the model declined to answer",
  output_invalid: "the model's answer is not of the shape that was asked for",
  aborted: "the call was given up",
  budget_exceeded: "the budget for model calls has no room for this call",
  budget_unavailable: "the budget for model calls could not be read",
};

/** The failures that are about the provider and not the request, so that another try or another provider may do better. */
const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set([
  "policy_unavailable",
  "budget_unavailable",
  "provider_unavailable",
  "rate_limited",
  "timeout",
]);

/**
 * A failure of a model call, as a short code and a fixed sentence. Nothing that a prompt, an
 * answer, a provider or a customer's data said is ever in it: a provider's error text can echo
 * what it was sent, and an answer can hold anything (repository invariants 3 and 6).
 */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  /**
   * Every attempt that was made at a provider, in order, and how each ended, including the tokens and
   * cost of those that were answered: a call can be billed for an answer that is refused, cut short or
   * not valid, and the spend must not disappear with the failure. Names, codes and numbers only. Empty
   * when no provider was called (the request or the policy was refused, or every provider's breaker is
   * open). An attempt that was given up on has no usage, because it is not known.
   */
  readonly attempts: readonly ModelAttempt[];

  constructor(code: ModelErrorCode, attempts: readonly ModelAttempt[] = []) {
    super(MESSAGES[code]);
    this.name = "ModelError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.attempts = attempts;
  }

  /** What the attempts that were answered cost, as the providers said, in millionths of a US dollar. */
  get costMicros(): number {
    return totalCost(this.attempts);
  }

  /** What was taken from the budget for the attempts: the cost where it is known, and the worst case where a provider may have billed and did not say. */
  get chargedMicros(): number {
    return totalCharged(this.attempts);
  }
}

/** What a call used, as numbers. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** In millionths of a US dollar. */
  readonly costMicros: number;
}

/** One call to one provider, and how it ended. */
export interface ModelAttempt {
  readonly provider: string;
  readonly model: string;
  readonly outcome: "ok" | ModelErrorCode;
  /** Present when the provider answered and said what it used. */
  readonly usage?: ModelUsage;
  /**
   * What was taken from the budget for the attempt, in millionths of a US dollar: the cost where the
   * provider said what it used; the **worst case** where it may have billed and did not say (it was
   * too slow, the caller left, it gave no usable usage, it failed in a way of its own); and 0 where it
   * cannot have (it could not be reached, it limited the requests, it rejected the request).
   */
  readonly chargedMicros: number;
}

export function totalCost(attempts: readonly ModelAttempt[]): number {
  return attempts.reduce((sum, attempt) => sum + (attempt.usage?.costMicros ?? 0), 0);
}

export function totalCharged(attempts: readonly ModelAttempt[]): number {
  return attempts.reduce((sum, attempt) => sum + attempt.chargedMicros, 0);
}

export type ProviderFailureKind = "unavailable" | "rate_limited" | "timeout" | "rejected";

const FAILURE_CODES: Readonly<Record<ProviderFailureKind, ModelErrorCode>> = {
  unavailable: "provider_unavailable",
  rate_limited: "rate_limited",
  timeout: "timeout",
  rejected: "provider_rejected",
};

/**
 * What an adapter throws when its provider fails. It holds a kind and nothing else: an adapter
 * must not put the provider's message in it, which can contain the prompt.
 */
export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind) {
    super(`the provider failed: ${kind}`);
    this.name = "ProviderFailure";
    this.kind = kind;
  }

  get code(): ModelErrorCode {
    return FAILURE_CODES[this.kind];
  }
}
