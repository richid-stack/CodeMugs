import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secret } from "@codemugs/configuration";
import { WorkerStartupError } from "@codemugs/jobs";
import {
  SandboxError,
  type Availability,
  type IsolationLevel,
  type SandboxDriver,
  type SandboxErrorCode,
  type SandboxResult,
  type SandboxRunRequest,
} from "@codemugs/sandbox-manager";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyGitHubKey, verifySandbox, type AnalysisStartupCode } from "./preflight.js";
import { testPrivateKey } from "./test-support.js";

const IMAGE = `docker.io/library/node@sha256:${"b".repeat(64)}`;
const READY = "codemugs-sandbox-ready";

const ran = (overrides: Partial<SandboxResult> = {}): SandboxResult => ({
  outcome: "exited",
  exitCode: 0,
  stdout: READY,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 5,
  ...overrides,
});

interface StandIn extends SandboxDriver {
  readonly requests: SandboxRunRequest[];
}

/** A driver that is what the test says it is and runs nothing. */
function standIn(
  options: {
    isolation?: IsolationLevel;
    availability?: () => Promise<Availability>;
    run?: (request: SandboxRunRequest) => Promise<SandboxResult>;
  } = {},
): StandIn {
  const requests: SandboxRunRequest[] = [];
  return {
    name: "stand-in",
    isolation: options.isolation ?? "hardened-container",
    requests,
    availability: options.availability ?? (() => Promise.resolve({ available: true })),
    run: (request) => {
      requests.push(request);
      return (options.run ?? (() => Promise.resolve(ran())))(request);
    },
  };
}

/** The startup error that a call ends in, or a failure of the test if it ended any other way. */
async function startupError(
  work: Promise<unknown>,
): Promise<WorkerStartupError<AnalysisStartupCode>> {
  try {
    await work;
  } catch (error) {
    if (error instanceof WorkerStartupError)
      return error as WorkerStartupError<AnalysisStartupCode>;
    throw error;
  }
  throw new Error("the check passed");
}

