import type { Secret } from "@codemugs/configuration";
import {
  type DataClass,
  type ModelProvider,
  type ProviderPrice,
  type ProviderRequest,
  type ProviderResponse,
} from "@codemugs/model-gateway";
import {
  UnusableAnswer,
  checkedBaseUrl,
  exchange,
  isCount,
  isKey,
  isModel,
  isName,
} from "@codemugs/model-provider-http";
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

const API_VERSION = /^\d{4}-\d{2}-\d{2}$/;

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

function checkOptions(options: AnthropicProviderOptions, key: string): void {
  const { price } = options;
  if (
    !isKey(key) ||
    !isModel(options.model) ||
    !isCount(price.inputMicrosPerMillionTokens, 0) ||
    !isCount(price.outputMicrosPerMillionTokens, 0) ||
    !isCount(options.maxContextTokens, 1) ||
    !isCount(options.maxOutputTokens, 1) ||
    (options.name !== undefined && !isName(options.name)) ||
    (options.apiVersion !== undefined && !API_VERSION.test(options.apiVersion))
  ) {
    throw new RangeError("the model provider's settings are not valid");
  }
}

/** The provider also answers a request that ran out of time with a 500; any other type that says what it is, is a plain failure. */
function kindOf500(body: unknown): "timeout" | "unavailable" {
  const parsed = ErrorBody.safeParse(body);
  const type = parsed.success ? parsed.data.error.type : undefined;
  return type === undefined || type === "timeout_error" ? "timeout" : "unavailable";
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
      const body = await exchange({
        send,
        url: `${base}/v1/messages`,
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
        signal: request.signal,
        kindOf500,
      });
      return responseFrom(body);
    },
  };
}
