import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import {
  CLIENT_ID,
  DOWNLOAD_CREDENTIAL,
  INSTALLATION_TOKEN,
  startFakeGitHub,
  testKeys,
  validEnv,
  type FakeConfig,
  type FakeGitHub,
  FAKE_CLIENT_SECRET,
} from "./test-harness.js";

let fake: FakeGitHub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const run = async (
  env: Record<string, string | undefined>,
  overrides: Partial<FakeConfig> = {},
  apiBaseUrl?: string,
): Promise<{ code: number; output: string }> => {
  fake = await startFakeGitHub(overrides);
  const lines: string[] = [];
  const code = await main({
    env,
    write: (line) => lines.push(line),
    apiBaseUrl: apiBaseUrl ?? fake.url,
    downloadHosts: ["127.0.0.1"],
  });
  return { code, output: lines.join("\n") };
};

describe("main", () => {
  it("exits 0 and says that all passed", async () => {
    const { code, output } = await run(validEnv());
    expect(code).toBe(0);
    expect(output).toContain("All checks passed.");
    expect(output).not.toContain("FAIL");
  });

  it("exits 1 when a check fails", async () => {
    const { code, output } = await run(validEnv(), { blobStatus: 201 });
    expect(code).toBe(1);
    expect(output).toContain("FAIL  a write is refused: HTTP 201");
    expect(output).toContain("Some checks failed.");
  });

  it("never prints a key, a token or a JWT, in a workflow or out of one", async () => {
    for (const GITHUB_ACTIONS of [undefined, "true"]) {
      const { output } = await run(validEnv({ GITHUB_ACTIONS }));
      for (const secret of [INSTALLATION_TOKEN, DOWNLOAD_CREDENTIAL, "BEGIN", "eyJ", "add-mask"]) {
        expect(output).not.toContain(secret);
      }
      await fake?.close();
    }
  });

  it("exits 2 when the settings are missing, naming each variable and no value", async () => {
    const { code, output } = await run({ GITHUB_REPOSITORY: "acme/widgets" });
    expect(code).toBe(2);
    for (const name of [
      "CODEMUGS_GITHUB_APP_ID",
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
      "CODEMUGS_GITHUB_APP_INSTALLATION_ID",
      "CODEMUGS_GITHUB_APP_PRIVATE_KEY",
    ]) {
      expect(output).toContain(name);
    }
  });

  it("exits 2 for a client secret in place of the key, and does not print it", async () => {
    const clientSecret = FAKE_CLIENT_SECRET;
    const { code, output } = await run(validEnv({ CODEMUGS_GITHUB_APP_PRIVATE_KEY: clientSecret }));
    expect(code).toBe(2);
    expect(output).toContain(".pem");
    expect(output).not.toContain(clientSecret);
  });

  it("exits 1 when the key looks like a key but is not one, and does not print it", async () => {
    const fakeKey = "-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----";
    const { code, output } = await run(validEnv({ CODEMUGS_GITHUB_APP_PRIVATE_KEY: fakeKey }));
    expect(code).toBe(1);
    expect(output).toContain("key_invalid");
    expect(output).not.toContain("bm90IGEga2V5");
  });

  it.each(["", "widgets", "a b/c", "a/b/c", "/widgets", "acme/", "acme/..x y"])(
    "exits 2 when GITHUB_REPOSITORY is %j",
    async (value) => {
      const { code, output } = await run(validEnv({ GITHUB_REPOSITORY: value }));
      expect(code).toBe(2);
      expect(output).toContain("GITHUB_REPOSITORY");
    },
  );

  it("uses the fetch that it is given, and turns its failure into a result, not a crash", async () => {
    const lines: string[] = [];
    let calls = 0;
    const code = await main({
      env: validEnv(),
      write: (line) => lines.push(line),
      fetch: () => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed: SECRET-DETAIL"));
      },
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(lines.join("\n")).toContain("FAIL  the key signs in as the app: request_failed");
    expect(lines.join("\n")).not.toContain("SECRET-DETAIL");
  });

  it("exits 2 with a fixed sentence when the address of the API is not allowed", async () => {
    const { code, output } = await run(validEnv(), {}, "http://api.example.com");
    expect(code).toBe(2);
    expect(output).toBe("an argument is not of the form that GitHub uses");
    expect(output).not.toContain("example.com");
  });

  it("uses the identifiers that it is given, and nothing from the Client ID leaks as the key", async () => {
    const { output } = await run(validEnv());
    expect(output).not.toContain(CLIENT_ID);
    expect(output).not.toContain(testKeys().privatePem.slice(40, 80));
  });
});
