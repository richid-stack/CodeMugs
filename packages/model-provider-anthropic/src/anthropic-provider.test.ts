import { Secret } from "@codemugs/configuration";
import {
  createModelGateway,
  ModelError,
  permitClasses,
  ProviderFailure,
  unlimitedBudget,
  type ProviderRequest,
} from "@codemugs/model-gateway";
import { afterEach, describe, expect, it } from "vitest";
import { answer, closeServers, fakeApi, message } from "./test-server.js";
import { z } from "zod";
import {
  createAnthropicProvider,
  DEFAULT_API_VERSION,
  type AnthropicProviderOptions,
} from "./index.js";

// Made of pieces, so that no scanner takes it for a key; it is not one.
const KEY = ["not", "a", "real", "key", "for", "tests", "0123456789"].join("-");
const PRICE = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };

function provider(url: string, overrides: Partial<AnthropicProviderOptions> = {}) {
  return createAnthropicProvider({
    apiKey: new Secret(KEY),
    model: "a-model",
    price: PRICE,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_000,
    baseUrl: url,
    ...overrides,
  });
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "a-model",
    system: "Say what is wrong.",
    user: "The data.",
    jsonSchema: z.toJSONSchema(z.object({ summary: z.string().min(1) })),
    maxOutputTokens: 500,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function kindOf(work: Promise<unknown>): Promise<string | undefined> {
  const error = await failureOf(work);
  return error instanceof ProviderFailure ? error.kind : `not a ProviderFailure: ${String(error)}`;
}

afterEach(closeServers);

describe("the Anthropic provider", () => {
  describe("what it sends", () => {
    it("sends one request to the messages endpoint, with the key, the version and the prompt", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      await provider(api.url).complete(request());
      expect(api.seen).toHaveLength(1);
      const [sent] = api.seen;
      expect(sent?.method).toBe("POST");
      expect(sent?.url).toBe("/v1/messages");
      expect(sent?.headers["x-api-key"]).toBe(KEY);
      expect(sent?.headers["anthropic-version"]).toBe(DEFAULT_API_VERSION);
      expect(sent?.headers["content-type"]).toBe("application/json");
      expect(sent?.headers["authorization"]).toBeUndefined();
      expect(sent?.headers["anthropic-beta"]).toBeUndefined();
      expect(JSON.parse(sent?.body ?? "")).toEqual({
        model: "a-model",
        max_tokens: 500,
        system: "Say what is wrong.",
        messages: [{ role: "user", content: "The data." }],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { summary: { type: "string", description: "(minLength 1)" } },
              required: ["summary"],
              additionalProperties: false,
            },
          },
        },
      });
    });

    it("sends nothing that identifies a person or an organisation, and none of the parameters that were removed", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      await provider(api.url).complete(request());
      const body = JSON.parse(api.seen[0]?.body ?? "") as Record<string, unknown>;
      for (const key of [
        "metadata",
        "user_id",
        "temperature",
        "top_p",
        "top_k",
        "tools",
        "stream",
      ]) {
        expect(body).not.toHaveProperty(key);
      }
    });

    it("uses the model and the version it was made with, and the name it was given", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      const made = provider(api.url, {
        model: "other-model",
        apiVersion: "2030-01-02",
        name: "claude",
      });
      expect(made.name).toBe("claude");
      expect(made.model).toBe("other-model");
      await made.complete(request());
      expect(api.seen[0]?.headers["anthropic-version"]).toBe("2030-01-02");
      expect((JSON.parse(api.seen[0]?.body ?? "") as { model: string }).model).toBe("other-model");
    });

    it("says what it can do: structured output in the provider, and the limits it was given", () => {
      const made = provider("http://127.0.0.1:1");
      expect(made.capabilities).toEqual({
        maxContextTokens: 200_000,
        maxOutputTokens: 8_000,
        structuredOutput: "native",
      });
      expect(made.price).toEqual(PRICE);
      expect(made.name).toBe("anthropic");
    });

    it("refuses a schema it cannot send as it means, before anything is sent and with no charge", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      const record = z.toJSONSchema(z.object({ r: z.record(z.string(), z.string()) }));
      expect(await kindOf(provider(api.url).complete(request({ jsonSchema: record })))).toBe(
        "rejected",
      );
      expect(api.seen).toHaveLength(0);
    });

    it("does not follow a redirect, which would take the key to wherever it points", async () => {
      const elsewhere = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      const api = await fakeApi((_request, response) => {
        response.writeHead(307, { location: `${elsewhere.url}/v1/messages` });
        response.end();
      });
      expect(await kindOf(provider(api.url).complete(request()))).toBe("rejected");
      expect(elsewhere.seen).toHaveLength(0);
    });
  });

  describe("what it makes of an answer", () => {
    it("gives the text and the tokens, and a stop that is a stop", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      expect(await provider(api.url).complete(request())).toEqual({
        text: '{"summary":"ok"}',
        inputTokens: 120,
        outputTokens: 15,
        finish: "stop",
      });
    });

    it("tells a refusal and a cut-off answer from a finished one", async () => {
      for (const [reason, finish] of [
        ["refusal", "refused"],
        ["max_tokens", "length"],
        ["model_context_window_exceeded", "length"],
        ["end_turn", "stop"],
        ["stop_sequence", "stop"],
        ["a_reason_that_does_not_exist_yet", "stop"],
        [null, "stop"],
      ] as const) {
        const api = await fakeApi((_request, response) => {
          answer(response, 200, message({ stop_reason: reason }));
        });
        expect((await provider(api.url).complete(request())).finish).toBe(finish);
      }
    });

    it("counts tokens that were written to or read from a cache as input, at the most that they can cost", async () => {
      const api = await fakeApi((_request, response) => {
        answer(
          response,
          200,
          message({
            usage: {
              input_tokens: 100,
              output_tokens: 7,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 3,
            },
          }),
        );
      });
      const result = await provider(api.url).complete(request());
      expect(result.inputTokens).toBe(123);
      expect(result.outputTokens).toBe(7);
    });

    it("joins the text blocks and leaves out the blocks that are not text", async () => {
      const api = await fakeApi((_request, response) => {
        answer(
          response,
          200,
          message({
            content: [
              { type: "thinking", thinking: "private", text: "private", signature: "x" },
              { type: "text", text: '{"summary":' },
              { type: "text", text: '"ok"}' },
              { type: "tool_use", id: "t", name: "n", input: {} },
            ],
          }),
        );
      });
      expect((await provider(api.url).complete(request())).text).toBe('{"summary":"ok"}');
    });

    it("gives empty text for an answer with no text, which the gateway then finds invalid", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message({ content: [] }));
      });
      expect((await provider(api.url).complete(request())).text).toBe("");
    });
  });

  describe("what it makes of a failure", () => {
    it.each([
      [429, "rate_limited"],
      [529, "unavailable"],
      [500, "unavailable"],
      [502, "unavailable"],
      [503, "unavailable"],
      [599, "unavailable"],
      [504, "timeout"],
      [408, "timeout"],
      [400, "rejected"],
      [401, "rejected"],
      [402, "rejected"],
      [403, "rejected"],
      [404, "rejected"],
      [409, "rejected"],
      [413, "rejected"],
      [422, "rejected"],
      [302, "rejected"],
    ])("a %i is %s", async (status, kind) => {
      const api = await fakeApi((_request, response) => {
        answer(response, status, { type: "error", error: { type: "some_error", message: "m" } });
      });
      expect(await kindOf(provider(api.url).complete(request()))).toBe(kind);
    });

    it("tells a 500 that ran out of time from one that broke", async () => {
      const slow = await fakeApi((_request, response) => {
        answer(response, 500, { type: "error", error: { type: "timeout_error", message: "m" } });
      });
      expect(await kindOf(provider(slow.url).complete(request()))).toBe("timeout");
      for (const body of [
        "not json",
        "{}",
        '{"error":5}',
        JSON.stringify({ error: { type: 7 } }),
      ]) {
        const broken = await fakeApi((_request, response) => {
          answer(response, 500, body);
        });
        expect(await kindOf(provider(broken.url).complete(request()))).toBe("unavailable");
      }
    });

    it("treats a request that never left as unavailable, which bills nothing", async () => {
      const gone = await fakeApi(() => undefined);
      const { url } = gone;
      await closeServers();
      expect(await kindOf(provider(url).complete(request()))).toBe("unavailable");
    });

    it("treats a connection that drops once the request is sent as a timeout, which is charged for", async () => {
      const api = await fakeApi((incoming) => {
        incoming.socket.destroy();
      });
      expect(await kindOf(provider(api.url).complete(request()))).toBe("timeout");
    });

    it("treats an answer that is cut off in the middle as a timeout too", async () => {
      const api = await fakeApi((incoming, response) => {
        response.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
        response.write('{"id":');
        setTimeout(() => incoming.socket.destroy(), 20);
      });
      expect(await kindOf(provider(api.url).complete(request()))).toBe("timeout");
    });

    it("tells connection failures by where they happened, with an injected fetch", async () => {
      const failing =
        (code: string): typeof globalThis.fetch =>
        () => {
          const error = new TypeError("fetch failed");
          (error as { cause?: unknown }).cause = Object.assign(new Error("x"), { code });
          return Promise.reject(error);
        };
      for (const [code, kind] of [
        ["ENOTFOUND", "unavailable"],
        ["EAI_AGAIN", "unavailable"],
        ["ECONNREFUSED", "unavailable"],
        ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unavailable"],
        ["CERT_HAS_EXPIRED", "unavailable"],
        ["ERR_TLS_CERT_ALTNAME_INVALID", "unavailable"],
        ["ECONNRESET", "timeout"],
        ["UND_ERR_SOCKET", "timeout"],
        ["UND_ERR_BODY_TIMEOUT", "timeout"],
      ] as const) {
        const made = provider("http://127.0.0.1:1", { fetch: failing(code) });
        expect(await kindOf(made.complete(request()))).toBe(kind);
      }
      // One code that says it never left is not enough when another in the chain says it might have.
      const mixed = provider("http://127.0.0.1:1", {
        fetch: () => {
          const error = new TypeError("fetch failed");
          (error as { cause?: unknown }).cause = Object.assign(new Error("x"), {
            code: "ECONNREFUSED",
            cause: Object.assign(new Error("y"), { code: "ECONNRESET" }),
          });
          return Promise.reject(error);
        },
      });
      expect(await kindOf(mixed.complete(request()))).toBe("timeout");
      // No code at all is not known to be a request that never left.
      const bare = provider("http://127.0.0.1:1", {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      });
      expect(await kindOf(bare.complete(request()))).toBe("timeout");
    });

    it("leaves an answer that cannot be used as an error that is not a ProviderFailure, which the gateway charges for", async () => {
      const bodies: unknown[] = [
        "not json",
        "[]",
        "{}",
        message({ usage: { input_tokens: -1, output_tokens: 1 } }),
        message({ usage: { input_tokens: 1.5, output_tokens: 1 } }),
        message({ usage: { input_tokens: 1, output_tokens: 1.5 } }),
        message({ usage: { input_tokens: 1 } }),
        message({
          usage: {
            input_tokens: Number.MAX_SAFE_INTEGER,
            output_tokens: 1,
            cache_read_input_tokens: 5,
          },
        }),
        message({ content: "no" }),
      ];
      for (const body of bodies) {
        const api = await fakeApi((_request, response) => {
          answer(response, 200, body);
        });
        const error = await failureOf(provider(api.url).complete(request()));
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ProviderFailure);
      }
    });

    it("leaves an answer that is not a 200 but is a success as an error that is charged for", async () => {
      const api = await fakeApi((_request, response) => {
        response.writeHead(204);
        response.end();
      });
      const error = await failureOf(provider(api.url).complete(request()));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailure);
    });

    it("does not read an answer that is larger than it may be", async () => {
      const api = await fakeApi((_request, response) => {
        answer(
          response,
          200,
          message({ content: [{ type: "text", text: "x".repeat(5 * 1_048_576) }] }),
        );
      });
      const error = await failureOf(provider(api.url).complete(request()));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailure);
    });

    it("gives up on an answer whose declared size is too large without waiting for it", async () => {
      const api = await fakeApi((_incoming, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": "99999999",
        });
        response.write("{");
      });
      const error = await failureOf(provider(api.url).complete(request()));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailure);
    });

    it("lets the gateway say that the call was given up on when that happens while the answer comes", async () => {
      const api = await fakeApi((_incoming, response) => {
        response.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
        response.write('{"id":');
      });
      const controller = new AbortController();
      const pending = failureOf(provider(api.url).complete(request({ signal: controller.signal })));
      setTimeout(() => controller.abort(), 50);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailure);
    });

    it("stops waiting when the call is given up on, and lets the gateway say so", async () => {
      const api = await fakeApi(() => undefined);
      const controller = new AbortController();
      const pending = failureOf(provider(api.url).complete(request({ signal: controller.signal })));
      setTimeout(() => controller.abort(), 30);
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailure);
      expect(controller.signal.aborted).toBe(true);
    });

    it("does not stop an answer that has come from being read when the call was abandoned afterwards", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      const controller = new AbortController();
      const result = await provider(api.url).complete(request({ signal: controller.signal }));
      controller.abort();
      expect(result.finish).toBe("stop");
    });
  });

  describe("what it keeps to itself", () => {
    const MARKER = ["MARKER", "Zq81xLm20pQw93"].join("-");

    it("puts nothing of what the provider said, or of the prompt, in an error", async () => {
      for (const status of [400, 401, 429, 500, 529]) {
        const api = await fakeApi((_request, response) => {
          answer(response, status, {
            type: "error",
            error: { type: "invalid_request_error", message: `you said ${MARKER} and ${KEY}` },
          });
        });
        const error = await failureOf(
          provider(api.url).complete(request({ user: MARKER, system: MARKER })),
        );
        const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
        expect(text).not.toContain(MARKER);
        expect(text).not.toContain(KEY);
      }
    });

    it("does not carry the key anywhere that it can be read from the provider it made", () => {
      const made = provider("http://127.0.0.1:1");
      const shown = [
        JSON.stringify(made),
        Object.prototype.toString.call(made),
        Object.getOwnPropertyNames(made).join(","),
        JSON.stringify(Object.values(made)),
      ].join(" ");
      expect(shown).not.toContain(KEY);
    });

    it("does not carry the key in an error of its own for a setting that is not valid", () => {
      let message = "";
      try {
        provider("http://127.0.0.1:1", { model: "not a model!" });
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(KEY);
    });
  });

  describe("its settings", () => {
    const bad: ReadonlyArray<readonly [string, Partial<AnthropicProviderOptions>]> = [
      ["an empty key", { apiKey: new Secret("") }],
      ["a key that is too short", { apiKey: new Secret("short") }],
      ["a key with a space in it", { apiKey: new Secret(`${KEY} extra`) }],
      ["a key with a line break in it", { apiKey: new Secret(`${KEY}\r\nx-evil: 1`) }],
      ["an empty model", { model: "" }],
      ["a model with a space", { model: "a model" }],
      ["a model that is too long", { model: "m".repeat(201) }],
      [
        "a negative price",
        { price: { inputMicrosPerMillionTokens: -1, outputMicrosPerMillionTokens: 1 } },
      ],
      [
        "a price that is not whole",
        { price: { inputMicrosPerMillionTokens: 1.5, outputMicrosPerMillionTokens: 1 } },
      ],
      [
        "a price that is not a number",
        { price: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: Number.NaN } },
      ],
      ["no room in the context", { maxContextTokens: 0 }],
      ["no room in the answer", { maxOutputTokens: 0 }],
      ["a name in capitals", { name: "Claude" }],
      ["a version that is not a date", { apiVersion: "latest" }],
      ["an address that is not one", { baseUrl: "not a url" }],
      ["an address in clear text on the network", { baseUrl: "http://api.example.com" }],
      ["an address with a login in it", { baseUrl: "https://user:pass@api.example.com" }],
      ["an address with a query", { baseUrl: "https://api.example.com/?key=1" }],
      ["an address that is not http at all", { baseUrl: "ftp://127.0.0.1" }],
    ];
    it.each(bad)("refuses %s", (_label, overrides) => {
      expect(() => provider("https://api.anthropic.com", overrides)).toThrow(RangeError);
    });

    it("takes https, and http on this machine, and the provider's own address by default", () => {
      expect(() => provider("https://proxy.example.com/base")).not.toThrow();
      expect(() => provider("http://127.0.0.1:8080")).not.toThrow();
      expect(() => provider("http://localhost:8080")).not.toThrow();
      expect(() =>
        createAnthropicProvider({
          apiKey: new Secret(KEY),
          model: "a-model",
          price: PRICE,
          maxContextTokens: 1,
          maxOutputTokens: 1,
        }),
      ).not.toThrow();
    });

    it("sends to the address it was given, below its path", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message());
      });
      await provider(`${api.url}/prefix/`).complete(request());
      expect(api.seen[0]?.url).toBe("/prefix/v1/messages");
    });
  });

  describe("under the gateway", () => {
    const shape = z.object({ summary: z.string().min(1) });
    const ask = {
      task: "diagnose",
      instructions: "Say what is wrong.",
      data: [],
      output: shape,
      maxOutputTokens: 500,
    };
    const gatewayFor = (url: string) =>
      createModelGateway({
        providers: [provider(url)],
        policy: permitClasses([]),
        budget: unlimitedBudget(),
      });
    const context = { organisationId: "4b0f1b9e-6f6a-4d8e-9b0a-2f1e6c7d8a90" };

    it("answers a call, and prices it from the usage the provider reported", async () => {
      const api = await fakeApi((_request, response) => {
        answer(response, 200, message({ usage: { input_tokens: 1_000, output_tokens: 400 } }));
      });
      const result = await gatewayFor(api.url).call(context, ask);
      expect(result.value).toEqual({ summary: "ok" });
      expect(result.provider).toBe("anthropic");
      expect(result.costMicros).toBe(9_000);
      expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["ok"]);
    });

    it("turns a refusal, a cut-off answer and an invalid one into the gateway's own errors", async () => {
      for (const [overrides, code] of [
        [{ stop_reason: "refusal" }, "refused"],
        [{ stop_reason: "max_tokens" }, "output_truncated"],
        [{ content: [{ type: "text", text: "not json" }] }, "output_invalid"],
        [{ content: [{ type: "text", text: '{"summary":""}' }] }, "output_invalid"],
      ] as const) {
        const api = await fakeApi((_request, response) => {
          answer(response, 200, message(overrides));
        });
        const error = await failureOf(gatewayFor(api.url).call(context, ask));
        expect(error).toBeInstanceOf(ModelError);
        expect((error as ModelError).code).toBe(code);
      }
    });

    it("turns the provider's failures into the gateway's codes, and charges for what may have been billed", async () => {
      for (const [status, code, charged] of [
        [429, "rate_limited", false],
        [529, "provider_unavailable", false],
        [401, "provider_rejected", false],
        [504, "timeout", true],
      ] as const) {
        const api = await fakeApi((_request, response) => {
          answer(response, status, { type: "error", error: { type: "e", message: "m" } });
        });
        const error = await failureOf(gatewayFor(api.url).call(context, ask));
        expect((error as ModelError).code).toBe(code);
        expect((error as ModelError).chargedMicros > 0).toBe(charged);
      }
    });
  });
});
