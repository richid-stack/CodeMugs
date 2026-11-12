import type { SandboxRunRequest } from "../request.js";

/** `nobody` on the usual images: a user and a group that own nothing. */
const UNPRIVILEGED_UID = 65534;
const UNPRIVILEGED_GID = 65534;

/** The label every container of ours carries, so that a leftover one can be found and removed. */
export const SANDBOX_LABEL = "codemugs.sandbox=true";

/**
 * The arguments of `docker create` for one checked request. Nothing here is taken from the caller
 * except what the policy allows, and every hardening option is written out, so that the daemon's
 * defaults decide nothing that matters (they can differ between machines).
 *
 * - No network, no shared IPC, a read-only root filesystem, no capabilities and no way to gain
 *   any, and a user that owns nothing.
 * - Memory, swap (none: the same value), processes, processors, open files and core files are
 *   limited, and the output is not kept by the daemon (it would fill the host's disk).
 * - The only writable place is a size-limited memory filesystem that cannot hold programs to run,
 *   and that only the unprivileged user can use. (Docker makes it owned by root unless told
 *   otherwise, which the real daemon showed: the user could not write to it.)
 * - The source is a read-only bind mount, written with `--mount` (which refuses a missing path)
 *   and not `-v` (which would create it).
 * - The program is the entrypoint and the rest of the command follows the image, where an item
 *   that looks like an option is only an argument. The image's own entrypoint never runs.
 * - The image must already be on the host (`--pull=never`): fetching is not something a run does.
 * - A runtime is asked for by name only when the driver has one (gVisor). It is a fixed name chosen
 *   by the driver, never a value from the request.
 */
export function dockerCreateArguments(
  request: SandboxRunRequest,
  containerName: string,
  runtime?: string,
): string[] {
  const { policy, command, sourceDirectory } = request;
  if ((policy.mounts.source === undefined) !== (sourceDirectory === null)) {
    throw new Error("the request is not consistent: a source mount needs a source directory");
  }
  const [program, ...rest] = command;
  const { limits, mounts } = policy;
  const memory = `${limits.memoryMb}m`;
  const args = [
    "create",
    `--name=${containerName}`,
    `--label=${SANDBOX_LABEL}`,
    "--pull=never",
    ...(runtime === undefined ? [] : [`--runtime=${runtime}`]),
    "--network=none",
    "--ipc=private",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${UNPRIVILEGED_UID}:${UNPRIVILEGED_GID}`,
    `--pids-limit=${limits.pids}`,
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--cpus=${limits.cpus}`,
    "--ulimit=nofile=1024:1024",
    "--ulimit=core=0:0",
    "--log-driver=none",
    `--tmpfs=${mounts.scratch.containerPath}:rw,noexec,nosuid,nodev,mode=0700,uid=${UNPRIVILEGED_UID},gid=${UNPRIVILEGED_GID},size=${mounts.scratch.sizeMb}m`,
  ];
  if (mounts.source !== undefined && sourceDirectory !== null) {
    args.push(
      `--mount=type=bind,src=${sourceDirectory},dst=${mounts.source.containerPath},readonly`,
    );
  }
  args.push(
    `--workdir=${mounts.scratch.containerPath}`,
    `--entrypoint=${program}`,
    policy.image,
    ...rest,
  );
  return args;
}
