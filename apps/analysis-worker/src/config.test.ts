import { ANALYSIS_SANDBOX } from "@codemugs/application-intelligence";
import { ConfigError } from "@codemugs/configuration";
import { createDockerDriver, createGvisorDriver } from "@codemugs/sandbox-manager";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_TIMING,
  LONGEST_ANALYSIS_SECONDS,
  SANDBOX_DRIVERS,
  loadAnalysisWorkerConfig,
} from "./config.js";
import { testPrivateKey, validEnvironment } from "./test-support.js";

const issuesOf = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadAnalysisWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("the configuration was accepted");
};

const KEY = "CODEMUGS_GITHUB_APP_PRIVATE_KEY";

describe("loadAnalysisWorkerConfig", () => {
  it("reads a complete environment, with the secrets wrapped", () => {
    const config = loadAnalysisWorkerConfig(validEnvironment());
    expect(config.sandbox).toEqual({
      driver: "docker",
      minimumIsolation: "hardened-container",
      image: `docker.io/library/node@sha256:${"a".repeat(64)}`,
      workspaceRoot: "/var/lib/codemugs/analysis",
    });
    expect(config.github.appId).toBe(5776596);
    expect(config.github.clientId).toBe("Iv23lipC397du816RxiY");
    expect(config.github.privateKey.reveal()).toBe(testPrivateKey());
    expect(config.databaseUrl.reveal()).toContain("app-password-1");
    expect(config.dispatcherDatabaseUrl.reveal()).toContain("dispatcher-password-2");

    // Nothing that holds a secret can print it, by whatever way the whole is printed.
    const printed = [
      JSON.stringify(config),
      String(config.github.privateKey),
      String(config.databaseUrl),
    ];
    for (const text of printed) {
      expect(text).not.toContain("BEGIN");
      expect(text).not.toContain("app-password-1");
      expect(text).not.toContain("dispatcher-password-2");
    }
  });

  it("has defaults that are small: one analysis at a time, and a lease that is long enough", () => {
    const config = loadAnalysisWorkerConfig(validEnvironment());
    expect(config.concurrency).toBe(1);
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.leaseSeconds).toBe(600);
    expect(config.leaseSeconds).toBeGreaterThanOrEqual(LONGEST_ANALYSIS_SECONDS);
    expect(config.shutdownTimeoutMs).toBe(30_000);
    expect(config.logLevel).toBe("info");
    expect(config.nodeEnv).toBe("development");
  });

  it("names every variable that is missing, and only them, in one go", () => {
    const found = issuesOf({});
    const missing = [
      "DATABASE_URL",
      "DISPATCHER_DATABASE_URL",
      "ANALYSIS_SANDBOX_DRIVER",
      "ANALYSIS_SANDBOX_MINIMUM_ISOLATION",
      "ANALYSIS_SANDBOX_IMAGE",
      "ANALYSIS_WORKSPACE_ROOT",
      "CODEMUGS_GITHUB_APP_ID",
      "CODEMUGS_GITHUB_APP_CLIENT_ID",
      KEY,
    ];
    expect(found).toHaveLength(missing.length);
    for (const name of missing) {
      expect(found.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
    }
    // The process serves many installations: it asks for none of its own.
    expect(found.join("\n")).not.toContain("INSTALLATION");
  });

  it("does not default the sandbox: the driver, how much it isolates and the image are chosen", () => {
    for (const name of [
      "ANALYSIS_SANDBOX_DRIVER",
      "ANALYSIS_SANDBOX_MINIMUM_ISOLATION",
      "ANALYSIS_SANDBOX_IMAGE",
      "ANALYSIS_WORKSPACE_ROOT",
    ]) {
      const found = issuesOf(validEnvironment({ [name]: undefined }));
      expect(found).toHaveLength(1);
      expect(found[0]?.startsWith(`${name}:`)).toBe(true);
    }
  });

  describe("the lease", () => {
    it("is at least as long as the longest analysis, which is worked out and not guessed", () => {
      // Three requests to GitHub, the download, the sandbox's wall-clock limit and the allowance.
      expect(LONGEST_ANALYSIS_SECONDS).toBe(
        (3 * ANALYSIS_TIMING.githubRequestMs + ANALYSIS_TIMING.githubDownloadMs) / 1_000 +
          ANALYSIS_SANDBOX.limits.wallClockSeconds +
          60,
      );
      expect(LONGEST_ANALYSIS_SECONDS).toBe(450);
    });

    it("is refused when it is shorter, and the refusal says the number", () => {
      const found = issuesOf(
        validEnvironment({ WORKER_LEASE_SECONDS: String(LONGEST_ANALYSIS_SECONDS - 1) }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("WORKER_LEASE_SECONDS");
      expect(found[0]).toContain(String(LONGEST_ANALYSIS_SECONDS));
    });

    it("is accepted when it is exactly that long, and at the largest allowed", () => {
      const at = loadAnalysisWorkerConfig(
        validEnvironment({ WORKER_LEASE_SECONDS: String(LONGEST_ANALYSIS_SECONDS) }),
      );
      expect(at.leaseSeconds).toBe(LONGEST_ANALYSIS_SECONDS);
      expect(
        loadAnalysisWorkerConfig(validEnvironment({ WORKER_LEASE_SECONDS: "86400" })).leaseSeconds,
      ).toBe(86_400);
      expect(issuesOf(validEnvironment({ WORKER_LEASE_SECONDS: "86401" }))[0]).toContain(
        "WORKER_LEASE_SECONDS",
      );
    });
  });

  describe("the sandbox", () => {
    it.each([
      ["docker", "hardened-container"],
      ["gvisor", "hardened-container"],
      ["gvisor", "gvisor"],
    ])("accepts the %s driver when at least %s is asked for", (driver, minimum) => {
      const config = loadAnalysisWorkerConfig(
        validEnvironment({
          ANALYSIS_SANDBOX_DRIVER: driver,
          ANALYSIS_SANDBOX_MINIMUM_ISOLATION: minimum,
        }),
      );
      expect(config.sandbox.driver).toBe(driver);
      expect(config.sandbox.minimumIsolation).toBe(minimum);
    });

    it.each([
      ["docker", "gvisor"],
      ["docker", "microvm"],
      ["gvisor", "microvm"],
    ])(
      "refuses the %s driver when %s is asked for, because every analysis would be refused",
      (driver, minimum) => {
        const found = issuesOf(
          validEnvironment({
            ANALYSIS_SANDBOX_DRIVER: driver,
            ANALYSIS_SANDBOX_MINIMUM_ISOLATION: minimum,
          }),
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.startsWith("ANALYSIS_SANDBOX_MINIMUM_ISOLATION:")).toBe(true);
      },
    );

    it("says what each driver gives, as the drivers themselves do", () => {
      // The table that the refusal above rests on is the drivers' own claim.
      expect(createDockerDriver({ workspaceRoot: "/tmp" }).isolation).toBe(SANDBOX_DRIVERS.docker);
      expect(createGvisorDriver({ workspaceRoot: "/tmp" }).isolation).toBe(SANDBOX_DRIVERS.gvisor);
    });

    it.each([
      ["a driver that does not exist", { ANALYSIS_SANDBOX_DRIVER: "firecracker" }],
      ["an isolation that does not exist", { ANALYSIS_SANDBOX_MINIMUM_ISOLATION: "strong" }],
      ["an image by tag", { ANALYSIS_SANDBOX_IMAGE: "docker.io/library/node:22" }],
      ["an image with a short digest", { ANALYSIS_SANDBOX_IMAGE: "node@sha256:abc123" }],
      [
        "an image that starts like an option",
        { ANALYSIS_SANDBOX_IMAGE: `--privileged@sha256:${"a".repeat(64)}` },
      ],
      ["a relative working folder", { ANALYSIS_WORKSPACE_ROOT: "work/analysis" }],
      ["an empty working folder", { ANALYSIS_WORKSPACE_ROOT: "" }],
    ])("refuses %s, naming that variable and not what was given", (_name, change) => {
      const found = issuesOf(validEnvironment(change));
      expect(found).toHaveLength(1);
      const [variable, value] = Object.entries(change)[0] as [string, string];
      expect(found[0]?.startsWith(`${variable}:`)).toBe(true);
      if (value.length > 0) expect(found.join("\n")).not.toContain(value);
    });
  });

  describe("the connections", () => {
    it("refuses the same address for both roles, which would let the queue be read as the application", () => {
      const same = validEnvironment().DATABASE_URL;
      const found = issuesOf(validEnvironment({ DISPATCHER_DATABASE_URL: same }));
      expect(found).toHaveLength(1);
      expect(found[0]?.startsWith("DISPATCHER_DATABASE_URL:")).toBe(true);
      expect(found.join("\n")).not.toContain("app-password-1");
    });

    it("refuses an address that is not a postgres one, without printing it", () => {
      const found = issuesOf(validEnvironment({ DATABASE_URL: "mysql://root:hunter2@db/x" }));
      expect(found).toHaveLength(1);
      expect(found.join("\n")).not.toContain("hunter2");
    });
  });

  describe("GitHub's key", () => {
    it("is refused when it is a client secret, and the value is never printed", () => {
      // A value that is not a private key (what a client secret looks like), made up here: it is low in
      // entropy, so that no secret scanner takes it for a credential.
      const wrongKind = "ab".repeat(20);
      const found = issuesOf(validEnvironment({ [KEY]: wrongKind }));
      expect(found).toHaveLength(1);
      expect(found[0]?.startsWith(`${KEY}:`)).toBe(true);
      expect(found.join("\n")).not.toContain(wrongKind);
    });

    it("is reported together with the other mistakes", () => {
      const found = issuesOf(
        validEnvironment({
          [KEY]: "nope",
          ANALYSIS_SANDBOX_DRIVER: undefined,
          WORKER_CONCURRENCY: "0",
        }),
      );
      expect(found.map((issue) => issue.split(":")[0]).sort()).toEqual(
        [KEY, "ANALYSIS_SANDBOX_DRIVER", "WORKER_CONCURRENCY"].sort(),
      );
    });
  });

  it.each([
    ["no analysis at once", { WORKER_CONCURRENCY: "0" }, "WORKER_CONCURRENCY"],
    ["more than eight at once", { WORKER_CONCURRENCY: "9" }, "WORKER_CONCURRENCY"],
    ["a concurrency that is not a number", { WORKER_CONCURRENCY: "many" }, "WORKER_CONCURRENCY"],
    ["a poll interval below 10 ms", { WORKER_POLL_INTERVAL_MS: "9" }, "WORKER_POLL_INTERVAL_MS"],
    ["a negative shutdown time", { SHUTDOWN_TIMEOUT_MS: "-1" }, "SHUTDOWN_TIMEOUT_MS"],
    ["an unknown log level", { LOG_LEVEL: "loud" }, "LOG_LEVEL"],
    ["an unknown environment", { NODE_ENV: "staging" }, "NODE_ENV"],
  ])("refuses %s", (_name, change, variable) => {
    const found = issuesOf(validEnvironment(change));
    expect(found).toHaveLength(1);
    expect(found[0]?.startsWith(`${variable}:`)).toBe(true);
  });

  it("accepts the largest concurrency and the smallest poll interval", () => {
    const config = loadAnalysisWorkerConfig(
      validEnvironment({ WORKER_CONCURRENCY: "8", WORKER_POLL_INTERVAL_MS: "10" }),
    );
    expect(config.concurrency).toBe(8);
    expect(config.pollIntervalMs).toBe(10);
  });
});
