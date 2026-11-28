import { Secret } from "@codemugs/configuration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLiveCheck } from "./live-check.js";
import type * as SchemaModule from "./schema.js";
import { answer, closeServers, fakeApi, message } from "./test-server.js";

// An adapter that sends every schema as it is, the record included, which is the mistake that the last
// step of the check exists to find. The check must say so, and must not take such an adapter for a good one.
vi.mock("./schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SchemaModule>()),
  toProviderSchema: (schema: unknown) => schema,
}));

// Made of pieces, so that no scanner takes it for a key; it is not one.
const KEY = ["a", "key", "for", "the", "tests", "of", "the", "check", "5555555555"].join("-");
const PRICE = { inputMicrosPerMillionTokens: 15_000_000, outputMicrosPerMillionTokens: 75_000_000 };

afterEach(closeServers);

async function checkAgainst(recordStatus: number, recordBody: unknown): Promise<string[]> {
  const api = await fakeApi((request, response, seen) => {
    if (request.headers["x-api-key"] !== KEY) {
      answer(response, 401, { type: "error", error: { type: "authentication_error" } });
      return;
    }
    if (seen.body.includes('"labels"')) {
      answer(response, recordStatus, recordBody);
      return;
    }
    answer(
      response,
      200,
      message({
        content: [
          {
            type: "text",
            text: seen.body.includes('"title"')
              ? '{"title":"Blue","score":7,"tags":["a"]}'
              : '{"word":"ready","count":1}',
          },
        ],
      }),
    );
  });
  const lines: string[] = [];
  await runLiveCheck({
    apiKey: new Secret(KEY),
    model: "a-model",
    price: PRICE,
    baseUrl: api.url,
    out: (line) => lines.push(line),
  });
  return lines;
}

describe("the live check, against an adapter that sends a schema it should refuse", () => {
  it("fails the last step when the request is sent and the provider refuses it", async () => {
    const lines = await checkAgainst(400, {
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(lines.some((line) => line.includes("FAIL") && line.includes("a request was sent"))).toBe(
      true,
    );
  });

  it("fails the last step when the request is sent and the provider answers it", async () => {
    const lines = await checkAgainst(
      200,
      message({ content: [{ type: "text", text: '{"labels":{"a":"b"}}' }] }),
    );
    expect(
      lines.some(
        (line) => line.includes("FAIL") && line.includes("a schema that cannot be sent was sent"),
      ),
    ).toBe(true);
  });
});
