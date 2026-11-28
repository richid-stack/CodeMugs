import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "@codemugs/configuration";
import { afterEach, describe, expect, it } from "vitest";
import { runLiveCheck } from "./live-check.js";
import { answer, closeServers, fakeApi, message } from "./test-server.js";

// Made of pieces, so that no scanner takes it for a key; it is not one.
const KEY = ["a", "key", "for", "the", "tests", "of", "the", "check", "9876543210"].join("-");
const PRICE = { inputMicrosPerMillionTokens: 15_000_000, outputMicrosPerMillionTokens: 75_000_000 };

afterEach(closeServers);

function text(body: string): Record<string, unknown> {
  return message({ content: [{ type: "text", text: body }] });
}

/** What the real API does, as far as the check can tell: refuses a bad key, and answers by the schema it is sent. */
function behaving(
  overrides: {
    badKeyAccepted?: boolean;
    constrained?: (response: ServerResponse) => void;
    noCutOff?: boolean;
    /** Answers every request with this status and body, once the key has been checked. */
    always?: { status: number; body: unknown };
  } = {},
): (request: IncomingMessage, response: ServerResponse, seen: { body: string }) => void {
  return (request, response, seen) => {
    if (request.headers["x-api-key"] !== KEY && overrides.badKeyAccepted !== true) {
      answer(response, 401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      });
      return;
    }
    if (overrides.always !== undefined) {
      answer(response, overrides.always.status, overrides.always.body);
      return;
    }
    const sent = JSON.parse(seen.body) as {
      max_tokens: number;
      output_config: { format: { schema: { properties: Record<string, unknown> } } };
    };
    const names = Object.keys(sent.output_config.format.schema.properties);
    if (names.includes("word")) answer(response, 200, text('{"word":"ready","count":1}'));
    else if (names.includes("title")) {
      if (overrides.constrained !== undefined) overrides.constrained(response);
      else answer(response, 200, text('{"title":"Blue","score":7,"tags":["a"]}'));
    } else if (names.includes("story")) {
      if (overrides.noCutOff === true || sent.max_tokens > 20) {
        // An answer that fits in what was allowed is not cut short, and costs what it used.
        answer(
          response,
          200,
          message({
            content: [{ type: "text", text: '{"story":"short"}' }],
            usage: { input_tokens: 20, output_tokens: Math.min(3, sent.max_tokens) },
          }),
        );
      } else {
        answer(
          response,
          200,
          message({
            content: [{ type: "text", text: '{"story":"Once' }],
            stop_reason: "max_tokens",
          }),
        );
      }
    } else answer(response, 200, text("{}"));
  };
}

async function check(
  url: string,
  options: { capMicros?: number | undefined } = {},
): Promise<{ lines: string[]; result: Awaited<ReturnType<typeof runLiveCheck>> }> {
  const lines: string[] = [];
  const result = await runLiveCheck({
    apiKey: new Secret(KEY),
    model: "a-model",
    price: PRICE,
    baseUrl: url,
    ...options,
    out: (line) => lines.push(line),
  });
  return { lines, result };
}

