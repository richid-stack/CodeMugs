import { createLogger } from "@codemugs/logging";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMemoryBudget,
  unlimitedBudget,
  type BudgetClaim,
  type BudgetGrant,
  type BudgetLedger,
  type BudgetLimits,
} from "./budget.js";
import { costMicros, estimateTokens } from "./cost.js";
import { ModelError, type ModelErrorCode } from "./errors.js";
import { createModelGateway, type GatewayOptions } from "./gateway.js";
import { createMockProvider, type MockProvider, type MockStep } from "./mock-provider.js";
import { permitClasses } from "./policy.js";
import type { DataClass, ModelProvider, ModelRequest, ProviderRequest } from "./types.js";

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
const PRICE = { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 5_000_000 };
const MAX_OUTPUT = 500;
const ROOMY: BudgetLimits = { organisationMonthlyMicros: 1_000_000_000_000 };

function request(overrides: Partial<ModelRequest<Answer>> = {}): ModelRequest<Answer> {
  return {
    task: "diagnose",
    instructions: "Say what is wrong.",
    data: [],
    output: shape,
    maxOutputTokens: MAX_OUTPUT,
    ...overrides,
  };
}

function provider(name: string, steps: readonly MockStep[]): MockProvider {
  return createMockProvider({ name, model: `${name}-model`, steps });
}

function gateway(providers: readonly ModelProvider[], options: Partial<GatewayOptions> = {}) {
  return createModelGateway({
    providers,
    policy: permitClasses(ALL),
    budget: unlimitedBudget(),
    ...options,
  });
}

async function failureOf(work: Promise<unknown>): Promise<ModelError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

/** A ledger that notes the claims it is given, and answers as the one inside it does. */
function recording(inner: BudgetLedger) {
  const claims: BudgetClaim[] = [];
  const ledger: BudgetLedger = {
    reserve: (claim) => {
      claims.push(claim);
      return inner.reserve(claim);
    },
  };
  return { claims, ledger };
}

function memory(limits: BudgetLimits) {
  return createMemoryBudget({ limits: () => limits });
}

/** The most that an attempt can cost, worked out from what the provider was sent: what the gateway should have reserved. */
function worstOf(sent: ProviderRequest): number {
  const input =
    estimateTokens(sent.system) +
    estimateTokens(sent.user) +
    estimateTokens(JSON.stringify(sent.jsonSchema));
  return costMicros(input, MAX_OUTPUT, PRICE);
}

/** What a call that answers costs, and what is reserved for it, for tests to set limits by. */
async function measure() {
  const probe = provider("probe", [{ value: GOOD }]);
  const { claims, ledger } = recording(memory(ROOMY));
  const result = await gateway([probe], { budget: ledger }).call(
    { organisationId: ORG },
    request(),
  );
  const worst = claims[0]?.micros ?? 0;
  expect(worst).toBe(worstOf(probe.calls[0] as ProviderRequest));
  expect(result.costMicros).toBeGreaterThan(0);
  expect(worst).toBeGreaterThan(result.costMicros);
  return { worst, actual: result.costMicros };
}

