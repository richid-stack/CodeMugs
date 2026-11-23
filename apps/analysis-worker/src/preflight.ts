import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_SANDBOX } from "@codemugs/application-intelligence";
import { GitHubError, createAppJwt, type GitHubAppCredentials } from "@codemugs/github";
import {
  verifyWorkerDatabase,
  WorkerStartupError,
  type DatabaseProbes,
  type DatabaseStartupCode,
} from "@codemugs/jobs";
import {
  isolationAtLeast,
  SandboxError,
  type Availability,
  validateRunRequest,
  type IsolationLevel,
  type SandboxDriver,
} from "@codemugs/sandbox-manager";
import { APP_ROLE, DISPATCHER_ROLE, type Pool } from "@codemugs/storage";

/** Why the process cannot start: the database's reasons, and the ones of its own. */
export type AnalysisStartupCode =
  | DatabaseStartupCode
  | "github_key_unusable"
  | "workspace_unusable"
  | "sandbox_unavailable"
  | "sandbox_too_weak"
  | "sandbox_self_test_failed";

export type AnalysisStartupError = WorkerStartupError<AnalysisStartupCode>;

function fail(code: AnalysisStartupCode, variable: string, message: string): never {
  throw new WorkerStartupError<AnalysisStartupCode>(code, variable, message);
}

/**
 * What the job uses, so that a database that is not migrated far enough, or a role that may not read
 * what the job reads, is found at the start and not on the first request. The columns are the ones
 * that the job's queries name: the plan of a request, and the places that a run is stored.
 */
export const ANALYSIS_PROBES: DatabaseProbes = {
  app: [
    "SELECT 1 FROM jobs LIMIT 1",
    "SELECT id, project_id, connection_id, ref FROM analysis_requests LIMIT 1",
    "SELECT id, installation_id, owner, name FROM repository_connections LIMIT 1",
    "SELECT id, project_id, revision, facts_version, digest, summary FROM analysis_runs LIMIT 1",
    "SELECT run_id, id, kind, key, attributes FROM graph_nodes LIMIT 1",
    "SELECT run_id, from_id, to_id, kind, attributes FROM graph_edges LIMIT 1",
  ],
  dispatcher: ["SELECT 1 FROM jobs LIMIT 1"],
};

/**
 * Checks the two database connections and what the job reads and writes (see `verifyWorkerDatabase`
 * for what each check is for). `roles` is for tests, which use throwaway roles.
 */
export function verifyAnalysisDatabase(
  pools: { app: Pool; dispatcher: Pool },
  roles: { app: string; dispatcher: string } = { app: APP_ROLE, dispatcher: DISPATCHER_ROLE },
): Promise<void> {
  return verifyWorkerDatabase(pools, ANALYSIS_PROBES, roles);
}

/**
 * That the key can sign what GitHub asks for. It is checked without asking GitHub, so that a
 * GitHub that is down does not keep this process from starting: a key that is not an RSA key of at
 * least 2048 bits would fail every job as a bad key, and said so only after a try each.
 */
export function verifyGitHubKey(
  credentials: Pick<GitHubAppCredentials, "clientId" | "privateKey">,
): void {
  try {
    createAppJwt({ clientId: credentials.clientId, privateKey: credentials.privateKey });
  } catch (error) {
    if (error instanceof GitHubError && error.code === "key_invalid") {
      fail(
        "github_key_unusable",
        "CODEMUGS_GITHUB_APP_PRIVATE_KEY",
        "is not an RSA private key of at least 2048 bits, which is what GitHub gives",
      );
    }
    throw error;
  }
}

export interface SandboxCheckOptions {
  readonly driver: SandboxDriver;
  readonly minimumIsolation: IsolationLevel;
  /** The image that the analysis runs, pinned by digest. */
  readonly image: string;
  /** The folder that the driver keeps its working copies in. */
  readonly workspaceRoot: string;
}

/** What the check prints, so that a program that ran in the sandbox can be told from one that did not. */
const READY = "codemugs-sandbox-ready";

/** An error with a short reason that is safe to log: a reason of the driver, cut and on one line. */
const brief = (text: string): string => text.replaceAll(/\s+/g, " ").slice(0, 160);

