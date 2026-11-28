import { ProviderFailure } from "@codemugs/model-gateway";
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  UnusableAnswer,
  checkedBaseUrl,
  connectionFailure,
  exchange,
  isCount,
  isKey,
  isModel,
  isModelPath,
  isName,
  readText,
  type Exchange,
} from "./http.js";

function refusedWith(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderFailure) return error.kind;
    if (error instanceof UnusableAnswer) return "unusable";
    return "other";
  }
  return "none";
}

const plain = (): "timeout" | "unavailable" => "unavailable";

function exchangeWith(
  send: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<Exchange> = {},
): Promise<string> {
  return exchange({
    send: send as typeof globalThis.fetch,
    url: "https://provider.example/v1/chat",
    headers: { authorization: "Bearer a-key" },
    body: '{"a":1}',
    signal: new AbortController().signal,
    kindOf500: plain,
    ...overrides,
  });
}

const respond = (status: number, body = "", headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(status === 204 ? null : body, { status, headers }));

describe("the address of a provider", () => {
  it("takes https anywhere and http on this machine only, without its trailing slash", () => {
    expect(checkedBaseUrl("https://api.example.com")).toBe("https://api.example.com");
    expect(checkedBaseUrl("https://api.example.com/v1beta/openai/")).toBe(
      "https://api.example.com/v1beta/openai",
    );
    for (const host of ["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]) {
      expect(checkedBaseUrl(`http://${host}`)).toBe(`http://${host}`);
    }
  });

  it("refuses what is not a place: other schemes, http elsewhere, credentials, a query, a fragment, text", () => {
    for (const text of [
      "http://api.example.com",
      "http://127.0.0.1.example.com",
      "ftp://api.example.com",
      "https://user@api.example.com",
      "https://user:pass@api.example.com",
      "https://:pass@api.example.com",
      "https://api.example.com?key=1",
      "https://api.example.com#x",
      "not an address",
      "",
    ]) {
      expect(refusedWith(() => checkedBaseUrl(text))).toBeInstanceOf(RangeError);
    }
  });
});

describe("names, models, keys and counts", () => {
  it("takes a name that is lower case and short", () => {
    expect(isName("groq")).toBe(true);
    expect(isName("a".repeat(64))).toBe(true);
    expect(isName("a".repeat(65))).toBe(false);
    for (const bad of ["", "Groq", "1abc", "a b", "a/b", "-a"]) expect(isName(bad)).toBe(false);
  });

  it("takes a model name without a path, and with one only where a path is meant", () => {
    expect(isModel("claude-opus-4.5")).toBe(true);
    expect(isModel("a".repeat(200))).toBe(true);
    expect(isModel("a".repeat(201))).toBe(false);
    expect(isModel("openai/gpt-oss-20b")).toBe(false);
    expect(isModelPath("openai/gpt-oss-20b")).toBe(true);
    expect(isModelPath("gemini-2.5-flash")).toBe(true);
    expect(isModelPath("models/gemini-2.5-flash")).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "a/b/c", "../a", "a b", "a\nb", "-a"]) {
      expect(isModelPath(bad)).toBe(false);
    }
  });

  it("takes a key that is printable text of a sensible length, so that it cannot add a header", () => {
    expect(isKey("x".repeat(16))).toBe(true);
    expect(isKey("x".repeat(512))).toBe(true);
    expect(isKey("x".repeat(15))).toBe(false);
    expect(isKey("x".repeat(513))).toBe(false);
    for (const bad of [
      "a b".padEnd(20, "x"),
      `${"x".repeat(20)}\r\nx-other: 1`,
      `${"x".repeat(20)}é`,
      `${"x".repeat(20)}\x7f`,
    ]) {
      expect(isKey(bad)).toBe(false);
    }
  });

  it("counts a whole, safe number at or over a minimum", () => {
    expect(isCount(0, 0)).toBe(true);
    expect(isCount(1, 1)).toBe(true);
    expect(isCount(0, 1)).toBe(false);
    expect(isCount(-1, 0)).toBe(false);
    expect(isCount(1.5, 0)).toBe(false);
    expect(isCount(Number.NaN, 0)).toBe(false);
    expect(isCount(Number.MAX_SAFE_INTEGER, 0)).toBe(true);
    expect(isCount(Number.MAX_SAFE_INTEGER + 1, 0)).toBe(false);
  });
});

