import { ConfigError } from "@codemugs/configuration";
import { describe, expect, it } from "vitest";
import { loadGitHubAppConfig, loadGitHubAppCredentials } from "./config.js";
import {
  APP_ID,
  CLIENT_ID,
  INSTALLATION_ID,
  testKeys,
  FAKE_CLIENT_SECRET,
} from "./test-harness.js";

const KEY = "CODEMUGS_GITHUB_APP_PRIVATE_KEY";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  CODEMUGS_GITHUB_APP_ID: String(APP_ID),
  CODEMUGS_GITHUB_APP_CLIENT_ID: CLIENT_ID,
  CODEMUGS_GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
  [KEY]: testKeys().privatePem,
  ...overrides,
});

const issues = (input: Record<string, string | undefined>): readonly string[] => {
  try {
    loadGitHubAppConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("the configuration was accepted");
};

describe("loadGitHubAppConfig", () => {
  it("reads the identifiers as they are and the key as a secret", () => {
    const config = loadGitHubAppConfig(env());
    expect(config.appId).toBe(APP_ID);
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.installationId).toBe(INSTALLATION_ID);
    expect(config.privateKey.reveal()).toBe(testKeys().privatePem.trim());
    expect(JSON.stringify(config)).not.toContain("BEGIN");
    expect(String(config.privateKey)).not.toContain("BEGIN");
  });

  it("restores the line breaks of a key that was kept with them written as \\n", () => {
    const flat = testKeys().privatePem.trim().replaceAll("\n", "\\n");
    expect(flat).not.toContain("\n");
    const config = loadGitHubAppConfig(env({ [KEY]: flat }));
    expect(config.privateKey.reveal()).toBe(testKeys().privatePem.trim());
  });

  it("leaves the line breaks of a key that has them", () => {
    expect(
      loadGitHubAppConfig(env({ [KEY]: `\n${testKeys().privatePem}\n` })).privateKey.reveal(),
    ).toBe(testKeys().privatePem.trim());
  });

  it("names each variable that is missing, and only them", () => {
    const found = issues({});
    expect(found).toHaveLength(4);
    for (const name of [
      "CODEMUGS_GITHUB_APP_ID",
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
      "CODEMUGS_GITHUB_APP_INSTALLATION_ID",
      KEY,
    ]) {
      expect(found.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
    }
  });

  it("refuses a client secret where the private key goes, and says what to use instead", () => {
    const clientSecret = FAKE_CLIENT_SECRET;
    const found = issues(env({ [KEY]: clientSecret }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(KEY);
    expect(found[0]).toContain(".pem");
    expect(found[0]).toContain("-----BEGIN");
    expect(found.join("\n")).not.toContain(clientSecret);
  });

  it.each([
    [
      "an App ID that is not a number",
      { CODEMUGS_GITHUB_APP_ID: "12ab" },
      "CODEMUGS_GITHUB_APP_ID",
    ],
    ["an App ID of zero", { CODEMUGS_GITHUB_APP_ID: "0" }, "CODEMUGS_GITHUB_APP_ID"],
    ["an App ID with a leading zero", { CODEMUGS_GITHUB_APP_ID: "0123" }, "CODEMUGS_GITHUB_APP_ID"],
    [
      "an installation ID that is a link",
      { CODEMUGS_GITHUB_APP_INSTALLATION_ID: "https://github.com/settings/installations/1" },
      "CODEMUGS_GITHUB_APP_INSTALLATION_ID",
    ],
    [
      "an installation ID that is negative",
      { CODEMUGS_GITHUB_APP_INSTALLATION_ID: "-5" },
      "CODEMUGS_GITHUB_APP_INSTALLATION_ID",
    ],
    [
      "a Client ID that is the App ID",
      { CODEMUGS_GITHUB_APP_CLIENT_ID: "5776596" },
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
    ],
    [
      "a Client ID with something before the Iv",
      { CODEMUGS_GITHUB_APP_CLIENT_ID: "xIv23lipC397du816RxiY" },
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
    ],
    [
      "a Client ID with a space",
      { CODEMUGS_GITHUB_APP_CLIENT_ID: "Iv23 lipC397du816RxiY" },
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
    ],
  ] as const)("refuses %s, naming only that variable", (_name, change, variable) => {
    const found = issues(env(change));
    expect(found).toHaveLength(1);
    expect(found[0]?.startsWith(`${variable}:`)).toBe(true);
    for (const value of Object.values(change)) expect(found.join("\n")).not.toContain(value);
  });

  it.each([
    ["a Client ID of 8 characters after Iv", "Iv12345678", true],
    ["a Client ID of 40 characters after Iv", `Iv${"a".repeat(40)}`, true],
    ["a Client ID of 7 characters after Iv", "Iv1234567", false],
    ["a Client ID of 41 characters after Iv", `Iv${"a".repeat(41)}`, false],
  ])("treats %s as accepted: %s", (_name, clientId, accepted) => {
    const input = env({ CODEMUGS_GITHUB_APP_CLIENT_ID: clientId });
    if (accepted) expect(loadGitHubAppConfig(input).clientId).toBe(clientId);
    else expect(issues(input)[0]?.startsWith("CODEMUGS_GITHUB_APP_CLIENT_ID:")).toBe(true);
  });

  it.each([
    ["the largest ID that is allowed (15 digits)", "999999999999999", true],
    ["an ID of 16 digits", "1000000000000000", false],
  ])("treats %s as accepted: %s", (_name, id, accepted) => {
    const input = env({ CODEMUGS_GITHUB_APP_ID: id });
    if (accepted) expect(loadGitHubAppConfig(input).appId).toBe(Number(id));
    else expect(issues(input)[0]?.startsWith("CODEMUGS_GITHUB_APP_ID:")).toBe(true);
  });

  it("refuses an empty variable the same way as a missing one", () => {
    expect(issues(env({ [KEY]: "" }))[0]).toContain(KEY);
  });
});

describe("loadGitHubAppCredentials", () => {
  const credentials = (overrides: Record<string, string | undefined> = {}) => {
    return Object.fromEntries(
      Object.entries(env(overrides)).filter(
        ([name]) => name !== "CODEMUGS_GITHUB_APP_INSTALLATION_ID",
      ),
    );
  };

  it("reads the app's own settings without an installation", () => {
    const loaded = loadGitHubAppCredentials(credentials());
    expect(loaded.appId).toBe(APP_ID);
    expect(loaded.clientId).toBe(CLIENT_ID);
    expect(loaded.privateKey.reveal()).toBe(testKeys().privatePem.trim());
    expect(loaded).not.toHaveProperty("installationId");
    expect(JSON.stringify(loaded)).not.toContain("BEGIN");
  });

  it("does not use an installation that the environment happens to have", () => {
    expect(loadGitHubAppCredentials(env())).not.toHaveProperty("installationId");
  });

  it("restores the line breaks of a key that was kept with them written as \\n", () => {
    const flat = testKeys().privatePem.trim().replaceAll("\n", "\\n");
    expect(loadGitHubAppCredentials(credentials({ [KEY]: flat })).privateKey.reveal()).toBe(
      testKeys().privatePem.trim(),
    );
  });

  it("names each variable that is missing, and only those that it needs", () => {
    let found: readonly string[] = [];
    try {
      loadGitHubAppCredentials({});
    } catch (error) {
      if (error instanceof ConfigError) found = error.issues;
      else throw error;
    }
    expect(found).toHaveLength(3);
    expect(found.join("\n")).not.toContain("INSTALLATION");
  });

  it("refuses a client secret where the private key goes, without printing it", () => {
    let message = "";
    try {
      loadGitHubAppCredentials(credentials({ [KEY]: FAKE_CLIENT_SECRET }));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain(KEY);
    expect(message).not.toContain(FAKE_CLIENT_SECRET);
  });
});
