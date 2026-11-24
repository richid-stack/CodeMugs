import { describe, expect, it } from "vitest";
import { ProviderFailure } from "./errors.js";
import { createMockProvider } from "./mock-provider.js";
import type { ProviderRequest } from "./types.js";

function request(signal: AbortSignal = new AbortController().signal): ProviderRequest {
  return {
    model: "mock-model",
    system: "abcd",
    user: "efgh",
    jsonSchema: { type: "object" },
    maxOutputTokens: 100,
    signal,
  };
}

describe("the mock provider", () => {
  it("answers {} when it is not told what to do, and records what it was asked", async () => {
    const mock = createMockProvider();
    const answer = await mock.complete(request());
    expect(answer).toEqual({ text: "{}", finish: "stop", inputTokens: 2, outputTokens: 1 });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.system).toBe("abcd");
  });

  it("follows its steps in order, and repeats the last one", async () => {
    const mock = createMockProvider({
      steps: [{ fail: "unavailable" }, { value: { n: 1 } }, { value: { n: 2 } }],
    });
    await expect(mock.complete(request())).rejects.toMatchObject({ kind: "unavailable" });
    expect((await mock.complete(request())).text).toBe('{"n":1}');
    expect((await mock.complete(request())).text).toBe('{"n":2}');
    expect((await mock.complete(request())).text).toBe('{"n":2}');
  });

  it("fails as a provider does, with each kind", async () => {
    for (const kind of ["unavailable", "rate_limited", "timeout", "rejected"] as const) {
      const error = await createMockProvider({ steps: [{ fail: kind }] })
        .complete(request())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).kind).toBe(kind);
    }
  });

  it("can give text as it is, with its own finish and usage", async () => {
    const answer = await createMockProvider({
      steps: [{ text: "not json", finish: "length", inputTokens: 7, outputTokens: 9 }],
    }).complete(request());
    expect(answer).toEqual({ text: "not json", finish: "length", inputTokens: 7, outputTokens: 9 });
  });

  it("can crash with an error that is not a provider's", async () => {
    const error = await createMockProvider({ steps: [{ crash: true }] })
      .complete(request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderFailure);
  });

  it("hangs until it is given up on", async () => {
    const controller = new AbortController();
    const pending = createMockProvider({ steps: [{ hang: true }] }).complete(
      request(controller.signal),
    );
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("has a name, a model, capabilities and a price that a test can change", () => {
    const mock = createMockProvider({
      name: "other",
      model: "m2",
      capabilities: { maxContextTokens: 10 },
      price: { inputMicrosPerMillionTokens: 1 },
    });
    expect(mock.name).toBe("other");
    expect(mock.model).toBe("m2");
    expect(mock.capabilities.maxContextTokens).toBe(10);
    expect(mock.capabilities.maxOutputTokens).toBe(8_000);
    expect(mock.price).toEqual({
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 5_000_000,
    });
  });
});