describe("a failure of the connection", () => {
  const coded = (code: string, extra: object = {}) =>
    Object.assign(new Error("x"), { code, ...extra });

  it("is not billed (unavailable) when the request cannot have left, and anywhere in the chain", () => {
    for (const code of [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ERR_INVALID_URL",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_OSSL_BAD_DECRYPT",
    ]) {
      expect(connectionFailure(coded(code)).kind).toBe("unavailable");
      expect(connectionFailure(new TypeError("fetch failed", { cause: coded(code) })).kind).toBe(
        "unavailable",
      );
    }
    expect(
      connectionFailure(
        new AggregateError([coded("ECONNREFUSED"), coded("ENETUNREACH")], "all failed"),
      ).kind,
    ).toBe("unavailable");
  });

  it("may have been billed (timeout) when anything else is in the chain, or nothing says what it was", () => {
    for (const error of [
      coded("ECONNRESET"),
      coded("UND_ERR_SOCKET"),
      coded("ETIMEDOUT"),
      new Error("fetch failed"),
      "a string",
      undefined,
      new TypeError("fetch failed", { cause: coded("ECONNRESET") }),
      new AggregateError([coded("ECONNREFUSED"), coded("ECONNRESET")], "mixed"),
    ]) {
      expect(connectionFailure(error).kind).toBe("timeout");
    }
  });

  it("reads a chain that is deep or loops without end", () => {
    const loop: { code: string; cause?: unknown } = { code: "ECONNREFUSED" };
    loop.cause = loop;
    expect(connectionFailure(loop).kind).toBe("unavailable");
    // A code that is deeper than the reader looks is not seen: it is not taken for a refusal that was.
    let deep: object = coded("ECONNRESET");
    for (let i = 0; i < 5; i++) deep = { cause: deep };
    expect(connectionFailure(new TypeError("x", { cause: deep })).kind).toBe("timeout");
    // A refusal that is at the depth where the reader stops is not seen.
    let edge: object = coded("ECONNREFUSED");
    for (let i = 0; i < 4; i++) edge = { cause: edge };
    expect(connectionFailure(new TypeError("x", { cause: edge })).kind).toBe("timeout");
    // A code that is not text is not a code: it does not hide the ones that are.
    expect(connectionFailure({ code: "ECONNREFUSED", cause: { code: 5 } }).kind).toBe(
      "unavailable",
    );
    let near: object = coded("ECONNREFUSED");
    for (let i = 0; i < 4; i++) near = { cause: near };
    expect(connectionFailure(near).kind).toBe("unavailable");
  });
});

describe("reading a body", () => {
  it("reads text up to the limit, and not a byte past it, whether it says its size or not", async () => {
    expect(await readText(new Response("héllo"), 100)).toBe("héllo");
    expect(await readText(new Response(null), 100)).toBe("");
    expect(await readText(new Response("x".repeat(10)), 10)).toBe("x".repeat(10));
    await expect(readText(new Response("x".repeat(11)), 10)).rejects.toBeInstanceOf(UnusableAnswer);
    const chunked = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
    );
    await expect(readText(chunked, 10)).rejects.toBeInstanceOf(UnusableAnswer);
    // A size that is declared as exactly the limit is not over it.
    const exact = new Response("x".repeat(10), { headers: { "content-length": "10" } });
    expect(await readText(exact, 10)).toBe("x".repeat(10));
    const declared = new Response("small", { headers: { "content-length": "11" } });
    await expect(readText(declared, 10)).rejects.toBeInstanceOf(UnusableAnswer);
  });
});

