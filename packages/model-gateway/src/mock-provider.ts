import { ProviderFailure, type ProviderFailureKind } from "./errors.js";
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderPrice,
  ProviderRequest,
  ProviderResponse,
} from "./types.js";

/** One answer of the mock, in the order that they are given. */
export type MockStep =
  /** Answers with this value as JSON. */
  | { readonly value: unknown; readonly finish?: ProviderResponse["finish"] }
  /** Answers with this text as it is, which is how a test gives an answer that is not JSON. */
  | {
      readonly text: string;
      readonly finish?: ProviderResponse["finish"];
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  /** Fails the way a provider fails. */
  | { readonly fail: ProviderFailureKind }
  /** Never answers, until the call is given up: a provider that is too slow. */
  | { readonly hang: true }
  /** Fails with an error that is not a `ProviderFailure`, as an adapter with a bug would. */
  | { readonly crash: true };

export interface MockProviderOptions {
  readonly name?: string;
  readonly model?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly price?: Partial<ProviderPrice>;
  /** What the calls do, one step for each call. The last step is repeated when the steps run out. Default: answers `{}`. */
  readonly steps?: readonly MockStep[];
}

export interface MockProvider extends ModelProvider {
  /** What it was asked, for a test to look at. It holds prompts, so it is for tests only. */
  readonly calls: readonly ProviderRequest[];
}

/**
 * A provider that is a script, for tests of the gateway and of whatever uses it, with failures and
 * slowness that a test can choose. It has made-up prices and no connection to anything.
 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const steps: readonly MockStep[] = options.steps?.length ? options.steps : [{ value: {} }];
  const calls: ProviderRequest[] = [];
  return {
    name: options.name ?? "mock",
    model: options.model ?? "mock-model",
    capabilities: {
      maxContextTokens: 100_000,
      maxOutputTokens: 8_000,
      structuredOutput: "prompted",
      ...options.capabilities,
    },
    price: {
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 5_000_000,
      ...options.price,
    },
    calls,
    complete(request) {
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push(request);
      const inputTokens = Math.ceil((request.system.length + request.user.length) / 4);
      if (step === undefined) return Promise.reject(new ProviderFailure("unavailable"));
      if ("fail" in step) return Promise.reject(new ProviderFailure(step.fail));
      if ("crash" in step) return Promise.reject(new Error("the mock crashed"));
      if ("hang" in step) {
        return new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("the mock was given up on"));
          });
        });
      }
      if ("text" in step) {
        return Promise.resolve({
          text: step.text,
          finish: step.finish ?? "stop",
          inputTokens: step.inputTokens ?? inputTokens,
          outputTokens: step.outputTokens ?? Math.ceil(step.text.length / 4),
        });
      }
      const text = JSON.stringify(step.value);
      return Promise.resolve({
        text,
        finish: step.finish ?? "stop",
        inputTokens,
        outputTokens: Math.ceil(text.length / 4),
      });
    },
  };
}
