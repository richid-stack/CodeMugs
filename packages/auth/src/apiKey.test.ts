import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  hashSecret,
  isOrganisationId,
  parseApiKey,
  secretMatches,
} from "./apiKey.js";

describe("generateApiKey and parseApiKey", () => {
  it("round-trips the organisation, the key id and a secret that matches the stored hash", () => {
    const organisationId = randomUUID();
    const generated = generateApiKey(organisationId);
    const parsed = parseApiKey(generated.key);

    expect(parsed).toBeDefined();
    expect(parsed?.organisationId).toBe(organisationId);
    expect(parsed?.keyId).toBe(generated.keyId);
    expect(secretMatches(parsed?.secret ?? "", generated.secretHash)).toBe(true);
  });

  it("has a fixed shape and length", () => {
    const { key } = generateApiKey(randomUUID());
    expect(key).toMatch(/^cmk_[0-9a-f]{32}_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(113);
  });

  it("never repeats a secret or a key id", () => {
    const organisationId = randomUUID();
    const keys = Array.from({ length: 2000 }, () => generateApiKey(organisationId));
    expect(new Set(keys.map((k) => k.key)).size).toBe(2000);
    expect(new Set(keys.map((k) => k.keyId)).size).toBe(2000);
  });

  it("does not put the secret in anything that is meant to be stored", () => {
    const generated = generateApiKey(randomUUID());
    const secret = generated.key.slice(-43);
    expect(generated.keyId).not.toContain(secret);
    expect(generated.secretHash).toHaveLength(32);
    expect(generated.secretHash.toString("hex")).not.toContain(secret);
  });

  it("writes an upper-case organisation id in lower case", () => {
    const organisationId = randomUUID();
    const { key } = generateApiKey(organisationId.toUpperCase());
    expect(parseApiKey(key)?.organisationId).toBe(organisationId);
  });

  it.each(["", "not-a-uuid", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", `${randomUUID()}x`])(
    "refuses to make a key for the organisation id %j, without echoing it",
    (value) => {
      let message = "";
      try {
        generateApiKey(value);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toMatch(/organisationId must be a UUID/);
      if (value.length > 0) expect(message).not.toContain(value);
    },
  );
});

describe("parseApiKey rejects anything that is not exactly a key", () => {
  // Cut at fixed positions: the secret may contain underscores, so splitting on "_" would
  // truncate it and make the rejections below pass for the wrong reason.
  const valid = generateApiKey(randomUUID()).key;
  const prefix = valid.slice(0, 3);
  const organisation = valid.slice(4, 36);
  const keyId = valid.slice(37, 69);
  const secret = valid.slice(70);

  it("starts from a key that is itself valid, so each rejection below is about one change", () => {
    expect(`${prefix}_${organisation}_${keyId}_${secret}`).toBe(valid);
    expect(secret).toHaveLength(43);
    expect(parseApiKey(valid)).toBeDefined();
  });

  it.each([
    ["an empty string", ""],
    ["a space", " "],
    ["leading whitespace", ` ${valid}`],
    ["trailing whitespace", `${valid} `],
    ["a trailing newline", `${valid}\n`],
    ["a Bearer prefix", `Bearer ${valid}`],
    ["a different prefix", `cmx_${organisation}_${keyId}_${secret}`],
    ["an upper-case prefix", `CMK_${organisation}_${keyId}_${secret}`],
    ["a missing segment", `${prefix}_${organisation}_${secret}`],
    ["an extra segment", `${valid}_extra`],
    ["a secret one character short", `${prefix}_${organisation}_${keyId}_${secret.slice(1)}`],
    ["a secret one character long", `${prefix}_${organisation}_${keyId}_${secret}a`],
    ["a secret with a plus", `${prefix}_${organisation}_${keyId}_${secret.slice(1)}+`],
    ["a secret with a slash", `${prefix}_${organisation}_${keyId}_${secret.slice(1)}/`],
    ["a secret with padding", `${prefix}_${organisation}_${keyId}_${secret.slice(1)}=`],
    ["an upper-case organisation id", `${prefix}_${organisation.toUpperCase()}_${keyId}_${secret}`],
    ["a non-hex organisation id", `${prefix}_${"z".repeat(32)}_${keyId}_${secret}`],
    [
      "an organisation id with no valid UUID version",
      `${prefix}_${"a".repeat(32)}_${keyId}_${secret}`,
    ],
    ["a nil organisation id", `${prefix}_${"0".repeat(32)}_${keyId}_${secret}`],
    ["a non-hex key id", `${prefix}_${organisation}_${"g".repeat(32)}_${secret}`],
    ["a null byte", `${valid.slice(0, 50)}\u0000${valid.slice(51)}`],
    ["non-ASCII look-alikes", valid.replace("c", "с")],
    ["a very long value", "a".repeat(100_000)],
  ])("%s", (_label, presented) => {
    expect(parseApiKey(presented)).toBeUndefined();
  });

  it("never throws, whatever it is given", () => {
    for (let index = 0; index < 3000; index += 1) {
      const length = Math.floor(Math.random() * 200);
      const noise = randomBytes(length).toString("latin1");
      expect(() => parseApiKey(noise)).not.toThrow();
      expect(parseApiKey(noise)).toBeUndefined();
    }
  });
});

describe("hashSecret and secretMatches", () => {
  it("hashes deterministically to 32 bytes, and differently for different secrets", () => {
    expect(hashSecret("one")).toHaveLength(32);
    expect(hashSecret("one").equals(hashSecret("one"))).toBe(true);
    expect(hashSecret("one").equals(hashSecret("two"))).toBe(false);
  });

  it("matches only the right secret", () => {
    const stored = hashSecret("right");
    expect(secretMatches("right", stored)).toBe(true);
    expect(secretMatches("wrong", stored)).toBe(false);
    expect(secretMatches("", stored)).toBe(false);
  });

  it("treats a stored value of the wrong length as a mismatch instead of throwing", () => {
    expect(secretMatches("right", Buffer.alloc(31))).toBe(false);
    expect(secretMatches("right", Buffer.alloc(0))).toBe(false);
    expect(secretMatches("right", Buffer.alloc(33))).toBe(false);
  });
});

describe("isOrganisationId", () => {
  it("accepts the ids this system creates and rejects other shapes", () => {
    expect(isOrganisationId(randomUUID())).toBe(true);
    expect(isOrganisationId(randomUUID().toUpperCase())).toBe(true);
    expect(isOrganisationId("")).toBe(false);
    expect(isOrganisationId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
    expect(isOrganisationId(`${randomUUID()} `)).toBe(false);
  });
});
