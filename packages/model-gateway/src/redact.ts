export type SecretKind =
  "private_key" | "url_credentials" | "cloud_access_key" | "token" | "assignment";

export interface Redaction {
  readonly text: string;
  /** How many strings were replaced, in all. Never what they were. */
  readonly total: number;
}

/**
 * Private keys, found by looking for the line that begins one and then the line that ends it, and not
 * by one pattern over the whole text: a pattern that spans text can take time that grows with its
 * square when the text holds many beginnings and no end. A beginning with no end takes the rest of
 * the text, because a part of a key is a key.
 */
function removePrivateKeys(text: string): Redaction {
  const begin = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const end = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
  const pieces: string[] = [];
  let total = 0;
  let at = 0;
  for (;;) {
    begin.lastIndex = at;
    const found = begin.exec(text);
    if (found === null) break;
    pieces.push(text.slice(at, found.index), "[redacted:private_key]");
    total += 1;
    end.lastIndex = found.index + found[0].length;
    const last = end.exec(text);
    if (last === null) {
      at = text.length;
      break;
    }
    at = last.index + last[0].length;
  }
  pieces.push(text.slice(at));
  return { text: pieces.join(""), total };
}

interface Rule {
  readonly kind: Exclude<SecretKind, "private_key">;
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Every quantifier is bounded, and nothing nests, so that the time is linear in the text (this runs
// over text that a customer wrote).
const RULES: readonly Rule[] = [
  {
    kind: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:/@]{1,100}:[^\s/@]{1,200}@/gi,
    replacement: "$1[redacted:url_credentials]@",
  },
  {
    kind: "cloud_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[redacted:cloud_access_key]",
  },
  {
    kind: "token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255}|xox[abprs]-[A-Za-z0-9-]{10,200}|sk-[A-Za-z0-9_-]{20,200})\b/g,
    replacement: "[redacted:token]",
  },
  {
    kind: "token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,500}\.eyJ[A-Za-z0-9_-]{8,500}\.[A-Za-z0-9_-]{8,500}/g,
    replacement: "[redacted:token]",
  },
  {
    kind: "token",
    pattern: /\b(Bearer\s{1,5})[A-Za-z0-9._~+/-]{16,500}=*/gi,
    replacement: "$1[redacted:token]",
  },
  {
    // A name that says that it is a secret, then `=` or `:`, then a value that looks like one: only
    // characters of a key and at least one digit, so that `token = tokens.next` is left as code.
    kind: "assignment",
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_-]{0,20}["']?\s{0,5}[:=]\s{0,5}["']?)(?=[A-Za-z0-9+/=_.~-]{0,200}\d)[A-Za-z0-9+/=_.~-]{12,200}/gi,
    replacement: "$1[redacted:assignment]",
  },
];

/**
 * Takes out what looks like a secret from text that is about to be sent to a model: a private key,
 * a password in a URL, a cloud access key, a token and the value of a name that says it is secret.
 * **It is a second line and not a guarantee.** The rule is that no secret is put in a request (the
 * analysis keeps names and never values, [ADR 0024](../../../docs/architecture/decisions/0024-repository-analysis.md)),
 * and this catches the careless case; a secret that does not look like one passes. It is applied to
 * data before it is sent, not to what comes back.
 */
export function redact(text: string): Redaction {
  const keys = removePrivateKeys(text);
  let current = keys.text;
  let total = keys.total;
  for (const rule of RULES) {
    const count = [...current.matchAll(rule.pattern)].length;
    if (count === 0) continue;
    total += count;
    current = current.replace(rule.pattern, rule.replacement);
  }
  return { text: current, total };
}
