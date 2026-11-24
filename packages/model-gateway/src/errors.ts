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
  | "aborted";

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
};

/** The failures that are about the provider and not the request, so that another try or another provider may do better. */
const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set([
  "policy_unavailable",
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

  constructor(code: ModelErrorCode) {
    super(MESSAGES[code]);
    this.name = "ModelError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
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