describe("reserving for a call and settling it", () => {
  it("reserves the worst case before the provider is called, and is charged what the call cost", async () => {
    const answering = provider("a", [{ value: GOOD }]);
    const memorised = memory(ROOMY);
    const seenBefore: number[] = [];
    const ledger: BudgetLedger = {
      reserve: (claim) => {
        seenBefore.push(answering.calls.length);
        return memorised.reserve(claim);
      },
    };
    const claimed = recording(ledger);
    const result = await gateway([answering], { budget: claimed.ledger }).call(
      { organisationId: ORG },
      request(),
    );
    expect(seenBefore).toEqual([0]);
    expect(claimed.claims).toHaveLength(1);
    expect(claimed.claims[0]).toEqual({
      organisationId: ORG,
      micros: worstOf(answering.calls[0] as ProviderRequest),
    });
    expect(claimed.claims[0]?.micros).toBeGreaterThan(result.costMicros);
    // What is counted is what the call cost, and not what was set aside for it.
    expect(memorised.usedMicros(ORG)).toBe(result.costMicros);
    expect(result.chargedMicros).toBe(result.costMicros);
    expect(result.attempts[0]?.chargedMicros).toBe(result.costMicros);
  });

  it("names the task when the caller has one", async () => {
    const claimed = recording(memory(ROOMY));
    await gateway([provider("a", [{ value: GOOD }])], { budget: claimed.ledger }).call(
      { organisationId: ORG, taskId: "task-7" },
      request(),
    );
    expect(claimed.claims[0]).toMatchObject({ organisationId: ORG, taskId: "task-7" });
  });

  it("is charged what the provider said it used, even if that is more than was reserved", async () => {
    const memorised = memory({ organisationMonthlyMicros: 500_000 });
    const big = provider("a", [
      { text: JSON.stringify(GOOD), inputTokens: 1_000_000, outputTokens: 100 },
    ]);
    const g = gateway([big], { budget: memorised });
    const result = await g.call({ organisationId: ORG }, request());
    expect(result.costMicros).toBe(1_000_000 + 500);
    expect(memorised.usedMicros(ORG)).toBe(1_000_500);
    // The limit has been passed, by what the guess missed, and the next call is refused.
    const error = await failureOf(g.call({ organisationId: ORG }, request()));
    expect(error.code).toBe("budget_exceeded");
  });

  it("is charged the cost of an answer that was billed and could not be used, and not the worst case", async () => {
    const memorised = memory(ROOMY);
    const refusing = provider("a", [
      { text: "no", finish: "refused", inputTokens: 100, outputTokens: 10 },
    ]);
    const error = await failureOf(
      gateway([refusing], { budget: memorised }).call({ organisationId: ORG }, request()),
    );
    expect(error.code).toBe("refused");
    expect(error.chargedMicros).toBe(100 + 50);
    expect(memorised.usedMicros(ORG)).toBe(150);
  });

  it("is charged for what a schema that throws was given: the answer was billed", async () => {
    const memorised = memory(ROOMY);
    const throwing = z.object({ summary: z.string() }).refine(() => {
      throw new Error("the schema broke on MARKER-Zq81xLm20pQw93");
    });
    const lines: string[] = [];
    const error = await failureOf(
      gateway([provider("a", [{ value: { summary: "x" } }])], {
        budget: memorised,
        logger: createLogger("debug", (line) => lines.push(line)),
      }).call(
        { organisationId: ORG },
        request({ output: throwing as unknown as z.ZodType<Answer> }),
      ),
    );
    expect(error.code).toBe("output_invalid");
    expect(error.attempts[0]?.usage).toBeDefined();
    expect(error.chargedMicros).toBe(error.costMicros);
    expect(error.chargedMicros).toBeGreaterThan(0);
    expect(memorised.usedMicros(ORG)).toBe(error.chargedMicros);
    expect(error.message + JSON.stringify(error.attempts) + lines.join("\n")).not.toContain(
      "MARKER",
    );
  });
});

