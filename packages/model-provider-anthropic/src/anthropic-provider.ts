import type { Secret } from "@codemugs/configuration";
import {
  ProviderFailure,
  type DataClass,
  type ModelProvider,
  type ProviderPrice,
  type ProviderRequest,
  type ProviderResponse,
} from "@codemugs/model-gateway";
import { z } from "zod";
import { toProviderSchema } from "./schema.js";

/**
 * An adapter for the Anthropic Messages API (ADR 0043), behind the model gateway.
 *
 * It sends one request and reads one answer. It does not retry, fail over, count money or decide
 * what may be sent: the gateway does those (ADR 0039 to 0042). It holds the API key, and the only
 * ways that the key leaves it are the header of the request to the provider and nothing else: an
 * error that it throws is a kind (`ProviderFailure`) or a fixed sentence, never what the provider
 * said, which can contain the prompt.
 */

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The version of the API that this adapter is written for. */
export const DEFAULT_API_VERSION = "2026-10-21";

/** What an answer may weigh. The longest answer is a few thousand tokens; this is a wall, not a target. */
const MAX_BODY_BYTES = 4 * 1_048_576;
/** What is read of an error, to tell one kind of 500 from another. */
const MAX_ERROR_BYTES = 65_536;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}$/;
/** Printable ASCII with no space: a key that cannot add a header to the request. */
const KEY = /^[\x21-\x7e]{16,512}$/;

export interface AnthropicProviderOptions {
  /** The API key, for a workspace that is for CodeMugs and has a spend limit of its own. */
  readonly apiKey: Secret;
  /** The model's name, as the provider spells it. */
  readonly model: string;
  /**
   * What the model costs, in whole millionths of a US dollar for a million tokens. **Required and
   * never guessed**: the budgets are worked out from it. Take it from the provider's price list.
   */
  readonly price: ProviderPrice;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /**
   * The classes of data that this key's terms allow the provider to be sent (ADR 0044). Absent means that
   * the organisation's policy alone decides. A deployment that is on terms that let the provider use or
   * read what it is sent lists little or nothing.
   */
  readonly dataClasses?: readonly DataClass[];
  /** The name that the gateway, the ledger and the log know it by. Default `anthropic`. */
  readonly name?: string;
  /** Must be https, or http on this machine (for tests). Default: the provider's own. */
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const Usage = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  })
  .loose();

const Message = z
  .object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
    stop_reason: z.string().nullish(),
    usage: Usage,
  })
  .loose();

const ErrorBody = z.object({ error: z.object({ type: z.string().optional() }).loose() }).loose();

/** Used for an answer that came, and was probably billed, and is not one: the gateway charges the worst case for it. */
class UnusableAnswer extends Error {
  constructor() {
    super("the provider's answer could not be used");
    this.name = "UnusableAnswer";
  }
}

function checkedBaseUrl(text: string): string {
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

function isCount(value: number, min: number): boolean {
  return Number.isSafeInteger(value) && value >= min;
}

function checkOptions(options: AnthropicProviderOptions, key: string): void {
  const { price } = options;
  if (
    !KEY.test(key) ||
    !MODEL.test(options.model) ||
    !isCount(price.inputMicrosPerMillionTokens, 0) ||
    !isCount(price.outputMicrosPerMillionTokens, 0) ||
    !isCount(options.maxContextTokens, 1) ||
    !isCount(options.maxOutputTokens, 1) ||
    (options.name !== undefined && !NAME.test(options.name)) ||
    (options.apiVersion !== undefined && !API_VERSION.test(options.apiVersion))
  ) {
    throw new RangeError("the model provider's settings are not valid");
  }
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
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || seen.has(value) || depth > 4) return;
    seen.add(value);
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

function connectionFailure(error: unknown): ProviderFailure {
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
async function readText(response: Response, maxBytes: number): Promise<string> {
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

/** What a status that is not a success says, which is one of the four kinds and nothing else. */
async function failureFor(response: Response): Promise<ProviderFailure> {
  const { status } = response;
  if (status === 500) {
    // The provider also answers a request that ran out of time with a 500.
    let type: string | undefined;
    try {
      const parsed = ErrorBody.safeParse(JSON.parse(await readText(response, MAX_ERROR_BYTES)));
      type = parsed.success ? parsed.data.error.type : undefined;
    } catch {
      type = undefined;
    }
    return new ProviderFailure(type === "timeout_error" ? "timeout" : "unavailable");
  }
  await response.body?.cancel().catch(() => undefined);
  if (status === 429) return new ProviderFailure("rate_limited");
  if (status === 408 || status === 504) return new ProviderFailure("timeout");
  if (status >= 500) return new ProviderFailure("unavailable");
  // A refused request: a bad key, a spend limit, a request that is too large, a redirect (which is
  // never followed: it would take the key to wherever it points), and anything else that is a 4xx.
  return new ProviderFailure("rejected");
}

function finishOf(reason: string | null | undefined): ProviderResponse["finish"] {
  if (reason === "refusal") return "refused";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  return "stop";
}

function responseFrom(body: string): ProviderResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new UnusableAnswer();
  }
  const parsed = Message.safeParse(json);
  if (!parsed.success) throw new UnusableAnswer();
  const { content, stop_reason: reason, usage } = parsed.data;
  // Tokens that were read from or written to a cache are billed, at other rates, and are input. This
  // adapter does not use a cache; counting them as input at the full rate can only over-charge.
  const inputTokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) throw new UnusableAnswer();
  return {
    text: content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join(""),
    inputTokens,
    outputTokens: usage.output_tokens,
    finish: finishOf(reason),
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  // The key is read once, here, and stays in this closure: it is not a property of what is returned.
  const key = options.apiKey.reveal();
  checkOptions(options, key);
  const base = checkedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const version = options.apiVersion ?? DEFAULT_API_VERSION;
  const send = options.fetch ?? globalThis.fetch;
  const model = options.model;

  return {
    name: options.name ?? "anthropic",
    model,
    capabilities: {
      maxContextTokens: options.maxContextTokens,
      maxOutputTokens: options.maxOutputTokens,
      structuredOutput: "native",
      ...(options.dataClasses === undefined ? {} : { dataClasses: [...options.dataClasses] }),
    },
    price: {
      inputMicrosPerMillionTokens: options.price.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: options.price.outputMicrosPerMillionTokens,
    },

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      // Before anything is sent: a schema that cannot be sent as it means is refused, and bills nothing.
      const schema = toProviderSchema(request.jsonSchema);
      let response: Response;
      try {
        response = await send(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": version,
            "user-agent": "codemugs",
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            output_config: { format: { type: "json_schema", schema } },
          }),
          redirect: "manual",
          signal: request.signal,
        });
      } catch (error) {
        // The gateway looks at the signal itself to tell a call that was given up on from one that failed.
        if (request.signal.aborted) throw error;
        throw connectionFailure(error);
      }

      if (response.status !== 200) {
        if (response.status >= 200 && response.status < 300) {
          await response.body?.cancel().catch(() => undefined);
          throw new UnusableAnswer();
        }
        throw await failureFor(response);
      }

      let body: string;
      try {
        body = await readText(response, MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof UnusableAnswer || request.signal.aborted) throw error;
        // The connection dropped while the answer came: it was sent and may have been billed.
        throw new ProviderFailure("timeout");
      }
      return responseFrom(body);
    },
  };
}
