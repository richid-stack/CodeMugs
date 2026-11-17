import { createPublicKey, verify } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { GitHubError } from "./errors.js";
import { createAppJwt } from "./jwt.js";
import {
  CLIENT_ID,
  ecKeyPem,
  otherKeys,
  pkcs8KeyPem,
  rsaPssKeyPem,
  secretOf,
  smallRsaKeyPem,
  testKeys,
  FAKE_CLIENT_SECRET,
} from "./test-harness.js";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const seconds = NOW / 1000;

const parts = (jwt: string) => {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>,
    signed: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, "base64url"),
  };
};

const make = (pem: string = testKeys().privatePem) =>
  createAppJwt({ clientId: CLIENT_ID, privateKey: secretOf(pem), now: () => NOW });

describe("createAppJwt", () => {
  it("says who the app is, from a minute ago until nine minutes from now", () => {
    const { header, claims } = parts(make().reveal());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: CLIENT_ID });
  });

  it("expires within the ten minutes that GitHub allows", () => {
    const { claims } = parts(make().reveal());
    expect((claims["exp"] as number) - seconds).toBeLessThanOrEqual(600);
    expect((claims["iat"] as number) < seconds).toBe(true);
  });

  it("is signed with the private key, and only that key's public half verifies it", () => {
    const { signed, signature } = parts(make().reveal());
    const check = (publicPem: string) =>
      verify("RSA-SHA256", signed, createPublicKey(publicPem), signature);
    expect(check(testKeys().publicPem)).toBe(true);
    expect(check(otherKeys().publicPem)).toBe(false);
  });

  it("takes a key in PKCS#8 form as well as the PKCS#1 form that GitHub gives", () => {
    expect(make(pkcs8KeyPem()).reveal().split(".")).toHaveLength(3);
  });

  it("uses the clock when it is not given one", () => {
    const before = Math.floor(Date.now() / 1000);
    const { claims } = parts(
      createAppJwt({ clientId: CLIENT_ID, privateKey: secretOf(testKeys().privatePem) }).reveal(),
    );
    const after = Math.floor(Date.now() / 1000);
    expect(claims["iat"]).toBeGreaterThanOrEqual(before - 60);
    expect(claims["iat"]).toBeLessThanOrEqual(after - 60);
    expect(claims["exp"]).toBeGreaterThanOrEqual(before + 540);
  });

  it("cannot be printed by accident", () => {
    const jwt = make();
    const text = jwt.reveal();
    for (const shown of [String(jwt), JSON.stringify(jwt), inspect(jwt), `${jwt.toString()}`]) {
      expect(shown).not.toContain(text);
      expect(shown).not.toContain(text.split(".")[1]);
    }
  });
});

describe("a key that is not usable", () => {
  const clientSecret = FAKE_CLIENT_SECRET;
  const cases: readonly (readonly [string, () => string])[] = [
    ["a client secret, which is what was pasted by mistake", () => clientSecret],
    ["nothing", () => ""],
    [
      "text that only looks like a key",
      () => "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----",
    ],
    ["a public key", () => testKeys().publicPem],
    ["a key of another kind (elliptic curve)", ecKeyPem],
    ["an RSA key that is too small (1,024 bits)", smallRsaKeyPem],
    ["an RSA-PSS key, which is RSA but is not signed the way that GitHub reads", rsaPssKeyPem],
  ];

  it.each(cases)("is refused as key_invalid: %s", (_name, pem) => {
    const input = pem();
    let caught: unknown;
    try {
      make(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubError);
    const error = caught as GitHubError;
    expect(error.code).toBe("key_invalid");
    // What was given is not in what is said, and what is said tells how to put it right.
    if (input !== "") expect(error.message).not.toContain(input.slice(0, 20));
    expect(error.message).toContain("client secret");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(clientSecret);
  });

  it("does not make a token from a refused key", () => {
    expect(() => make(clientSecretLike())).toThrow(GitHubError);
  });
});

const clientSecretLike = (): string => FAKE_CLIENT_SECRET;