describe("work that stops when the money does", () => {
  it("stops an organisation at its limit for the month, and the provider is not asked", async () => {
    const { worst, actual } = await measure();
    const answering = provider("a", [{ value: GOOD }]);
    const lines: string[] = [];
    const memorised = memory({ organisationMonthlyMicros: worst + 2 * actual - 1 });
    const g = gateway([answering], {
      budget: memorised,
      logger: createLogger("debug", (line) => lines.push(line)),
    });
    await g.call({ organisationId: ORG }, request());
    await g.call({ organisationId: ORG }, request());
    expect(answering.calls).toHaveLength(2);
    const error = await failureOf(g.call({ organisationId: ORG }, request()));
    expect(error.code).toBe("budget_exceeded");
    expect(error.retryable).toBe(false);
    expect(error.attempts).toEqual([]);
    expect(answering.calls).toHaveLength(2);
    expect(memorised.usedMicros(ORG)).toBe(2 * actual);
    const failed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1);
    expect(failed).toMatchObject({
      msg: "model call failed",
      outcome: "budget_exceeded",
      limit: "organisation",
    });
    expect(failed).not.toHaveProperty("provider");
  });

  it("refuses a call whose worst case does not fit, though what it would cost does", async () => {
    const { worst, actual } = await measure();
    expect(actual).toBeLessThan(worst - 1);
    const answering = provider("a", [{ value: GOOD }]);
    const error = await failureOf(
      gateway([answering], { budget: memory({ organisationMonthlyMicros: worst - 1 }) }).call(
        { organisationId: ORG },
        request(),
      ),
    );
    expect(error.code).toBe("budget_exceeded");
    expect(answering.calls).toHaveLength(0);
  });

  it("stops everything for an organisation whose limit is nothing, or that has none", async () => {
    for (const limits of [{ organisationMonthlyMicros: 0 }, undefined]) {
      const answering = provider("a", [{ value: GOOD }]);
      const ledger = createMemoryBudget({ limits: () => limits });
      const error = await failureOf(
        gateway([answering], { budget: ledger }).call({ organisationId: ORG }, request()),
      );
      expect(error.code).toBe("budget_exceeded");
      expect(answering.calls).toHaveLength(0);
    }
  });

  it("stops a task at its limit and no other work, and says which limit it was", async () => {
    const { worst, actual } = await measure();
    const answering = provider("a", [{ value: GOOD }]);
    const lines: string[] = [];
    const g = gateway([answering], {
      budget: memory({ ...ROOMY, taskMicros: worst + 2 * actual - 1 }),
      logger: createLogger("debug", (line) => lines.push(line)),
    });
    const task = { organisationId: ORG, taskId: "task-1" };
    await g.call(task, request());
    await g.call(task, request());
    const error = await failureOf(g.call(task, request()));
    expect(error.code).toBe("budget_exceeded");
    expect(answering.calls).toHaveLength(2);
    const failed = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(failed).toMatchObject({ outcome: "budget_exceeded", limit: "task", taskId: "task-1" });

    // Another task, and a call that is no task's, are not stopped.
    await g.call({ organisationId: ORG, taskId: "task-2" }, request());
    await g.call({ organisationId: ORG }, request());
    expect(answering.calls).toHaveLength(4);
  });

  it("does not let calls made at once go past the limit: each reserves before it is sent", async () => {
    const { worst, actual } = await measure();
    const mock = provider("a", [{ value: GOOD }]);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held: ModelProvider = {
      ...mock,
      name: "a",
      complete: async (sent) => {
        await gate;
        return mock.complete(sent);
      },
    };
    const claimed = recording(memory({ organisationMonthlyMicros: 4 * worst }));
    const memorised = claimed.ledger;
    const g = gateway([held], { budget: memorised });
    const calls = Array.from({ length: 10 }, () => g.call({ organisationId: ORG }, request()));
    const settled = Promise.allSettled(calls);
    for (let waited = 0; claimed.claims.length < 10 && waited < 2_000; waited += 5) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed.claims).toHaveLength(10);
    open();
    const outcomes = await settled;
    const refused = outcomes.filter(
      (one) => one.status === "rejected" && (one.reason as ModelError).code === "budget_exceeded",
    );
    expect(outcomes.filter((one) => one.status === "fulfilled")).toHaveLength(4);
    expect(refused).toHaveLength(6);
    expect(mock.calls).toHaveLength(4);
    expect(actual).toBeLessThan(worst);
  });

  it("refuses a call whose worst case cannot be worked out, because it is too large", async () => {
    const absurd = createMockProvider({
      name: "a",
      capabilities: { maxContextTokens: Number.MAX_SAFE_INTEGER },
      price: { inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER },
    });
    const error = await failureOf(
      gateway([absurd]).call(
        { organisationId: ORG },
        request({ data: [{ label: "a", dataClass: "source_code", content: "é".repeat(900_000) }] }),
      ),
    );
    expect(error.code).toBe("budget_exceeded");
    expect(absurd.calls).toHaveLength(0);
  });
});

