import { describe, expect, it } from "vitest";
import { changed, DIGEST, validPolicyInput } from "../fixtures.js";
import { validateRunRequest, type SandboxRunRequest } from "../request.js";
import { dockerCreateArguments, SANDBOX_LABEL } from "./arguments.js";

const ROOT = "/var/lib/codemugs/work";
const SOURCE = `${ROOT}/run-1/source`;
const IMAGE = `ghcr.io/example/analyser@sha256:${DIGEST}`;

function request(
  overrides: { policy?: unknown; command?: unknown; sourceDirectory?: unknown } = {},
): SandboxRunRequest {
  return validateRunRequest(
    {
      policy: validPolicyInput(),
      command: ["node", "analyse.js", "--json"],
      sourceDirectory: SOURCE,
      ...overrides,
    },
    { workspaceRoot: ROOT },
  );
}

const args = (r: SandboxRunRequest = request()) =>
  dockerCreateArguments(r, "codemugs-sandbox-test");

describe("the arguments of docker create", () => {
  it("are exactly these for the example policy", () => {
    expect(args()).toEqual([
      "create",
      "--name=codemugs-sandbox-test",
      `--label=${SANDBOX_LABEL}`,
      "--pull=never",
      "--network=none",
      "--ipc=private",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534:65534",
      "--pids-limit=128",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--ulimit=nofile=1024:1024",
      "--ulimit=core=0:0",
      "--log-driver=none",
      "--tmpfs=/scratch:rw,noexec,nosuid,nodev,mode=0700,uid=65534,gid=65534,size=64m",
      `--mount=type=bind,src=${SOURCE},dst=/workspace,readonly`,
      "--workdir=/scratch",
      "--entrypoint=node",
      IMAGE,
      "analyse.js",
      "--json",
    ]);
  });

  it("carry the limits of the policy", () => {
    const policy = validPolicyInput();
    policy.limits = { cpus: 0.5, memoryMb: 2_048, pids: 7, wallClockSeconds: 9, outputBytes: 5 };
    policy.mounts.scratch = { containerPath: "/tmp-area", sizeMb: 3 };
    const result = args(request({ policy }));
    expect(result).toContain("--cpus=0.5");
    expect(result).toContain("--memory=2048m");
    expect(result).toContain("--memory-swap=2048m");
    expect(result).toContain("--pids-limit=7");
    expect(result).toContain(
      "--tmpfs=/tmp-area:rw,noexec,nosuid,nodev,mode=0700,uid=65534,gid=65534,size=3m",
    );
    expect(result).toContain("--workdir=/tmp-area");
  });

  it("give the swap the same size as the memory, so that there is none", () => {
    for (const memoryMb of [16, 100, 8_192]) {
      const policy = validPolicyInput();
      policy.limits.memoryMb = memoryMb;
      const result = args(request({ policy }));
      expect(result).toContain(`--memory=${memoryMb}m`);
      expect(result).toContain(`--memory-swap=${memoryMb}m`);
    }
  });

  it("mount the source read-only, with --mount and not -v", () => {
    const result = args();
    const mounts = result.filter((arg) => arg.startsWith("--mount="));
    expect(mounts).toEqual([`--mount=type=bind,src=${SOURCE},dst=/workspace,readonly`]);
    expect(result.some((arg) => arg === "-v" || arg.startsWith("--volume"))).toBe(false);
  });

  it("mount nothing when the policy has no source", () => {
    const result = args(
      request({ policy: changed("mounts.source", undefined), sourceDirectory: undefined }),
    );
    expect(result.some((arg) => arg.startsWith("--mount"))).toBe(false);
    expect(result.some((arg) => arg.includes(SOURCE))).toBe(false);
  });

  it("put the image after every option and the arguments of the command after the image", () => {
    const result = args();
    const at = result.indexOf(IMAGE);
    expect(at).toBeGreaterThan(0);
    expect(result.slice(at + 1)).toEqual(["analyse.js", "--json"]);
    expect(result.slice(0, at).every((arg) => arg === "create" || arg.startsWith("--"))).toBe(true);
    expect(result.filter((arg) => arg === IMAGE)).toHaveLength(1);
  });

  it("make the program the entrypoint, so that the image's own entrypoint never runs", () => {
    expect(args(request({ command: ["/bin/sh", "-c", "id"] }))).toContain("--entrypoint=/bin/sh");
  });

  it("keep what looks like an option, or like a shell, as plain arguments after the image", () => {
    const hostile = [
      "--privileged",
      "--network=host",
      "-v",
      "/:/host",
      "--cap-add=ALL",
      "--device=/dev/mem",
      "--pid=host",
      "--security-opt=seccomp=unconfined",
      "a; rm -rf /",
      "$(id)",
      "",
    ];
    const result = args(request({ command: ["tool", ...hostile] }));
    const at = result.indexOf(IMAGE);
    expect(result.slice(at + 1)).toEqual(hostile);
    expect(result.slice(0, at)).not.toContain("--privileged");
    expect(result.slice(0, at)).not.toContain("--network=host");
    expect(result.slice(0, at)).not.toContain("-v");
  });

  it("write a program that starts with a dash as one argument that cannot be read as an option", () => {
    const result = args(request({ command: ["--privileged"] }));
    expect(result).toContain("--entrypoint=--privileged");
    expect(result).not.toContain("--privileged");
    expect(result.slice(result.indexOf(IMAGE) + 1)).toEqual([]);
  });

  it("never ask for more than the policy can say, whatever the policy is", () => {
    const forbidden = [
      /^--privileged/,
      /^--cap-add/,
      /^--device/,
      /^--volume/,
      /^-v$/,
      /^--volumes-from/,
      /^--network=(?!none$)/,
      /^--net=/,
      /^--pid=/,
      /^--uts=/,
      /^--userns=/,
      /^--cgroupns=host/,
      /^--ipc=(?!private$)/,
      /^--security-opt=(?!no-new-privileges$)/,
      /^--user=(?!65534:65534$)/,
      /^--oom-kill-disable/,
      /^--env/,
      /^-e$/,
      /^--env-file/,
      /^--publish/,
      /^-p$/,
      /docker\.sock/,
      /^--rm$/,
      /^--init/,
      /^--gpus/,
    ];
    const policies = [validPolicyInput(), changed("mounts.source", undefined)] as Array<
      ReturnType<typeof validPolicyInput>
    >;
    const big = validPolicyInput();
    big.limits = {
      cpus: 4,
      memoryMb: 8_192,
      pids: 4_096,
      wallClockSeconds: 3_600,
      outputBytes: 16_777_216,
    };
    big.mounts.scratch.sizeMb = 10_240;
    policies.push(big);
    for (const policy of policies) {
      const result = args(
        request({
          policy,
          sourceDirectory: policy.mounts.source === undefined ? undefined : SOURCE,
        }),
      );
      const options = result.slice(0, result.indexOf(IMAGE));
      for (const option of options) {
        for (const pattern of forbidden) expect(option).not.toMatch(pattern);
      }
      // The ones that must always be there.
      for (const required of [
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=65534:65534",
        "--pull=never",
        "--log-driver=none",
      ]) {
        expect(options).toContain(required);
      }
    }
  });

  it("make the scratch space unable to hold programs to run, or devices, or setuid files", () => {
    const tmpfs = args().find((arg) => arg.startsWith("--tmpfs=")) ?? "";
    for (const option of ["rw", "noexec", "nosuid", "nodev"]) {
      expect(tmpfs.split(":")[1]?.split(",")).toContain(option);
    }
  });

  it("make the scratch space belong to the user the code runs as, and to nobody else", () => {
    const tmpfs = args().find((arg) => arg.startsWith("--tmpfs=")) ?? "";
    const options = tmpfs.split(":")[1]?.split(",") ?? [];
    expect(options).toContain("uid=65534");
    expect(options).toContain("gid=65534");
    expect(options).toContain("mode=0700");
    expect(args()).toContain("--user=65534:65534");
  });

  it("label the container, so that a leftover one can be found", () => {
    expect(args()).toContain("--label=codemugs.sandbox=true");
  });

  it("refuse a request whose source mount and directory do not agree", () => {
    const checked = request();
    const noDirectory = { ...checked, sourceDirectory: null } as unknown as SandboxRunRequest;
    expect(() => dockerCreateArguments(noDirectory, "x")).toThrow(/not consistent/);
    const noMount = request({
      policy: changed("mounts.source", undefined),
      sourceDirectory: undefined,
    });
    const extra = { ...noMount, sourceDirectory: SOURCE } as unknown as SandboxRunRequest;
    expect(() => dockerCreateArguments(extra, "x")).toThrow(/not consistent/);
  });

  it("put the container name only in --name", () => {
    const result = dockerCreateArguments(request(), "codemugs-sandbox-abc");
    expect(result.filter((arg) => arg.includes("codemugs-sandbox-abc"))).toEqual([
      "--name=codemugs-sandbox-abc",
    ]);
  });
});
