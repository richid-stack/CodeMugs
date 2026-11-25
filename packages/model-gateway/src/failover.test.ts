import { createLogger } from "@codemugs/logging";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelError, type ModelErrorCode, ProviderFailure } from "./errors.js";
import { createModelGateway, GATEWAY_LIMITS, type GatewayOptions } from "./gateway.js";
import { createMockProvider, type MockProvider, type MockStep } from "./mock-provider.js";
import { permitClasses } from "./policy.js";
import type { DataClass, ModelProvider, ModelRequest } from "./types.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const shape = z.object({ summary: z.string(), confidence: z.number() });
type Answer = z.infer<typeof shape>;
const GOOD: Answer = { summary: "the cache key ignores the tenant", confidence: 0.8 };
const ALL: readonly DataClass[] = [
  "source_code",
  "repository_facts",
  "telemetry",
  "personal",
  "customer_communications",
  "platform_metadata",
];

function request(overrides: Partial<ModelRequest<Answer>> = {}): ModelRequest<Answer> {
  return {
    task: "diagnose",
    instructions: "Say what is wrong.",
    data: [],
    output: shape,
    maxOutputTokens: 500,
    ...overrides,
  };
}

function provider(
  name: string,
  steps: readonly MockStep[],
  extra: Partial<Parameters<typeof createMockProvider>[0]> = {},
): MockProvider {
  return createMockProvider({ name, model: `${name}-model`, steps, ...extra });
}

function gateway(providers: readonly ModelProvider[], options: Partial<GatewayOptions> = {}) {
  return createModelGateway({ providers, policy: permitClasses(ALL), ...options });
}

async function failureOf(work: Promise<unknown>): Promise<ModelError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

