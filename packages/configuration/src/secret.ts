import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * Holds a secret value (a connection string with a password, a token) so it cannot be printed,
 * logged or serialised by accident. Printing, string conversion, `JSON.stringify` and
 * `util.inspect` all give "[redacted]". The only way to get the value is the explicit
 * `reveal()`, which makes every use easy to find in review.
 *
 * This guards against mistakes such as logging a whole configuration object (repository
 * invariant 3). It does not stop code that calls `reveal()` and then prints the result.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
