import { ProviderFailure } from "@codemugs/model-gateway";

/**
 * What every adapter for a provider that is reached over HTTPS shares (ADR 0045): how a request is
 * sent and how what comes back is told apart. It knows nothing of any provider's request or answer.
 *
 * It holds no key. The caller gives it the headers, and the only place they go is the request: an
 * error that it throws is a kind (`ProviderFailure`) or a fixed sentence, never what the provider said,
 * which can contain the prompt.
 */

/** What an answer may weigh. The longest answer is a few thousand tokens; this is a wall, not a target. */
export const MAX_BODY_BYTES = 4 * 1_048_576;
/** What is read of an error, to tell one kind of 500 from another. */
const MAX_ERROR_BYTES = 65_536;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** The same, for a provider that names a model by a path (`vendor/model`), which goes in the body and nowhere else. */
const MODEL_PATH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,99})?$/;
/** Printable ASCII with no space: a key that cannot add a header to the request. */
const KEY = /^[\x21-\x7e]{16,512}$/;

export const isName = (text: string): boolean => NAME.test(text);
export const isModel = (text: string): boolean => MODEL.test(text);
export const isModelPath = (text: string): boolean => MODEL_PATH.test(text);
export const isKey = (text: string): boolean => KEY.test(text);

/** A whole number of at least `min`. */
export function isCount(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

/** Used for an answer that came, and was probably billed, and is not one: the gateway charges the worst case for it. */
export class UnusableAnswer extends Error {
  constructor() {
    super("the provider's answer could not be used");
    this.name = "UnusableAnswer";
  }
}

/** The address of a provider: https, or http on this machine (for tests), with nothing in it that is not a place. */
export function checkedBaseUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError("the provider's address is not valid");
  }
  const local = LOOPBACK.has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new RangeError("the provider's address is not valid");
  }
  return url.href.replace(/\/$/, "");
}

/**
 * Failures of the connection. A request that never left (the name was not found, the connection was
 * refused, the certificate was not trusted) cannot have been billed. Any other (a connection that
 * dropped once the request was sent) may have been, so it is a timeout, which the gateway charges for.
 */
const NEVER_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INVALID_URL",
]);

function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  // A chain that loops is cut short by the depth, as one that is long is.
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || depth > 4) return;
    const { code, cause, errors } = value as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === "string") codes.push(code);
    visit(cause, depth + 1);
    if (Array.isArray(errors)) for (const inner of errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return codes;
}

export function connectionFailure(error: unknown): ProviderFailure {
  const codes = causeCodes(error);
  const neverSent =
    codes.length > 0 &&
    codes.every(
      (code) =>
        NEVER_SENT.has(code) ||
        code.startsWith("ERR_TLS") ||
        code.startsWith("ERR_SSL") ||
        code.startsWith("CERT_") ||
        code.startsWith("UNABLE_TO_") ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "ERR_OSSL_BAD_DECRYPT",
    );
  return new ProviderFailure(neverSent ? "unavailable" : "timeout");
}

/** The body, read up to a limit, as untrusted text. */
export async function readText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new UnusableAnswer();
  }
  if (response.body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UnusableAnswer();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface Exchange {
  readonly send: typeof globalThis.fetch;
  readonly url: string;
  /** Including the key, which goes nowhere else. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The gateway's: it is looked at to tell a call that was given up on from one that failed. */
  readonly signal: AbortSignal;
  /**
   * Whether a 500 whose body parsed as JSON ran out of time (`timeout`, which may have been billed) or
   * broke (`unavailable`). Each provider says it in its own way. A body that cannot be read at all is not
   * asked about: it cannot rule a timeout out, so it is one.
   */
  readonly kindOf500: (body: unknown) => "timeout" | "unavailable";
}

/** What a status that is not a success says, which is one of the four kinds and nothing else. */
async function failureFor(
  response: Response,
  kindOf500: Exchange["kindOf500"],
): Promise<ProviderFailure> {
  const { status } = response;
  if (status === 500) {
    // Some providers also answer a request that ran out of time with a 500, and that one may have been
    // billed. A body that cannot be read or has no type cannot rule it out, so it is not taken for a
    // plain failure.
    let kind: "timeout" | "unavailable";
    try {
      kind = kindOf500(JSON.parse(await readText(response, MAX_ERROR_BYTES)));
    } catch {
      kind = "timeout";
    }
    return new ProviderFailure(kind);
  }
  await response.body?.cancel().catch(() => undefined);
  if (status === 429) return new ProviderFailure("rate_limited");
  if (status === 408 || status === 504) return new ProviderFailure("timeout");
  if (status >= 500) return new ProviderFailure("unavailable");
  // A refused request: a bad key, a spend limit, a request that is too large, a redirect (which is
  // never followed: it would take the key to wherever it points), and anything else that is a 4xx.
  return new ProviderFailure("rejected");
}

/**
 * One POST and its answer's text, or a `ProviderFailure` of the kind that the failure was, or
 * `UnusableAnswer` for an answer that came (and was probably billed) and cannot be used.
 */
export async function exchange(x: Exchange): Promise<string> {
  let response: Response;
  try {
    response = await x.send(x.url, {
      method: "POST",
      headers: { ...x.headers },
      body: x.body,
      // A redirect would take the key to wherever it points: fetch keeps the headers across one.
      redirect: "manual",
      signal: x.signal,
    });
  } catch (error) {
    // The gateway looks at the signal itself to tell a call that was given up on from one that failed.
    if (x.signal.aborted) throw error;
    throw connectionFailure(error);
  }

  if (response.status !== 200) {
    if (response.status >= 200 && response.status < 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new UnusableAnswer();
    }
    throw await failureFor(response, x.kindOf500);
  }

  try {
    return await readText(response, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof UnusableAnswer || x.signal.aborted) throw error;
    // The connection dropped while the answer came: it was sent and may have been billed.
    throw new ProviderFailure("timeout");
  }
}
