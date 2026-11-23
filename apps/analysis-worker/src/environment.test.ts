import { describe, expect, it } from "vitest";
import { ConfigError } from "@codemugs/configuration";
import { SECRET_VARIABLES, forgetSecrets, takeConfig } from "./environment.js";
import { testPrivateKey, validEnvironment } from "./test-support.js";

describe("forgetSecrets", () => {
  it("removes the GitHub key and both database addresses, and nothing else", () => {
    const env: Record<string, string | undefined> = {
      CODEMUGS_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      DATABASE_URL: "postgres://a:b@c/d",
      DISPATCHER_DATABASE_URL: "postgres://e:f@c/d",
      PATH: "/usr/bin",
      LOG_LEVEL: "info",
      CODEMUGS_GITHUB_APP_CLIENT_ID: "Iv23lipC397du816RxiY",
    };
    const removed = forgetSecrets(env);
    expect([...removed].sort()).toEqual([...SECRET_VARIABLES].sort());
    expect(env).toEqual({
      PATH: "/usr/bin",
      LOG_LEVEL: "info",
      CODEMUGS_GITHUB_APP_CLIENT_ID: "Iv23lipC397du816RxiY",
    });
  });

  it("does nothing, and says so, when there is nothing to remove", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(forgetSecrets(env)).toEqual([]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("names exactly the variables that the configuration reads as secrets", () => {
    expect([...SECRET_VARIABLES].sort()).toEqual(
      ["CODEMUGS_GITHUB_APP_PRIVATE_KEY", "DATABASE_URL", "DISPATCHER_DATABASE_URL"].sort(),
    );
  });
});

describe("takeConfig", () => {
  it("gives the settings, and leaves the environment without the secrets", () => {
    const env: Record<string, string | undefined> = { ...validEnvironment(), PATH: "/usr/bin" };
    const config = takeConfig(env);
    expect(config.github.privateKey.reveal()).toBe(testPrivateKey());
    expect(config.databaseUrl.reveal()).toContain("app-password-1");
    for (const name of SECRET_VARIABLES) expect(env[name]).toBeUndefined();
    // What is not secret stays.
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["ANALYSIS_SANDBOX_IMAGE"]).toBeDefined();
  });

  it("leaves the environment as it was when the settings are refused", () => {
    const env: Record<string, string | undefined> = validEnvironment({
      ANALYSIS_SANDBOX_DRIVER: undefined,
    });
    const before = { ...env };
    expect(() => takeConfig(env)).toThrow(ConfigError);
    expect(env).toEqual(before);
  });
});
