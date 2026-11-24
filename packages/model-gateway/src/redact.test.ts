import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

// Secret-like strings are made here from pieces, so that no whole one is in the repository, where the
// secret scanner would (rightly) take it for a real one.
const join = (...parts: string[]): string => parts.join("");
const awsKey = join("AK", "IA", "IOSFODNN7", "EXAMPLE");
const githubToken = join("gh", "p_", "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5");
const jwt = join(
  "ey",
  "JhbGciOiJIUzI1NiJ9",
  ".",
  "ey",
  "JzdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dBjftJeZ4CVPmB92K27uhbUJU1p1r",
);
const pemBegin = join("-----BEGIN ", "RSA PRIVATE KEY", "-----");
const pemEnd = join("-----END ", "RSA PRIVATE KEY", "-----");

describe("redacting what looks like a secret", () => {
  it("removes a private key, from its first line to its last, and keeps the text around it", () => {
    const text = `before\n${pemBegin}\nMIIEowIBAAKCAQEA\nabcdef\n${pemEnd}\nafter`;
    const result = redact(text);
    expect(result.text).toBe("before\n[redacted:private_key]\nafter");
    expect(result.total).toBe(1);
  });

  it("removes every key of several, and each kind of header", () => {
    const other = (kind: string): string =>
      `${join("-----BEGIN ", kind, "-----")}\nxx\n${join("-----END ", kind, "-----")}`;
    const result = redact(
      `${other("PRIVATE KEY")} and ${other("OPENSSH PRIVATE KEY")} and ${other("ENCRYPTED PRIVATE KEY")}`,
    );
    expect(result.text).toBe(
      "[redacted:private_key] and [redacted:private_key] and [redacted:private_key]",
    );
    expect(result.total).toBe(3);
  });

  it("takes the rest of the text when a key begins and never ends, because a part of a key is a key", () => {
    const result = redact(`head\n${pemBegin}\nMIIEowIBAAKCAQEA\nmore text that is not the key`);
    expect(result.text).toBe("head\n[redacted:private_key]");
    expect(result.total).toBe(1);
  });

  it("leaves an end line with no beginning alone, and a public key", () => {
    const text = `${pemEnd}\n${join("-----BEGIN ", "PUBLIC KEY", "-----")}\nabc\n${join("-----END ", "PUBLIC KEY", "-----")}`;
    expect(redact(text)).toEqual({ text, total: 0 });
  });

  it("removes the password of a URL and keeps the rest of it", () => {
    const url = join("postgres", "://", "app", ":", "hunter2hunter2", "@db.internal:5432/shop");
    const result = redact(`DATABASE_URL is ${url} for the app`);
    expect(result.text).toBe(
      "DATABASE_URL is postgres://[redacted:url_credentials]@db.internal:5432/shop for the app",
    );
    expect(result.total).toBe(1);
  });

  it("leaves a URL with no password", () => {
    const text = "see https://example.com/docs and ssh://git@github.com/acme/shop.git";
    expect(redact(text)).toEqual({ text, total: 0 });
  });

  it("removes a cloud access key, a GitHub token, a JWT and a bearer token", () => {
    const bearer = join("Bear", "er ", "abcdEFGH1234ijklMNOP5678");
    const result = redact(`a ${awsKey} b ${githubToken} c ${jwt} d ${bearer} e`);
    expect(result.text).toBe(
      "a [redacted:cloud_access_key] b [redacted:token] c [redacted:token] d Bearer [redacted:token] e",
    );
    expect(result.total).toBe(4);
  });

  it("removes the value that a name which says it is secret is given, and keeps the name", () => {
    const quoted = `${join("pass", "word")} = "${join("Zx81qLm20", "pQw93")}"`;
    expect(redact(quoted).text).toBe(`${join("pass", "word")} = "[redacted:assignment]"`);
    const header = `${join("api_", "key")}: ${join("k3y", "9f8e7d6c5b4a")}`;
    expect(redact(header).text).toBe(`${join("api_", "key")}: [redacted:assignment]`);
    const client = `${join("CLIENT_", "SECRET")}=${join("abcd1234", "efgh5678")}`;
    expect(redact(client).text).toBe(`${join("CLIENT_", "SECRET")}=[redacted:assignment]`);
  });

  it("leaves code that only mentions secrets: no value that looks like one", () => {
    for (const text of [
      "const token = tokens.next();",
      "if (!password) throw new Error('password required');",
      "const secretName = process.env.SECRET_NAME;",
      "token: string;",
      "password = readPassword()",
    ]) {
      expect(redact(text)).toEqual({ text, total: 0 });
    }
  });

  it("counts what it removed in all, and gives text with none of it", () => {
    const text = `${awsKey} ${awsKey} ${githubToken}`;
    const result = redact(text);
    expect(result.total).toBe(3);
    expect(result.text).not.toContain(awsKey);
    expect(result.text).not.toContain(githubToken);
  });

  it("is the same text again when nothing is found, and does nothing to empty text", () => {
    expect(redact("")).toEqual({ text: "", total: 0 });
    expect(redact("plain text, 12345")).toEqual({ text: "plain text, 12345", total: 0 });
  });

  it("takes about as long as the text is long, whatever the text is made to be", () => {
    const size = 1_000_000;
    const hostile = [
      `${pemBegin}\n`.repeat(Math.ceil(size / (pemBegin.length + 1))),
      "password".repeat(size / 8),
      `${pemBegin} `.repeat(1000) + "x".repeat(size - 40_000),
      `a://${"b".repeat(100)}`.repeat(size / 105),
      `${"b".repeat(100)}:`.repeat(size / 101),
      "Bearer ".concat("a".repeat(size)),
      "ey".concat("J".repeat(size)),
      `token=${"1".repeat(size)}`,
    ];
    for (const text of hostile) {
      const started = performance.now();
      redact(text);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });
});
