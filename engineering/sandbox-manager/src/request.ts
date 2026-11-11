import { isInside, isPlainAbsolutePath } from "./paths.js";
import { checkPolicy, SandboxRequestError, type SandboxPolicy } from "./policy.js";

/** Limits on the command, so that one request cannot be made of an unbounded amount of text. */
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_PATH_LENGTH = 1_024;

declare const checked: unique symbol;

/**
 * One run, checked. A request is made only by {@link validateRunRequest}, which copies and freezes
 * it, and a driver refuses any request that did not come from there (see
 * {@link assertValidatedRequest}), so the policy a driver runs is the policy that was checked.
 */
export interface SandboxRunRequest {
  readonly [checked]: true;
  readonly policy: SandboxPolicy;
  /** The program and its arguments. Never passed through a shell. */
  readonly command: readonly [string, ...string[]];
  /** The directory on the host that is shown read-only at `policy.mounts.source`, or null. */
  readonly sourceDirectory: string | null;
}

const validated = new WeakSet<object>();

/**
 * Checks a run request and returns a frozen copy, or throws {@link SandboxRequestError}.
 *
 * `workspaceRoot` is the folder the sandbox manager keeps its working copies in. A source directory
 * has to be inside it, and it is a check on the path as written: a driver must also resolve
 * symbolic links before it mounts anything (ADR 0016).
 */
export function validateRunRequest(
  input: unknown,
  options: { workspaceRoot: string },
): SandboxRunRequest {
  if (!isPlainAbsolutePath(options.workspaceRoot)) {
    throw new TypeError("workspaceRoot must be a plain absolute path");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SandboxRequestError(["(root): must be an object"]);
  }
  const fields = input as Record<string, unknown>;
  const issues: string[] = [];

  if (Object.keys(fields).some((key) => !["policy", "command", "sourceDirectory"].includes(key))) {
    issues.push("(root): has a field that a request cannot have");
  }

  const checkedPolicy = checkPolicy(fields["policy"], "policy");
  const policy = "policy" in checkedPolicy ? checkedPolicy.policy : undefined;
  if ("issues" in checkedPolicy) issues.push(...checkedPolicy.issues);

  const command = checkCommand(fields["command"], issues);
  const sourceDirectory = checkSourceDirectory(
    fields["sourceDirectory"],
    policy?.mounts.source !== undefined,
    options.workspaceRoot,
    policy !== undefined,
    issues,
  );

  if (issues.length > 0 || policy === undefined || command === undefined) {
    throw new SandboxRequestError(issues);
  }
  const request = Object.freeze({
    policy,
    command: Object.freeze(command),
    sourceDirectory,
  }) as unknown as SandboxRunRequest;
  validated.add(request);
  return request;
}

function checkCommand(
  value: unknown,
  issues: string[],
): readonly [string, ...string[]] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("command: must be a list with the program first");
    return undefined;
  }
  if (value.length > MAX_ARGUMENTS) {
    issues.push(`command: must have at most ${MAX_ARGUMENTS} items`);
    return undefined;
  }
  const items: unknown[] = value;
  if (!items.every((item): item is string => typeof item === "string")) {
    issues.push("command: every item must be text");
    return undefined;
  }
  const strings: string[] = items;
  if (strings[0] === "") issues.push("command: the program must not be empty");
  if (strings.some((item) => item.length > MAX_ARGUMENT_LENGTH)) {
    issues.push(`command: no item may be longer than ${MAX_ARGUMENT_LENGTH} characters`);
  }
  if (strings.some((item) => item.includes("\0"))) {
    issues.push("command: no item may contain a null character");
  }
  const [program, ...rest] = strings;
  // A new array, so that the caller's own array is never the one that is frozen and run.
  return program === undefined ? undefined : [program, ...rest];
}

function checkSourceDirectory(
  value: unknown,
  wanted: boolean,
  workspaceRoot: string,
  policyIsValid: boolean,
  issues: string[],
): string | null {
  if (!wanted) {
    // Without a source mount in the policy there is nothing to show, so a path is a mistake.
    if (value !== undefined && value !== null && policyIsValid) {
      issues.push("sourceDirectory: must be left out when the policy has no source mount");
    }
    return null;
  }
  if (typeof value !== "string") {
    issues.push("sourceDirectory: must be given, as text, when the policy has a source mount");
    return null;
  }
  if (
    value.length > MAX_PATH_LENGTH ||
    !isPlainAbsolutePath(value) ||
    value === workspaceRoot ||
    !isInside(value, workspaceRoot)
  ) {
    issues.push("sourceDirectory: must be a plain absolute path inside the workspace");
    return null;
  }
  return value;
}

/**
 * For a driver to call first. Throws unless the request was made by {@link validateRunRequest}, so
 * a request that was built by hand, or cast to the type, never reaches a runtime.
 */
export function assertValidatedRequest(request: SandboxRunRequest): void {
  if (!validated.has(request)) {
    throw new SandboxRequestError(["(root): was not made by validateRunRequest"]);
  }
}