describe("what an attempt is charged when it did not answer", () => {
  async function chargedFor(step: MockStep) {
    const memorised = memory(ROOMY);
    const error = await failureOf(
      gateway([provider("a", [step])], { budget: memorised }).call(
        { organisationId: ORG },
        request(),
      ),
    );
    return { error, used: memorised.usedMicros(ORG) };
  }

  it.each<[string, MockStep, boolean]>([
    ["could not be reached", { fail: "unavailable" }, false],
    ["limited the requests", { fail: "rate_limited" }, false],
    ["rejected the request", { fail: "rejected" }, false],
    ["said that it was too slow", { fail: "timeout" }, true],
    ["failed with an error of its own", { crash: true }, true],
    ["gave usage that is not a count", { text: "{}", inputTokens: 1.5 }, true],
    ["gave a negative count", { text: "{}", outputTokens: -4 }, true],
    [
      "gave usage too large to be a cost",
      { text: "{}", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 10 },
      true,
    ],
  ])("is charged nothing, or the worst case, when the provider %s", async (_name, step, billed) => {
    const { worst } = await measure();
    const { error, used } = await chargedFor(step);
    expect(error.chargedMicros).toBe(billed ? worst : 0);
    expect(used).toBe(billed ? worst : 0);
    expect(error.costMicros).toBe(0);
    expect(error.attempts[0]?.usage).toBeUndefined();
  });

  it("is charged the worst case when the provider is too slow, and then the next provider is charged what it cost", async () => {
    const { worst } = await measure();
    const memorised = memory(ROOMY);
    const result = await gateway(
      [provider("a", [{ hang: true }]), provider("b", [{ value: GOOD }])],
      {
        budget: memorised,
        timeoutMs: 30,
      },
    ).call({ organisationId: ORG }, request());
    expect(result.attempts.map((one) => [one.provider, one.outcome])).toEqual([
      ["a", "timeout"],
      ["b", "ok"],
    ]);
    expect(result.attempts[0]?.chargedMicros).toBe(worst);
    expect(result.attempts[0]?.usage).toBeUndefined();
    expect(result.costMicros).toBe(result.attempts[1]?.usage?.costMicros);
    expect(result.chargedMicros).toBe(worst + result.costMicros);
    expect(memorised.usedMicros(ORG)).toBe(worst + result.costMicros);
  });

  it("is charged the worst case when the caller leaves, because the provider may have been asked", async () => {
    const { worst } = await measure();
    const memorised = memory(ROOMY);
    const controller = new AbortController();
    const pending = failureOf(
      gateway([provider("a", [{ hang: true }])], { budget: memorised }).call(
        { organisationId: ORG, signal: controller.signal },
        request(),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe("aborted");
    expect(error.chargedMicros).toBe(worst);
    expect(memorised.usedMicros(ORG)).toBe(worst);
  });

  it("tells the ledger to release what was not spent and to settle what was, and not the other way round", async () => {
    const told: string[] = [];
    const spy: BudgetLedger = {
      reserve: () =>
        Promise.resolve({
          ok: true,
          reservation: {
            settle: (charged) => {
              told.push(`settle ${charged}`);
              return Promise.resolve();
            },
            release: () => {
              told.push("release");
              return Promise.resolve();
            },
          },
        }),
    };
    const result = await gateway(
      [provider("a", [{ fail: "unavailable" }]), provider("b", [{ value: GOOD }])],
      { budget: spy },
    ).call({ organisationId: ORG }, request());
    expect(told).toEqual(["release", `settle ${result.costMicros}`]);
  });

  it("reserves for each attempt, and a provider that could not be reached gives its reservation back", async () => {
    const memorised = memory(ROOMY);
    const claimed = recording(memorised);
    const first = provider("a", [{ fail: "unavailable" }]);
    const second = provider("b", [{ value: GOOD }]);
    const result = await gateway([first, second], { budget: claimed.ledger }).call(
      { organisationId: ORG },
      request(),
    );
    expect(claimed.claims.map((claim) => claim.micros)).toEqual([
      worstOf(first.calls[0] as ProviderRequest),
      worstOf(second.calls[0] as ProviderRequest),
    ]);
    expect(result.attempts.map((one) => one.chargedMicros)).toEqual([0, result.costMicros]);
    expect(result.chargedMicros).toBe(result.costMicros);
    expect(memorised.usedMicros(ORG)).toBe(result.costMicros);
  });

  it("stops at the next attempt when there is no room for it, with the first attempt in the error", async () => {
    const { worst } = await measure();
    const memorised = memory({ organisationMonthlyMicros: worst + worst / 2 });
    const second = provider("b", [{ value: GOOD }]);
    // The first attempt is charged the worst case (it was too slow), so there is no room for another.
    const error = await failureOf(
      gateway([provider("a", [{ fail: "timeout" }]), second], { budget: memorised }).call(
        { organisationId: ORG },
        request(),
      ),
    );
    expect(error.code).toBe("budget_exceeded");
    expect(error.attempts.map((one) => [one.provider, one.outcome])).toEqual([["a", "timeout"]]);
    expect(error.chargedMicros).toBe(worst);
    expect(second.calls).toHaveLength(0);
  });
});

describe("a budget that cannot be read", () => {
  const LEDGER_WORDS = "connection to db.internal refused";

  it.each<[string, BudgetLedger]>([
    ["rejects", { reserve: () => Promise.reject(new Error(LEDGER_WORDS)) }],
    [
      "throws",
      {
        reserve: () => {
          throw new Error(LEDGER_WORDS);
        },
      },
    ],
  ])("sends nothing, and tells nothing, when the ledger %s", async (_name, ledger) => {
    const answering = provider("a", [{ value: GOOD }]);
    const lines: string[] = [];
    const error = await failureOf(
      gateway([answering], {
        budget: ledger,
        logger: createLogger("debug", (line) => lines.push(line)),
      }).call({ organisationId: ORG }, request()),
    );
    expect(error.code).toBe("budget_unavailable");
    expect(error.retryable).toBe(true);
    expect(answering.calls).toHaveLength(0);
    expect(error.message + JSON.stringify(error.attempts) + lines.join("\n")).not.toContain(
      "db.internal",
    );
  });

  it("is not counted against the provider, and a provider that is being probed is free for the next call", async () => {
    const clock = { now: 1_000_000 };
    let room = true;
    const memorised = memory(ROOMY);
    const ledger: BudgetLedger = {
      reserve: (claim): Promise<BudgetGrant> =>
        room ? memorised.reserve(claim) : Promise.resolve({ ok: false, limit: "organisation" }),
    };
    const flaky = provider("a", [{ fail: "unavailable" }, { value: GOOD }]);
    const g = gateway([flaky], {
      now: () => clock.now,
      breaker: { failureThreshold: 1, cooldownMs: 1_000 },
      budget: ledger,
    });
    // One failure of the provider opens its breaker, and when the cooldown is over the next call is its probe.
    await failureOf(g.call({ organisationId: ORG }, request()));
    expect(g.providers()[0]?.state).toBe("open");
    clock.now += 1_000;

    // There is no room for the probe. That is not the provider's failure, and the probe is not used up.
    room = false;
    for (let i = 0; i < 3; i += 1) {
      expect((await failureOf(g.call({ organisationId: ORG }, request()))).code).toBe(
        "budget_exceeded",
      );
    }
    expect(g.providers()[0]).toMatchObject({ state: "half_open", consecutiveFailures: 1 });
    expect(flaky.calls).toHaveLength(1);

    room = true;
    expect((await g.call({ organisationId: ORG }, request())).provider).toBe("a");
    expect(flaky.calls).toHaveLength(2);
    expect(g.providers()[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("frees the probe of a provider when the ledger fails, as it does when there is no room", async () => {
    const clock = { now: 1_000_000 };
    let working = true;
    const memorised = memory(ROOMY);
    const ledger: BudgetLedger = {
      reserve: (claim) =>
        working ? memorised.reserve(claim) : Promise.reject(new Error("the ledger is down")),
    };
    const flaky = provider("a", [{ fail: "unavailable" }, { value: GOOD }]);
    const g = gateway([flaky], {
      now: () => clock.now,
      breaker: { failureThreshold: 1, cooldownMs: 1_000 },
      budget: ledger,
    });
    await failureOf(g.call({ organisationId: ORG }, request()));
    clock.now += 1_000;
    working = false;
    expect((await failureOf(g.call({ organisationId: ORG }, request()))).code).toBe(
      "budget_unavailable",
    );
    expect(g.providers()[0]).toMatchObject({ state: "half_open", consecutiveFailures: 1 });
    working = true;
    expect((await g.call({ organisationId: ORG }, request())).provider).toBe("a");
    expect(flaky.calls).toHaveLength(2);
  });

  it("frees the probe of a provider when the worst case of a call cannot be worked out", async () => {
    const clock = { now: 1_000_000 };
    const absurd = createMockProvider({
      name: "a",
      capabilities: { maxContextTokens: Number.MAX_SAFE_INTEGER },
      price: { inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER },
      steps: [{ fail: "unavailable" }, { value: GOOD }],
    });
    const g = gateway([absurd], {
      now: () => clock.now,
      breaker: { failureThreshold: 1, cooldownMs: 1_000 },
    });
    await failureOf(g.call({ organisationId: ORG }, request()));
    clock.now += 1_000;
    const huge = request({
      data: [{ label: "a", dataClass: "source_code", content: "é".repeat(900_000) }],
    });
    expect((await failureOf(g.call({ organisationId: ORG }, huge))).code).toBe("budget_exceeded");
    expect(g.providers()[0]?.state).toBe("half_open");
    expect((await g.call({ organisationId: ORG }, request())).provider).toBe("a");
    expect(absurd.calls).toHaveLength(2);
  });

  it("gives a reservation back that is granted after the caller has left", async () => {
    let grant!: (value: BudgetGrant) => void;
    const late = new Promise<BudgetGrant>((resolve) => {
      grant = resolve;
    });
    let released = 0;
    const answering = provider("a", [{ value: GOOD }]);
    const controller = new AbortController();
    const pending = failureOf(
      gateway([answering], { budget: { reserve: () => late } }).call(
        { organisationId: ORG, signal: controller.signal },
        request(),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe("aborted");
    expect(released).toBe(0);
    grant({
      ok: true,
      reservation: {
        settle: () => Promise.resolve(),
        release: () => {
          released += 1;
          return Promise.resolve();
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(released).toBe(1);
    expect(answering.calls).toHaveLength(0);
  });

  it("does not leave a failure of the ledger unhandled when it comes after the caller has left", async () => {
    let fail!: (reason: Error) => void;
    const late = new Promise<BudgetGrant>((_resolve, reject) => {
      fail = reject;
    });
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const pending = failureOf(
        gateway([provider("a", [{ value: GOOD }])], { budget: { reserve: () => late } }).call(
          { organisationId: ORG, signal: controller.signal },
          request(),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      expect((await pending).code).toBe("aborted");
      fail(new Error(LEDGER_WORDS));
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("a ledger that fails to settle", () => {
  const LEDGER_WORDS = ["MARKER", "Zq81xLm20pQw93", "from the ledger"].join("-");
  function failing(): BudgetLedger {
    return {
      reserve: () =>
        Promise.resolve({
          ok: true,
          reservation: {
            settle: () => Promise.reject(new Error(LEDGER_WORDS)),
            release: () => Promise.reject(new Error(LEDGER_WORDS)),
          },
        }),
    };
  }

  it("does not fail a call that has been answered and paid for, and says so in the log without the ledger's words", async () => {
    const lines: string[] = [];
    const result = await gateway([provider("a", [{ value: GOOD }])], {
      budget: failing(),
      logger: createLogger("debug", (line) => lines.push(line)),
    }).call({ organisationId: ORG, taskId: "task-9" }, request());
    expect(result.value).toEqual(GOOD);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged[0]).toMatchObject({
      level: "warn",
      msg: "model budget settle failed",
      organisationId: ORG,
      taskId: "task-9",
      chargedMicros: result.chargedMicros,
    });
    expect(logged[1]).toMatchObject({ msg: "model call", outcome: "ok" });
    expect(lines.join("\n")).not.toContain("MARKER");
  });

  it("does not change what a failed call fails with when the reservation cannot be given back", async () => {
    const error = await failureOf(
      gateway([provider("a", [{ fail: "unavailable" }])], { budget: failing() }).call(
        { organisationId: ORG },
        request(),
      ),
    );
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).not.toContain("MARKER");
  });
});

describe("the id of a task", () => {
  it.each(["", "a b", "x".repeat(65), "task/1", "t\n1", "é"])(
    "refuses %j, and nothing is reserved or sent",
    async (taskId) => {
      const answering = provider("a", [{ value: GOOD }]);
      const claimed = recording(memory(ROOMY));
      const lines: string[] = [];
      const error = await failureOf(
        gateway([answering], {
          budget: claimed.ledger,
          logger: createLogger("debug", (line) => lines.push(line)),
        }).call({ organisationId: ORG, taskId }, request()),
      );
      expect(error.code satisfies ModelErrorCode).toBe("invalid_request");
      expect(claimed.claims).toEqual([]);
      expect(answering.calls).toHaveLength(0);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ taskId: "invalid" });
      expect(lines.join("\n")).not.toContain(taskId === "" ? "\u0000" : taskId);
    },
  );

  it("refuses an id that is not a string", async () => {
    const error = await failureOf(
      gateway([provider("a", [{ value: GOOD }])]).call(
        { organisationId: ORG, taskId: 7 as unknown as string },
        request(),
      ),
    );
    expect(error.code).toBe("invalid_request");
  });

  it("takes the ids that an opaque id is: letters, digits, hyphens and underscores, up to 64", async () => {
    for (const taskId of [
      "a",
      "Task_1-b",
      "0".repeat(64),
      "11111111-1111-4111-8111-111111111111",
    ]) {
      const result = await gateway([provider("a", [{ value: GOOD }])]).call(
        { organisationId: ORG, taskId },
        request(),
      );
      expect(result.value).toEqual(GOOD);
    }
  });

  it("is in the log of a call, with what it was charged, and nothing that was said", async () => {
    const lines: string[] = [];
    const result = await gateway([provider("a", [{ value: GOOD }])], {
      logger: createLogger("debug", (line) => lines.push(line)),
    }).call({ organisationId: ORG, taskId: "task-5" }, request());
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      msg: "model call",
      taskId: "task-5",
      costMicros: result.costMicros,
      chargedMicros: result.chargedMicros,
    });
    expect(lines.join("\n")).not.toContain(GOOD.summary);
  });
});
