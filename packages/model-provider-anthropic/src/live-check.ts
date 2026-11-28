import { Secret } from "@codemugs/configuration";
import {
  createMemoryBudget,
  createModelGateway,
  ModelError,
  permitClasses,
  ProviderFailure,
  type ProviderPrice,
} from "@codemugs/model-gateway";
import { z } from "zod";
import { createAnthropicProvider } from "./anthropic-provider.js";

/**
 * A check, run by hand, against the real API: does the provider accept what the adapter sends, and
 * does what it answers have the shape that the adapter reads? Everything the adapter was tested for
 * was tested against a stand-in written from the documentation, which can be wrong in the same way
 * as the adapter. This is the only thing that can show it.
 *
 * It sends **synthetic text only**, a few hundred tokens in all, under a cap of its own. It prints
 * yes or no for each step and the short codes of a failure, **never the key**. When the provider
 * refuses a request it also prints what the provider said about it, with the key taken out: that is
 * safe here because the text sent is this file's, and it is how a mistake in a request is found.
 * Nothing in the platform calls it, and it must not be run on a pull request.
 */

export interface LiveCheckOptions {
  readonly apiKey: Secret;
  readonly model: string;
  /** Upper bounds are fine here: they set what a step is reserved for under the cap, and nothing else. */
  readonly price: ProviderPrice;
  /** Where the API is. Only a test changes this. */
  readonly baseUrl?: string;
  /** What the whole check may spend, in millionths of a US dollar. Default 200,000 (20 cents). */
  readonly capMicros?: number;
  readonly out: (line: string) => void;
}

export interface LiveCheckResult {
  readonly passed: boolean;
  readonly steps: readonly { readonly name: string; readonly ok: boolean }[];
  readonly spentMicros: number;
}

const ORGANISATION = "00000000-0000-4000-8000-000000000001";
// Made of pieces, so that no scanner takes it for a key; it is not one.
const NOT_A_KEY = ["not", "a", "real", "key", "for", "the", "live", "check", "0123456789"].join(
  "-",
);

const WORD = z.object({ word: z.string().min(1), count: z.number() });
const CONSTRAINED = z.object({
  title: z.string().min(1).max(40),
  score: z.number().int().min(0).max(10),
  tags: z
    .array(z.enum(["a", "b", "c"]))
    .min(1)
    .max(3),
});
const RECORD = z.object({ labels: z.record(z.string(), z.string()) });

function describeFailure(error: unknown): string {
  if (error instanceof ModelError) {
    const outcomes = error.attempts.map((attempt) => attempt.outcome).join(",");
    return `${error.code}${outcomes === "" ? "" : ` (attempts: ${outcomes})`}`;
  }
  if (error instanceof ProviderFailure) return error.kind;
  return "an error that is not one of ours";
}

export async function runLiveCheck(options: LiveCheckOptions): Promise<LiveCheckResult> {
  const { out } = options;
  const key = options.apiKey.reveal();
  const cap = options.capMicros ?? 200_000;
  let requests = 0;

  /** The real fetch, which counts its requests and says what the provider said about a refusal. */
  const watched: typeof globalThis.fetch = async (input, init) => {
    requests += 1;
    const response = await globalThis.fetch(input, init);
    if (response.status >= 400) {
      try {
        const text = (await response.clone().text()).slice(0, 600).split(key).join("[key]");
        out(`      the provider answered ${String(response.status)}: ${text}`);
      } catch {
        // What it said is a help, not a need.
      }
    }
    return response;
  };

  const make = (apiKey: Secret) =>
    createAnthropicProvider({
      apiKey,
      model: options.model,
      price: options.price,
      maxContextTokens: 200_000,
      maxOutputTokens: 1_000,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      fetch: watched,
    });

  const budget = createMemoryBudget({
    limits: () => ({ organisationMonthlyMicros: cap }),
  });
  const gateway = createModelGateway({
    providers: [make(options.apiKey)],
    policy: permitClasses([]),
    budget,
    maxAttempts: 1,
    timeoutMs: 60_000,
  });

  const steps: { name: string; ok: boolean }[] = [];
  const step = async (name: string, work: () => Promise<string>): Promise<void> => {
    let ok = false;
    let detail: string;
    try {
      detail = await work();
      ok = true;
    } catch (error) {
      detail =
        error instanceof Error && error.name === "CheckFailed"
          ? error.message
          : describeFailure(error);
    }
    steps.push({ name, ok });
    out(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` (${detail})`}`);
  };
  const expectThat = (condition: boolean, what: string): void => {
    if (!condition) {
      const error = new Error(what);
      error.name = "CheckFailed";
      throw error;
    }
  };
  const ask = <T>(output: z.ZodType<T>, instructions: string, maxOutputTokens: number) =>
    gateway.call(
      { organisationId: ORGANISATION, taskId: "live-check" },
      { task: "live-check", instructions, data: [], output, maxOutputTokens },
    );

  out(`Live check of the model provider, model ${options.model}. Synthetic text only.`);

  await step("a key that is not valid is turned away, and nothing is billed", async () => {
    try {
      await make(new Secret(NOT_A_KEY)).complete({
        model: options.model,
        system: "Reply with JSON.",
        user: "hello",
        jsonSchema: z.toJSONSchema(WORD),
        maxOutputTokens: 20,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      expectThat(
        error instanceof ProviderFailure && error.kind === "rejected",
        `expected a refusal, got ${describeFailure(error)}`,
      );
      return "rejected";
    }
    expectThat(false, "the provider answered a request with a key that is not valid");
    return "";
  });

  await step("a call through the gateway gets an answer that fits its schema", async () => {
    // That the answer fits the schema is what the gateway checks: an answer that does not fit is an error here.
    const result = await ask(WORD, 'Reply with the word "ready" and the count 1.', 100);
    return `${String(result.inputTokens)} tokens in, ${String(result.outputTokens)} out, ${String(result.costMicros)} micros`;
  });

  await step("a schema with constraints and a list is accepted, and the answer fits", async () => {
    const result = await ask(
      CONSTRAINED,
      'Give a title for the colour blue, the score 7, and the tags ["a"].',
      200,
    );
    return `${String(result.inputTokens)} tokens in, ${String(result.outputTokens)} out`;
  });

  await step("an answer that is cut short is reported as cut short", async () => {
    try {
      await ask(
        z.object({ story: z.string() }),
        "Write a story of two hundred words about a lighthouse, in the story field.",
        5,
      );
    } catch (error) {
      expectThat(
        error instanceof ModelError && error.code === "output_truncated",
        `expected output_truncated, got ${describeFailure(error)}`,
      );
      return "output_truncated";
    }
    expectThat(false, "an answer of five tokens was not cut short");
    return "";
  });

  await step(
    "a schema that cannot be sent as it means is refused before anything is sent",
    async () => {
      const before = requests;
      try {
        await ask(RECORD, "Reply with labels.", 50);
      } catch (error) {
        expectThat(requests === before, "a request was sent for a schema that was refused");
        expectThat(
          error instanceof ModelError && error.code === "provider_rejected",
          `expected provider_rejected, got ${describeFailure(error)}`,
        );
        return "provider_rejected, nothing sent";
      }
      expectThat(false, "a schema that cannot be sent was sent");
      return "";
    },
  );

  const spentMicros = budget.usedMicros(ORGANISATION);
  const passed = steps.every((step_) => step_.ok);
  out(
    `${passed ? "All" : "Not all"} ${String(steps.length)} steps passed. Spent about ${String(spentMicros)} millionths of a dollar, of a cap of ${String(cap)}.`,
  );
  return { passed, steps, spentMicros };
}
