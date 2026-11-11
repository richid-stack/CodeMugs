/** A complete, valid policy, as plain data a caller might send. Tests change a copy of it. */
export const DIGEST = "a".repeat(64);

export interface PolicyInput {
  image: string;
  limits: {
    cpus: number;
    memoryMb: number;
    pids: number;
    wallClockSeconds: number;
    outputBytes: number;
  };
  mounts: {
    source?: { containerPath: string };
    scratch: { containerPath: string; sizeMb: number };
  };
  network: { mode: string };
}

export function validPolicyInput(): PolicyInput {
  return {
    image: `ghcr.io/example/analyser@sha256:${DIGEST}`,
    limits: { cpus: 1, memoryMb: 512, pids: 128, wallClockSeconds: 60, outputBytes: 1_048_576 },
    mounts: {
      source: { containerPath: "/workspace" },
      scratch: { containerPath: "/scratch", sizeMb: 64 },
    },
    network: { mode: "none" },
  };
}

/** Sets the value at a dotted path of a copy of the valid policy (undefined removes the field). */
export function changed(path: string, value: unknown): unknown {
  const policy = validPolicyInput() as unknown as Record<string, unknown>;
  const parts = path.split(".");
  let at = policy;
  for (const part of parts.slice(0, -1)) at = at[part] as Record<string, unknown>;
  const last = parts.at(-1) as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return policy;
}
