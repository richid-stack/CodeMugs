import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerStartupError } from "@codemugs/jobs";
import {
  createDockerDriver,
  createGvisorDriver,
  type IsolationLevel,
  type SandboxDriver,
} from "@codemugs/sandbox-manager";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifySandbox } from "./preflight.js";

/**
 * The startup check of the sandbox, against the real drivers: that it passes where the image runs
 * and fails, with a code, where it does not.
 *
 * It needs a docker daemon and the image `CODEMUGS_TEST_NODE_IMAGE` (a Node image pinned by
 * digest). Without them the tests are skipped, and in CI, which sets `REQUIRE_DOCKER_TESTS` and
 * `REQUIRE_GVISOR_TESTS`, a missing daemon, runtime or image fails the run and does not skip it.
 *
 * **What this shows and what it does not.** It shows that the check tells a working sandbox from
 * one that is not. It does not measure how much isolation either runtime gives: release gate 8 is
 * not started.
 */
const image = process.env["CODEMUGS_TEST_NODE_IMAGE"];
// An image that has no Node in it, so that a program that is not there is told from one that is.
const imageWithoutNode = process.env["CODEMUGS_TEST_SANDBOX_IMAGE"];
const NOT_ON_ANY_REGISTRY = `docker.io/library/node@sha256:${"0".repeat(64)}`;

function succeeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function dockerHasRunsc(): boolean {
  try {
    const runtimes = execFileSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return runtimes.includes('"runsc"');
  } catch {
    return false;
  }
}

const imageIsHere = image !== undefined && succeeds("docker", ["image", "inspect", image]);
const otherImageIsHere =
  imageWithoutNode !== undefined && succeeds("docker", ["image", "inspect", imageWithoutNode]);

interface Flavour {
  readonly name: string;
  readonly isolation: IsolationLevel;
  readonly create: (options: { workspaceRoot: string }) => SandboxDriver;
  readonly usable: boolean;
  readonly required: boolean;
}

const flavours: Flavour[] = [
  {
    name: "docker",
    isolation: "hardened-container",
    create: createDockerDriver,
    usable: imageIsHere,
    required: process.env["REQUIRE_DOCKER_TESTS"] === "true",
  },
  {
    name: "gvisor",
    isolation: "gvisor",
    create: createGvisorDriver,
    usable: imageIsHere && dockerHasRunsc(),
    required: process.env["REQUIRE_GVISOR_TESTS"] === "true",
  },
];

for (const flavour of flavours) {
  (flavour.usable || flavour.required ? describe : describe.skip)(
    `the startup check of the ${flavour.name} sandbox`,
    () => {
      let base: string;
      let workspace: string;

      beforeAll(async () => {
        if (!flavour.usable || image === undefined) {
          throw new Error(
            `the ${flavour.name} startup check tests are required but there is no usable docker daemon${
              flavour.name === "gvisor" ? " with the runsc runtime" : ""
            }, or the image CODEMUGS_TEST_NODE_IMAGE is not on this host`,
          );
        }
        base = await realpath(await mkdtemp(join(tmpdir(), "analysis-startup-")));
        workspace = join(base, "work");
        await mkdir(workspace);
      });

      afterAll(async () => {
        if (base !== undefined) await rm(base, { recursive: true, force: true });
      });

      const failure = async (options: {
        image: string;
        minimumIsolation?: IsolationLevel;
      }): Promise<WorkerStartupError> => {
        try {
          await verifySandbox({
            driver: flavour.create({ workspaceRoot: workspace }),
            minimumIsolation: options.minimumIsolation ?? flavour.isolation,
            image: options.image,
            workspaceRoot: workspace,
          });
        } catch (error) {
          if (error instanceof WorkerStartupError) return error;
          throw error;
        }
        throw new Error("the check passed");
      };

      it("passes where the image runs, and leaves nothing in the working folder", async () => {
        await verifySandbox({
          driver: flavour.create({ workspaceRoot: workspace }),
          minimumIsolation: flavour.isolation,
          image: image ?? "",
          workspaceRoot: workspace,
        });
        expect(await readdir(workspace)).toEqual([]);
      }, 60_000);

      it("fails with a code for an image that is not there to be run", async () => {
        const error = await failure({ image: NOT_ON_ANY_REGISTRY });
        expect(error.code).toBe("sandbox_self_test_failed");
        expect(error.variable).toBe("ANALYSIS_SANDBOX_IMAGE");
        expect(error.message).not.toContain(NOT_ON_ANY_REGISTRY);
        expect(await readdir(workspace)).toEqual([]);
      }, 120_000);

      it.skipIf(!otherImageIsHere)(
        "fails for an image that has no Node in it",
        async () => {
          const error = await failure({ image: imageWithoutNode ?? "" });
          expect(error.code).toBe("sandbox_self_test_failed");
          expect(error.variable).toBe("ANALYSIS_SANDBOX_IMAGE");
        },
        60_000,
      );

      it("fails when more isolation is asked for than it gives", async () => {
        const error = await failure({ image: image ?? "", minimumIsolation: "microvm" });
        expect(error.code).toBe("sandbox_too_weak");
      }, 60_000);
    },
  );
}