describe("verifySandbox", () => {
  let root: string;
  let workspace: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "analysis-preflight-")));
    workspace = join(root, "work");
    await mkdir(workspace);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const options = (
    driver: SandboxDriver,
    overrides: { minimumIsolation?: IsolationLevel } = {},
  ) => ({
    driver,
    minimumIsolation: overrides.minimumIsolation ?? "hardened-container",
    image: IMAGE,
    workspaceRoot: workspace,
  });

  const leftovers = async (): Promise<string[]> => readdir(workspace);

  it("passes when the folder can be used and the driver runs the image", async () => {
    const driver = standIn();
    await verifySandbox(options(driver));
    expect(driver.requests).toHaveLength(1);
    expect(await leftovers()).toEqual([]);
  });

  it("runs a fixed command of its own, with no network, no repository and small limits", async () => {
    const driver = standIn();
    await verifySandbox(options(driver));
    const [request] = driver.requests;
    expect(request?.policy.image).toBe(IMAGE);
    expect(request?.policy.network).toEqual({ mode: "none" });
    expect(request?.command[0]).toBe("node");
    expect(request?.command.join(" ")).toContain(READY);
    expect(request?.policy.limits.memoryMb).toBeLessThanOrEqual(128);
    expect(request?.policy.limits.wallClockSeconds).toBeLessThanOrEqual(30);
    // An empty folder made for it inside the working folder: nothing that anyone sent.
    expect(request?.sourceDirectory?.startsWith(`${workspace}/startup-check-`)).toBe(true);
  });

  it("removes the folder that it made, also when the check fails", async () => {
    await startupError(
      verifySandbox(options(standIn({ run: () => Promise.resolve(ran({ exitCode: 1 })) }))),
    );
    await startupError(
      verifySandbox(options(standIn({ run: () => Promise.reject(new Error("boom")) }))),
    );
    expect(await leftovers()).toEqual([]);
  });

  describe("the working folder", () => {
    it("is refused when it does not exist, before the driver is asked anything", async () => {
      const driver = standIn();
      const error = await startupError(
        verifySandbox({ ...options(driver), workspaceRoot: join(root, "missing") }),
      );
      expect(error.code).toBe("workspace_unusable");
      expect(error.variable).toBe("ANALYSIS_WORKSPACE_ROOT");
      expect(error.message).not.toContain(root);
      expect(driver.requests).toHaveLength(0);
    });

    it("is refused when it is a file", async () => {
      const file = join(root, "a-file");
      await writeFile(file, "x");
      const error = await startupError(
        verifySandbox({ ...options(standIn()), workspaceRoot: file }),
      );
      expect(error.code).toBe("workspace_unusable");
      expect(error.message).toContain("not a folder that exists");
    });

    it.skipIf(process.platform !== "linux")(
      "is refused when nothing can be made in it",
      async () => {
        // A folder that exists and that nothing can be created in, for a process of any user.
        const error = await startupError(
          verifySandbox({ ...options(standIn()), workspaceRoot: "/proc" }),
        );
        expect(error.code).toBe("workspace_unusable");
        expect(error.message).toContain("written to");
      },
    );
  });

  describe("the driver", () => {
    it("is refused when it cannot run here, and says why in one short line", async () => {
      const reason = `the docker daemon\ndid not answer ${"x".repeat(400)}`;
      const driver = standIn({ availability: () => Promise.resolve({ available: false, reason }) });
      const error = await startupError(verifySandbox(options(driver)));
      expect(error.code).toBe("sandbox_unavailable");
      expect(error.variable).toBe("ANALYSIS_SANDBOX_DRIVER");
      expect(error.message).toContain("the docker daemon did not answer");
      expect(error.message).not.toContain("\n");
      expect(error.message.length).toBeLessThan(300);
      expect(driver.requests).toHaveLength(0);
    });

    it("is refused when it cannot even say, without passing on what it threw", async () => {
      const driver = standIn({
        availability: () => Promise.reject(new Error("socket /var/run/secret-path refused")),
      });
      const error = await startupError(verifySandbox(options(driver)));
      expect(error.code).toBe("sandbox_unavailable");
      expect(error.message).not.toContain("secret-path");
    });

    it.each([
      ["hardened-container", "gvisor"],
      ["hardened-container", "microvm"],
      ["gvisor", "microvm"],
    ] as const)(
      "is refused when it gives %s and %s is the least asked for",
      async (gives, asked) => {
        const driver = standIn({ isolation: gives });
        const error = await startupError(
          verifySandbox(options(driver, { minimumIsolation: asked })),
        );
        expect(error.code).toBe("sandbox_too_weak");
        expect(error.variable).toBe("ANALYSIS_SANDBOX_MINIMUM_ISOLATION");
        expect(error.message).toContain(gives);
        expect(error.message).toContain(asked);
        expect(driver.requests).toHaveLength(0);
      },
    );

    it.each([
      ["hardened-container", "hardened-container"],
      ["gvisor", "hardened-container"],
      ["gvisor", "gvisor"],
    ] as const)(
      "is accepted when it gives %s and %s is the least asked for",
      async (gives, asked) => {
        await verifySandbox(options(standIn({ isolation: gives }), { minimumIsolation: asked }));
      },
    );
  });

  describe("the check that runs the image", () => {
    it.each([
      ["exits with an error", ran({ exitCode: 1 })],
      ["is stopped for taking too long", ran({ outcome: "timed_out", exitCode: null })],
      ["runs out of memory", ran({ outcome: "out_of_memory", exitCode: null })],
      ["writes something else", ran({ stdout: "customer-secret-output" })],
      ["writes nothing", ran({ stdout: "" })],
      ["writes the word and more", ran({ stdout: `${READY}\n` })],
    ])("fails when the program %s, and does not print what it wrote", async (_name, result) => {
      const error = await startupError(
        verifySandbox(options(standIn({ run: () => Promise.resolve(result) }))),
      );
      expect(error.code).toBe("sandbox_self_test_failed");
      expect(error.variable).toBe("ANALYSIS_SANDBOX_IMAGE");
      expect(error.message).not.toContain("customer-secret-output");
    });

    it.each<[SandboxErrorCode, AnalysisStartupCode, string]>([
      ["unavailable", "sandbox_unavailable", "ANALYSIS_SANDBOX_DRIVER"],
      ["start_failed", "sandbox_self_test_failed", "ANALYSIS_SANDBOX_IMAGE"],
      ["run_failed", "sandbox_self_test_failed", "ANALYSIS_SANDBOX_IMAGE"],
      ["cleanup_failed", "sandbox_self_test_failed", "ANALYSIS_SANDBOX_IMAGE"],
      ["source_not_allowed", "sandbox_self_test_failed", "ANALYSIS_SANDBOX_IMAGE"],
    ])("turns the driver's %s into %s, naming %s", async (code, expected, variable) => {
      const error = await startupError(
        verifySandbox(options(standIn({ run: () => Promise.reject(new SandboxError(code)) }))),
      );
      expect(error.code).toBe(expected);
      expect(error.variable).toBe(variable);
      expect(error.message).toContain(code);
    });

    it("turns anything else that the driver throws into a failure, without its message", async () => {
      const driver = standIn({
        run: () => Promise.reject(new Error("could not read /home/someone/.docker/config.json")),
      });
      const error = await startupError(verifySandbox(options(driver)));
      expect(error.code).toBe("sandbox_self_test_failed");
      expect(error.message).not.toContain(".docker");
    });

    it("is refused by the sandbox manager when the image is not pinned, and says so as a failure", async () => {
      const error = await startupError(
        verifySandbox({ ...options(standIn()), image: "docker.io/library/node:22" }),
      );
      expect(error.code).toBe("sandbox_self_test_failed");
      expect(error.message).toContain("refused");
    });
  });
});

describe("verifyGitHubKey", () => {
  const clientId = "Iv23lipC397du816RxiY";
  const check = (pem: string) => () => {
    verifyGitHubKey({ clientId, privateKey: new Secret(pem) });
  };

  it("accepts an RSA key of 2048 bits", () => {
    expect(check(testPrivateKey())).not.toThrow();
  });

  it.each([
    [
      "an elliptic-curve key",
      () =>
        generateKeyPairSync("ec", { namedCurve: "P-256" })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
    ],
    [
      "an RSA key of 1024 bits",
      () =>
        generateKeyPairSync("rsa", { modulusLength: 1024 })
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
    ],
    [
      "a public key",
      () =>
        generateKeyPairSync("rsa", { modulusLength: 2048 })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString(),
    ],
    [
      "something that is not a key",
      () => "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----",
    ],
  ])("refuses %s, saying which variable and never printing the key", (_name, make) => {
    const pem = make();
    let error: unknown;
    try {
      check(pem)();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkerStartupError);
    const startup = error as WorkerStartupError<AnalysisStartupCode>;
    expect(startup.code).toBe("github_key_unusable");
    expect(startup.variable).toBe("CODEMUGS_GITHUB_APP_PRIVATE_KEY");
    expect(startup.message).not.toContain("not-a-key");
    expect(startup.message).not.toContain(pem.split("\n")[1] ?? "unreachable-line");
  });
});
