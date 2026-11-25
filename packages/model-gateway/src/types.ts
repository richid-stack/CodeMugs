import type { z } from "zod";
import type { ModelAttempt } from "./errors.js";

/**
 * What a piece of data is, in the terms of the data classification
 * ([the draft](../../../docs/security/data-classification.md)). Secrets are not a class: they are
 * never sent, and the redaction is a second line behind the rule that none is put in a request.
 * Audit records are not one either, because they are never sent.
 */
export const DATA_CLASSES = [
  "source_code",
  "repository_facts",
  "telemetry",
  "personal",
  "customer_communications",
  "platform_metadata",
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** A piece of data that is put in a request. It is **untrusted**: it is shown to the model as material and never as instructions. */
export interface DataPart {
  /** What it is called in the request, written by the platform: `[a-z0-9._-]`, 1 to 64 characters. */
  readonly label: string;
  readonly dataClass: DataClass;
  readonly content: string;
}

export interface ModelRequest<T> {
  /** The kind of task, for the accounting and the log: `[a-z][a-z0-9._-]`, up to 64 characters. */
  readonly task: string;
  /** What the model is asked to do, **written by the platform**. Nothing from a customer goes here: it goes in `data`. */
  readonly instructions: string;
  readonly data: readonly DataPart[];
  /** The shape of the answer. It must be an object. */
  readonly output: z.ZodType<T>;
  readonly maxOutputTokens: number;
}

/** Who the call is for and whether the caller is still waiting. The organisation comes from the caller's authority, never from a request body (invariant 1). */
export interface CallContext {
  readonly organisationId: string;
  /**
   * The task that the call is part of, as an opaque id: `[A-Za-z0-9_-]`, 1 to 64 characters. A task has
   * a budget of its own, which is not looked at for a call that has none.
   */
  readonly taskId?: string;
  readonly signal?: AbortSignal;
}

export interface ModelResult<T> {
  readonly value: T;
  /** The provider that answered. */
  readonly provider: string;
  readonly model: string;
  /** The tokens of the answering attempt. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The cost of the whole call in millionths of a US dollar, from the providers' prices: the answer's, and that of any attempt that was billed before it and failed. */
  readonly costMicros: number;
  /** What was taken from the budget for the call: the cost, and the worst case for any attempt that may have been billed and did not say. At least `costMicros`. */
  readonly chargedMicros: number;
  /** Every attempt at a provider that was made, in order, ending with the one that answered. */
  readonly attempts: readonly ModelAttempt[];
  /** How many secret-like strings were removed from the data before it was sent. */
  readonly redactions: number;
}

export interface ProviderCapabilities {
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /** Whether the provider is given the schema to constrain its answer (`native`) or only told of it in the prompt (`prompted`). The gateway validates the answer either way. */
  readonly structuredOutput: "native" | "prompted";
}

/** Whole millionths of a US dollar for a million tokens. Integers, so that no cost is a fraction of a float. */
export interface ProviderPrice {
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

export interface ProviderRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface ProviderResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly finish: "stop" | "length" | "refused";
}

/**
 * A model provider, behind the gateway. An adapter turns this into one provider's API, reads
 * the usage from its answer, and throws `ProviderFailure` (a kind and nothing else) when it fails.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  readonly price: ProviderPrice;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