/**
 * That the process can do the one thing it exists for, before it takes any job: the folder for
 * working copies can be written to, the driver can run here and isolates at least as much as asked,
 * and the image starts in the sandbox and runs a program.
 *
 * The last is a run of a fixed command of ours (`node -e` that prints one word) with no repository
 * and no network, so nothing of a customer's runs and nothing leaves (invariant 8). It is what finds
 * an image that is not there, a daemon that cannot start a container and a runtime that does not
 * work, at the start: otherwise each is found by a request, which is tried again as a failure of the
 * sandbox until it is given up on.
 */
export async function verifySandbox(options: SandboxCheckOptions): Promise<void> {
  const { driver, minimumIsolation, workspaceRoot } = options;

  try {
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a folder");
  } catch {
    return fail("workspace_unusable", "ANALYSIS_WORKSPACE_ROOT", "is not a folder that exists");
  }

  let availability: Availability;
  try {
    availability = await driver.availability();
  } catch {
    availability = { available: false, reason: "the driver could not say" };
  }
  if (!availability.available) {
    fail(
      "sandbox_unavailable",
      "ANALYSIS_SANDBOX_DRIVER",
      `the ${driver.name} sandbox cannot run here (${brief(availability.reason)})`,
    );
  }

  if (!isolationAtLeast(driver.isolation, minimumIsolation)) {
    fail(
      "sandbox_too_weak",
      "ANALYSIS_SANDBOX_MINIMUM_ISOLATION",
      `the ${driver.name} sandbox gives ${driver.isolation}, which is less than ${minimumIsolation}`,
    );
  }

  let directory: string;
  try {
    directory = await mkdtemp(join(workspaceRoot, "startup-check-"));
  } catch {
    return fail(
      "workspace_unusable",
      "ANALYSIS_WORKSPACE_ROOT",
      "is a folder that cannot be written to",
    );
  }
  // The error of the check, if it had one, is the one to report: a folder that stays is empty and is
  // said only when the check itself passed.
  let failure: Error | undefined;
  try {
    await selfTest(options, directory);
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("the check of the sandbox failed unexpectedly");
  }
  const removed = await rm(directory, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
  if (failure !== undefined) throw failure;
  if (!removed) {
    fail(
      "workspace_unusable",
      "ANALYSIS_WORKSPACE_ROOT",
      "a folder that was made in it could not be removed",
    );
  }
}

async function selfTest(options: SandboxCheckOptions, sourceDirectory: string): Promise<void> {
  const { driver, image, workspaceRoot } = options;
  let request;
  try {
    request = validateRunRequest(
      {
        policy: {
          image,
          // Small: it prints one word. The sandbox manager refuses what its ceilings do not accept.
          limits: { cpus: 0.5, memoryMb: 128, pids: 64, wallClockSeconds: 30, outputBytes: 1_024 },
          mounts: {
            source: { containerPath: ANALYSIS_SANDBOX.sourcePath },
            scratch: { containerPath: ANALYSIS_SANDBOX.scratchPath, sizeMb: 1 },
          },
          network: { mode: "none" },
        },
        command: ["node", "-e", `process.stdout.write(${JSON.stringify(READY)})`],
        sourceDirectory,
      },
      { workspaceRoot },
    );
  } catch {
    // Written here, from a fixed command and an image that the configuration checked: a refusal is
    // a mistake in the folder or the image, and its text names fields and not values.
    return fail(
      "sandbox_self_test_failed",
      "ANALYSIS_SANDBOX_IMAGE",
      "the check of the sandbox was refused by the sandbox manager",
    );
  }

  let result;
  try {
    result = await driver.run(request);
  } catch (error) {
    if (error instanceof SandboxError) {
      return fail(
        error.code === "unavailable" ? "sandbox_unavailable" : "sandbox_self_test_failed",
        error.code === "unavailable" ? "ANALYSIS_SANDBOX_DRIVER" : "ANALYSIS_SANDBOX_IMAGE",
        `the check of the sandbox could not be run (${error.code})`,
      );
    }
    return fail(
      "sandbox_self_test_failed",
      "ANALYSIS_SANDBOX_IMAGE",
      "the check of the sandbox could not be run",
    );
  }
  if (result.outcome !== "exited" || result.exitCode !== 0 || result.stdout !== READY) {
    // What the program wrote is not printed: the outcome and the exit code say enough.
    fail(
      "sandbox_self_test_failed",
      "ANALYSIS_SANDBOX_IMAGE",
      `the image did not run the check (${result.outcome}, exit code ${String(result.exitCode)}); it needs Node 22 and must be an image that this host can start`,
    );
  }
}