describe("the live check of the model provider", () => {
  it("passes when the provider behaves as documented, and says so for each step", async () => {
    const api = await fakeApi(behaving());
    const { lines, result } = await check(api.url);
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(lines.filter((line) => line.includes("ok  "))).toHaveLength(5);
    expect(lines.at(-1)).toMatch(/^All 5 steps passed\./);
    // The bad key, the plain answer, the constrained answer and the cut-off one are sent. The record is not.
    expect(api.seen).toHaveLength(4);
    expect(result.spentMicros).toBeGreaterThan(0);
    expect(result.spentMicros).toBeLessThanOrEqual(200_000);
    // What it asks for is the model it was given, and the cap it reports is the default one.
    for (const note of api.seen) {
      expect((JSON.parse(note.body) as { model: string }).model).toBe("a-model");
    }
    expect(lines.at(-1)).toContain("of a cap of 200000.");
  });

  it("never prints the key, in any outcome", async () => {
    const outcomes = [
      behaving(),
      behaving({ badKeyAccepted: true }),
      behaving({
        constrained: (response) => {
          answer(response, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: `bad schema, and your key is ${KEY}` },
          });
        },
      }),
    ];
    for (const handler of outcomes) {
      const api = await fakeApi(handler);
      const { lines } = await check(api.url);
      expect(lines.join("\n")).not.toContain(KEY);
    }
  });

  it("fails when a key that is not valid is accepted", async () => {
    const api = await fakeApi(behaving({ badKeyAccepted: true }));
    const { lines, result } = await check(api.url);
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.ok).toBe(false);
    expect(lines.some((line) => line.includes("FAIL") && line.includes("not valid"))).toBe(true);
  });

  it("fails a step that the provider refuses, and says what it said, with the key taken out", async () => {
    const api = await fakeApi(
      behaving({
        constrained: (response) => {
          answer(response, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: `bad schema, and your key is ${KEY}` },
          });
        },
      }),
    );
    const { lines, result } = await check(api.url);
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, false, true, true]);
    const said = lines.find((line) => line.includes("the provider answered 400"));
    expect(said).toContain("bad schema");
    expect(said).toContain("[key]");
    expect(lines.some((line) => line.includes("FAIL") && line.includes("provider_rejected"))).toBe(
      true,
    );
  });

  it("cuts what the provider said to a short line", async () => {
    const api = await fakeApi(
      behaving({
        constrained: (response) => {
          answer(response, 400, `{"error":"${"x".repeat(5_000)}"}`);
        },
      }),
    );
    const { lines } = await check(api.url);
    const said = lines.find((line) => line.includes("the provider answered 400"));
    expect(said?.length).toBeLessThan(700);
    expect(said).toContain("xxxx");
  });

  it("sends one request for each call and no more, so that a failing provider costs little", async () => {
    // Once the key has been checked, the provider is down for everything.
    const api = await fakeApi(behaving({ always: { status: 503, body: "" } }));
    const { lines, result } = await check(api.url);
    expect(result.passed).toBe(false);
    // The check of the bad key, which is refused by key before anything else, is one request; each of
    // the three calls through the gateway is one (a retry would be three): four in all, and none for the record.
    expect(api.seen).toHaveLength(4);
    expect(result.steps.map((step) => step.ok)).toEqual([true, false, false, false, true]);
    expect(lines.filter((line) => line.includes("provider_unavailable"))).toHaveLength(3);
  });

  it("names what a failed call was, down to the outcome of each attempt", async () => {
    const api = await fakeApi(
      behaving({
        always: {
          status: 500,
          body: { type: "error", error: { type: "timeout_error", message: "slow" } },
        },
      }),
    );
    const { lines } = await check(api.url);
    expect(lines.some((line) => line.includes("FAIL") && /attempts: timeout/.test(line))).toBe(
      true,
    );
  });

  it("fails the check of the bad key when what comes back is not a refusal of the key", async () => {
    // A provider that is down for every request, the bad key included.
    const down = await fakeApi((_request, response) => {
      answer(response, 503, "");
    });
    const { lines, result } = await check(down.url);
    expect(result.steps[0]?.ok).toBe(false);
    expect(lines.some((line) => line.includes("expected a refusal, got unavailable"))).toBe(true);
  });

  it("fails when an answer that should be cut short is not", async () => {
    const api = await fakeApi(behaving({ noCutOff: true }));
    const { result } = await check(api.url);
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => step.ok)).toEqual([true, true, true, false, true]);
  });

  it("asks for an answer too short for its story, which is what cuts it short", async () => {
    const api = await fakeApi(behaving());
    await check(api.url);
    const limits = api.seen.map(
      (note) => (JSON.parse(note.body) as { max_tokens: number }).max_tokens,
    );
    expect(Math.min(...limits)).toBeLessThanOrEqual(20);
  });

  it("stops at its cap: when the cap is nothing, no call is sent and each step that goes through the gateway fails", async () => {
    const api = await fakeApi(behaving());
    const { lines, result } = await check(api.url, { capMicros: 0 });
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => step.ok)).toEqual([true, false, false, false, false]);
    // Only the check of the bad key reached the provider, which does not go through the budget.
    expect(api.seen).toHaveLength(1);
    expect(lines.filter((line) => line.includes("budget_exceeded"))).toHaveLength(4);
    expect(result.spentMicros).toBe(0);
  });
});