describe("one request and its answer", () => {
  it("sends one POST with what it was given, never follows a redirect, and returns the text of a 200", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const headers = { authorization: "Bearer a-key" };
    const controller = new AbortController();
    const text = await exchangeWith(
      (url, init) => {
        seen.push({ url, init });
        return respond(200, '{"ok":true}');
      },
      { headers, signal: controller.signal },
    );
    expect(text).toBe('{"ok":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://provider.example/v1/chat");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(seen[0]?.init.body).toBe('{"a":1}');
    expect(seen[0]?.init.headers).toEqual({ authorization: "Bearer a-key" });
    expect(seen[0]?.init.headers).not.toBe(headers);
    expect(seen[0]?.init.signal).toBe(controller.signal);
  });

  it("says what a status was, as one of the four kinds and nothing else", async () => {
    const table: [number, string][] = [
      [429, "rate_limited"],
      [408, "timeout"],
      [504, "timeout"],
      [502, "unavailable"],
      [503, "unavailable"],
      [529, "unavailable"],
      [400, "rejected"],
      [401, "rejected"],
      [403, "rejected"],
      [404, "rejected"],
      [413, "rejected"],
      [301, "rejected"],
      [302, "rejected"],
      [307, "rejected"],
      // A success that is not a 200 is an answer that came, and cannot be used.
      [201, "unusable"],
      [204, "unusable"],
    ];
    for (const [status, kind] of table) {
      expect(await kindOf(exchangeWith(() => respond(status, "the prompt, said back")))).toBe(kind);
    }
  });

  it("never lets what the provider said out: the failure is a kind, with a fixed sentence", async () => {
    const secret = "the prompt, said back by the provider";
    for (const status of [400, 429, 500, 503]) {
      let caught: unknown;
      try {
        await exchangeWith(() => respond(status, secret));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProviderFailure);
      expect(JSON.stringify(caught)).not.toContain(secret);
      expect((caught as Error).message).not.toContain(secret);
    }
  });

  it("asks a 500 what it is, and takes one that cannot be read for a timeout, which may have been billed", async () => {
    const asked: unknown[] = [];
    const says = (answer: "timeout" | "unavailable") => (body: unknown) => {
      asked.push(body);
      return answer;
    };
    expect(
      await kindOf(
        exchangeWith(() => respond(500, '{"error":{"type":"x"}}'), {
          kindOf500: says("unavailable"),
        }),
      ),
    ).toBe("unavailable");
    expect(
      await kindOf(
        exchangeWith(() => respond(500, '{"error":{"type":"x"}}'), { kindOf500: says("timeout") }),
      ),
    ).toBe("timeout");
    expect(asked).toEqual([{ error: { type: "x" } }, { error: { type: "x" } }]);
    // Not JSON, empty, too large, or a question that cannot be answered: not asked, or not answered.
    const never = (): "unavailable" => {
      throw new Error("must not be asked");
    };
    for (const body of ["<html>", "", "x".repeat(70_000)]) {
      expect(await kindOf(exchangeWith(() => respond(500, body), { kindOf500: never }))).toBe(
        "timeout",
      );
    }
    expect(await kindOf(exchangeWith(() => respond(500, "{}"), { kindOf500: never }))).toBe(
      "timeout",
    );
    // A body that is JSON, and larger than what is read of an error (64 KiB), is not read: it is a timeout.
    const large = `{"error":{"type":"x","pad":"${"x".repeat(70_000)}"}}`;
    expect(
      await kindOf(exchangeWith(() => respond(500, large), { kindOf500: () => "unavailable" })),
    ).toBe("timeout");
    const small = `{"error":{"type":"x","pad":"${"x".repeat(60_000)}"}}`;
    expect(
      await kindOf(exchangeWith(() => respond(500, small), { kindOf500: () => "unavailable" })),
    ).toBe("unavailable");
    // A status that is not 500 does not ask.
    expect(await kindOf(exchangeWith(() => respond(503, "{}"), { kindOf500: never }))).toBe(
      "unavailable",
    );
  });

  it("tells a request that never left from one that may have been billed", async () => {
    const never = () =>
      Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    const dropped = () =>
      Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    expect(await kindOf(exchangeWith(never))).toBe("unavailable");
    expect(await kindOf(exchangeWith(dropped))).toBe("timeout");
  });

  it("lets the gateway tell a call it gave up on: the error of an aborted call is not changed", async () => {
    const controller = new AbortController();
    const reason = new Error("given up on");
    controller.abort(reason);
    let caught: unknown;
    try {
      await exchangeWith(() => Promise.reject(reason), { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  it("is a timeout when the connection drops while the answer comes, and unusable when it is too large", async () => {
    const dropping = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("socket hang up"));
            },
          }),
          { status: 200 },
        ),
      );
    expect(await kindOf(exchangeWith(dropping))).toBe("timeout");
    // Four mebibytes, written out here so that a change of the limit is a change of this test.
    const wall = 4 * 1_048_576;
    expect(MAX_BODY_BYTES).toBe(wall);
    expect(await kindOf(exchangeWith(() => respond(200, "x".repeat(wall + 1))))).toBe("unusable");
    expect(await kindOf(exchangeWith(() => respond(200, "x".repeat(wall))))).toBe("none");
  });

  it("lets a drop that the gateway caused through as it was", async () => {
    const controller = new AbortController();
    const send = () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          controller.abort();
          throw new Error("aborted");
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    expect(await kindOf(exchangeWith(send, { signal: controller.signal }))).toBe("other");
  });
});