describe("failing over to another provider", () => {
  const faults: Array<[string, MockStep, ModelErrorCode]> = [
    ["cannot be reached", { fail: "unavailable" }, "provider_unavailable"],
    ["limits the requests", { fail: "rate_limited" }, "rate_limited"],
    ["says that it timed out", { fail: "timeout" }, "timeout"],
    ["fails with an error of its own", { crash: true }, "provider_unavailable"],
  ];

  it.each(faults)("asks the next provider when the first %s", async (_name, step, code) => {
    const first = provider("a", [step]);
    const second = provider("b", [{ value: GOOD }]);
    const result = await gateway([first, second]).call({ organisationId: ORG }, request());
    expect(result.value).toEqual(GOOD);
    expect(result.provider).toBe("b");
    expect(result.attempts.map((one) => [one.provider, one.outcome])).toEqual([
      ["a", code],
      ["b", "ok"],
    ]);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  it("asks the next provider when the first is too slow, within the time that each attempt is given", async () => {
    const slow = provider("a", [{ hang: true }]);
    const fast = provider("b", [{ value: GOOD }]);
    const started = performance.now();
    const result = await gateway([slow, fast], { timeoutMs: 30 }).call(
      { organisationId: ORG },
      request(),
    );
    expect(result.provider).toBe("b");
    expect(result.attempts[0]?.outcome).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("gives the first provider's answer and does not ask the second when the first answers", async () => {
    const first = provider("a", [{ value: GOOD }]);
    const second = provider("b", [{ value: GOOD }]);
    const result = await gateway([first, second]).call({ organisationId: ORG }, request());
    expect(result.provider).toBe("a");
    expect(result.attempts).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  const answered: Array<[string, MockStep, ModelErrorCode]> = [
    ["rejects the request", { fail: "rejected" }, "provider_rejected"],
    ["declines", { value: GOOD, finish: "refused" }, "refused"],
    ["is cut short", { value: GOOD, finish: "length" }, "output_truncated"],
    ["gives text that is not JSON", { text: "not json" }, "output_invalid"],
    ["gives the wrong shape", { value: { summary: 1 } }, "output_invalid"],
  ];

  it.each(answered)(
    "does not ask the next provider when the first %s: that is not an outage, and it was paid for",
    async (_name, step, code) => {
      const first = provider("a", [step]);
      const second = provider("b", [{ value: GOOD }]);
      const error = await failureOf(
        gateway([first, second]).call({ organisationId: ORG }, request()),
      );
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(code === "provider_rejected" ? false : false);
      expect(error.attempts).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
    },
  );

  it("does not ask the same provider again, however many attempts are allowed", async () => {
    const only = provider("a", [{ fail: "unavailable" }, { value: GOOD }]);
    const error = await failureOf(
      gateway([only], { maxAttempts: 5 }).call({ organisationId: ORG }, request()),
    );
    expect(error.code).toBe("provider_unavailable");
    expect(error.attempts).toHaveLength(1);
    expect(only.calls).toHaveLength(1);
  });

  it("skips a provider that has no room for the request, without an attempt", async () => {
    const small = provider("a", [{ value: GOOD }], { capabilities: { maxContextTokens: 100 } });
    const large = provider("b", [{ value: GOOD }]);
    const result = await gateway([small, large]).call({ organisationId: ORG }, request());
    expect(result.attempts.map((one) => one.provider)).toEqual(["b"]);
    expect(small.calls).toHaveLength(0);
  });

  it("fails with the code of the last provider, and every attempt, when all of them fail", async () => {
    const first = provider("a", [{ fail: "unavailable" }]);
    const second = provider("b", [{ fail: "rate_limited" }]);
    const error = await failureOf(
      gateway([first, second]).call({ organisationId: ORG }, request()),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.attempts.map((one) => [one.provider, one.outcome])).toEqual([
      ["a", "provider_unavailable"],
      ["b", "rate_limited"],
    ]);
  });

  it("stops at the limit of attempts, which is three unless it is set", async () => {
    const four = ["a", "b", "c", "d"].map((name) => provider(name, [{ fail: "unavailable" }]));
    const error = await failureOf(gateway(four).call({ organisationId: ORG }, request()));
    expect(error.attempts.map((one) => one.provider)).toEqual(["a", "b", "c"]);
    expect(four[3]?.calls).toHaveLength(0);

    const two = ["a", "b", "c"].map((name) => provider(name, [{ fail: "unavailable" }]));
    const limited = await failureOf(
      gateway(two, { maxAttempts: 2 }).call({ organisationId: ORG }, request()),
    );
    expect(limited.attempts).toHaveLength(2);
    expect(two[2]?.calls).toHaveLength(0);
  });
});

describe("what a failed attempt cost", () => {
  it("is in the cost of the call and in its attempts when a provider that was paid fails and the next answers", async () => {
    // The first gives more output than was allowed: that is a fault of the provider, and it was billed.
    const first = provider("a", [
      { text: JSON.stringify(GOOD), inputTokens: 1_000, outputTokens: 501 },
    ]);
    const second = provider("b", [
      { text: JSON.stringify(GOOD), inputTokens: 2_000, outputTokens: 100 },
    ]);
    const result = await gateway([first, second]).call({ organisationId: ORG }, request());
    // The mock's price: a dollar a million tokens in and five a million out.
    const billedFirst = 1_000 + 2_505;
    const billedSecond = 2_000 + 500;
    expect(result.attempts.map((one) => one.usage?.costMicros)).toEqual([
      billedFirst,
      billedSecond,
    ]);
    expect(result.costMicros).toBe(billedFirst + billedSecond);
    // The tokens are those of the attempt that answered.
    expect(result.inputTokens).toBe(2_000);
    expect(result.outputTokens).toBe(100);
  });

  it("is in the error when every attempt fails, and an attempt that was not answered adds nothing", async () => {
    const first = provider("a", [{ text: "x", inputTokens: 1_000, outputTokens: 501 }]);
    const second = provider("b", [{ fail: "unavailable" }]);
    const error = await failureOf(
      gateway([first, second]).call({ organisationId: ORG }, request()),
    );
    expect(error.attempts.map((one) => one.usage?.costMicros)).toEqual([3_505, undefined]);
    expect(error.costMicros).toBe(3_505);
  });
});

describe("a caller who leaves while providers are being tried", () => {
  it("stops the attempt that is out, and asks no other", async () => {
    const first = provider("a", [{ hang: true }]);
    const second = provider("b", [{ value: GOOD }]);
    const controller = new AbortController();
    const pending = failureOf(
      gateway([first, second]).call({ organisationId: ORG, signal: controller.signal }, request()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe("aborted");
    expect(error.attempts.map((one) => one.outcome)).toEqual(["aborted"]);
    expect(second.calls).toHaveLength(0);
  });

  it("asks no other provider when the caller leaves as the first one fails", async () => {
    const controller = new AbortController();
    const leaving: ModelProvider = {
      ...createMockProvider({ name: "a" }),
      name: "a",
      complete: () => {
        controller.abort();
        return Promise.reject(new ProviderFailure("unavailable"));
      },
    };
    const second = provider("b", [{ value: GOOD }]);
    const error = await failureOf(
      gateway([leaving, second]).call(
        { organisationId: ORG, signal: controller.signal },
        request(),
      ),
    );
    expect(error.code).toBe("aborted");
    expect(second.calls).toHaveLength(0);
  });
});

describe("taking a provider out of use after failures", () => {
  function clocked(providers: readonly ModelProvider[], extra: Partial<GatewayOptions> = {}) {
    const clock = { now: 1_000_000 };
    return {
      clock,
      gateway: gateway(providers, {
        now: () => clock.now,
        breaker: { failureThreshold: 2, cooldownMs: 1_000 },
        ...extra,
      }),
    };
  }

  it("stops calling a provider that has failed enough times in a row, and says so", async () => {
    const down = provider("a", [{ fail: "unavailable" }]);
    const up = provider("b", [{ value: GOOD }]);
    const { gateway: g } = clocked([down, up]);
    expect(g.providers()).toEqual([
      { name: "a", model: "a-model", state: "closed", consecutiveFailures: 0 },
      { name: "b", model: "b-model", state: "closed", consecutiveFailures: 0 },
    ]);
    await g.call({ organisationId: ORG }, request());
    await g.call({ organisationId: ORG }, request());
    expect(down.calls).toHaveLength(2);
    expect(g.providers()[0]).toMatchObject({ name: "a", state: "open", consecutiveFailures: 2 });

    const third = await g.call({ organisationId: ORG }, request());
    expect(down.calls).toHaveLength(2);
    expect(third.attempts.map((one) => one.provider)).toEqual(["b"]);
  });

  it("tries it once after the cooldown, and uses it again when it is back", async () => {
    const flaky = provider("a", [
      { fail: "unavailable" },
      { fail: "unavailable" },
      { value: GOOD },
    ]);
    const steady = provider("b", [{ value: GOOD }]);
    const { gateway: g, clock } = clocked([flaky, steady]);
    await g.call({ organisationId: ORG }, request());
    await g.call({ organisationId: ORG }, request());
    clock.now += 1_000;
    const probed = await g.call({ organisationId: ORG }, request());
    expect(probed.provider).toBe("a");
    expect(flaky.calls).toHaveLength(3);
    expect(g.providers()[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect((await g.call({ organisationId: ORG }, request())).provider).toBe("a");
  });

  it("leaves it alone for another cooldown when the probe fails", async () => {
    const down = provider("a", [{ fail: "unavailable" }]);
    const up = provider("b", [{ value: GOOD }]);
    const { gateway: g, clock } = clocked([down, up]);
    await g.call({ organisationId: ORG }, request());
    await g.call({ organisationId: ORG }, request());
    clock.now += 1_000;
    const probed = await g.call({ organisationId: ORG }, request());
    expect(probed.attempts.map((one) => one.provider)).toEqual(["a", "b"]);
    expect(down.calls).toHaveLength(3);
    await g.call({ organisationId: ORG }, request());
    expect(down.calls).toHaveLength(3);
    clock.now += 1_000;
    await g.call({ organisationId: ORG }, request());
    expect(down.calls).toHaveLength(4);
  });

  it("sends only one call to a provider that is being tried, and the rest to the others", async () => {
    const flaky = provider("a", [
      { fail: "unavailable" },
      { fail: "unavailable" },
      { hang: true },
      { value: GOOD },
    ]);
    const steady = provider("b", [{ value: GOOD }]);
    const { gateway: g, clock } = clocked([flaky, steady]);
    await g.call({ organisationId: ORG }, request());
    await g.call({ organisationId: ORG }, request());
    clock.now += 1_000;
    const controller = new AbortController();
    const probe = failureOf(g.call({ organisationId: ORG, signal: controller.signal }, request()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = await g.call({ organisationId: ORG }, request());
    expect(other.attempts.map((one) => one.provider)).toEqual(["b"]);
    expect(flaky.calls).toHaveLength(3);
    controller.abort();
    expect((await probe).code).toBe("aborted");

    // The caller who was probing left without the provider having said anything, so the probe is free
    // for the next call, and it is not another cooldown that is waited for.
    expect(g.providers()[0]?.state).toBe("half_open");
    const next = await g.call({ organisationId: ORG }, request());
    expect(next.provider).toBe("a");
    expect(flaky.calls).toHaveLength(4);
    expect(g.providers()[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("does not count an answer that was no good against a provider: it was reached", async () => {
    const wrong = provider("a", [{ text: "not json" }]);
    const { gateway: g } = clocked([wrong]);
    for (let i = 0; i < 5; i += 1) await failureOf(g.call({ organisationId: ORG }, request()));
    expect(g.providers()[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(wrong.calls).toHaveLength(5);
    const rejecting = provider("c", [{ fail: "rejected" }]);
    const { gateway: h } = clocked([rejecting]);
    for (let i = 0; i < 5; i += 1) await failureOf(h.call({ organisationId: ORG }, request()));
    expect(h.providers()[0]?.state).toBe("closed");
  });

  it("does not count a caller who leaves against a provider", async () => {
    const slow = provider("a", [{ hang: true }]);
    const { gateway: g } = clocked([slow]);
    for (let i = 0; i < 3; i += 1) {
      const controller = new AbortController();
      const pending = failureOf(
        g.call({ organisationId: ORG, signal: controller.signal }, request()),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      await pending;
    }
    expect(g.providers()[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("counts a provider that is too slow", async () => {
    const slow = provider("a", [{ hang: true }]);
    const { gateway: g } = clocked([slow], { timeoutMs: 15 });
    await failureOf(g.call({ organisationId: ORG }, request()));
    await failureOf(g.call({ organisationId: ORG }, request()));
    expect(g.providers()[0]?.state).toBe("open");
  });

  it("fails with a code, and calls nobody, when every provider is out of use", async () => {
    const a = provider("a", [{ fail: "unavailable" }]);
    const b = provider("b", [{ fail: "rate_limited" }]);
    const { gateway: g } = clocked([a, b]);
    await failureOf(g.call({ organisationId: ORG }, request()));
    await failureOf(g.call({ organisationId: ORG }, request()));
    expect(g.providers().map((one) => one.state)).toEqual(["open", "open"]);
    const error = await failureOf(g.call({ organisationId: ORG }, request()));
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.attempts).toEqual([]);
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(2);
  });
});

describe("what the log says of failing over", () => {
  const MARKER = "MARKER-Zq81xLm20pQw93";

  it("has a line for each attempt that failed, numbered, and one for the call, with the attempts and the cost, and nothing that was said", async () => {
    const lines: string[] = [];
    const first = provider("a", [{ text: MARKER, inputTokens: 1_000, outputTokens: 501 }]);
    const second = provider("b", [{ fail: "rate_limited" }]);
    const third = provider("c", [
      { text: JSON.stringify(GOOD), inputTokens: 2_000, outputTokens: 100 },
    ]);
    await gateway([first, second, third], {
      logger: createLogger("debug", (line) => lines.push(line)),
    }).call(
      { organisationId: ORG },
      request({ data: [{ label: "a", dataClass: "source_code", content: MARKER }] }),
    );
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "warn",
      msg: "model attempt failed",
      provider: "a",
      outcome: "provider_unavailable",
      attempt: 1,
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      level: "warn",
      msg: "model attempt failed",
      provider: "b",
      outcome: "rate_limited",
      attempt: 2,
    });
    expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({
      level: "info",
      msg: "model call",
      provider: "c",
      outcome: "ok",
      attempts: 3,
      inputTokens: 3_000,
      outputTokens: 601,
      costMicros: 3_505 + 2_500,
    });
    expect(lines.join("\n")).not.toContain(MARKER);
  });
});

describe("setting up failover", () => {
  const one = (): ModelProvider => createMockProvider();

  it("refuses limits that are out of range", () => {
    const policy = permitClasses(ALL);
    for (const maxAttempts of [0, -1, 1.5, GATEWAY_LIMITS.maxAttempts + 1]) {
      expect(() => createModelGateway({ providers: [one()], policy, maxAttempts })).toThrow(
        RangeError,
      );
    }
    for (const failureThreshold of [0, 1.5, GATEWAY_LIMITS.maxFailureThreshold + 1]) {
      expect(() =>
        createModelGateway({ providers: [one()], policy, breaker: { failureThreshold } }),
      ).toThrow(RangeError);
    }
    for (const cooldownMs of [0, 1.5, GATEWAY_LIMITS.maxCooldownMs + 1]) {
      expect(() =>
        createModelGateway({ providers: [one()], policy, breaker: { cooldownMs } }),
      ).toThrow(RangeError);
    }
  });

  it("takes the limits at their edges, the lowest and the highest", () => {
    const policy = permitClasses(ALL);
    expect(() =>
      createModelGateway({
        providers: [one()],
        policy,
        maxAttempts: GATEWAY_LIMITS.maxAttempts,
        breaker: { failureThreshold: 1, cooldownMs: GATEWAY_LIMITS.maxCooldownMs },
      }),
    ).not.toThrow();
    expect(() =>
      createModelGateway({
        providers: [one()],
        policy,
        maxAttempts: 1,
        breaker: { failureThreshold: GATEWAY_LIMITS.maxFailureThreshold, cooldownMs: 1 },
      }),
    ).not.toThrow();
  });
});
