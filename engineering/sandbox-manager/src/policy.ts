import { z } from "zod";
import { isInside, isPlainAbsolutePath } from "./paths.js";

/**
 * The most a policy may ask for. A policy is produced by the policy engine and never by an agent
 * (invariant 4), and these ceilings are the second line behind it: a mistake or a compromised
 * caller still cannot ask for the whole host. They are first values, not measured ones, and they
 * are meant to be changed on purpose, with evidence (ADR 0016).
 */
export const SANDBOX_CEILINGS = Object.freeze({
  cpus: 4,
  memoryMb: 8_192,
  pids: 4_096,
  scratchMb: 10_240,
  wallClockSeconds: 3_600,
  outputBytes: 16 * 1_048_576,
});

/** The smallest values that make sense, so that "0" can never mean "no limit". */
const FLOORS = Object.freeze({ cpus: 0.01, memoryMb: 16, pids: 1, scratchMb: 1, seconds: 1 });

/**
 * A pinned image: `[registry[:port]/]name[/name...]@sha256:<64 hex>`. A tag can be moved to other
 * content after it was reviewed, a digest cannot. Stricter than Docker's own grammar on purpose,
 * and it cannot start with a dash, so it can never be read as an option.
 */
const IMAGE_BY_DIGEST =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

/** Places in a container that belong to the runtime, not to a policy. */
const RESERVED_PREFIXES = ["/proc", "/sys", "/dev"] as const;

/** Where in the sandbox something is mounted: absolute, plain, and not on a runtime path. */
const containerPath = z
  .string()
  .max(255)
  .refine(
    isPlainAbsolutePath,
    "must be an absolute path made of letters, digits, '.', '_' and '-' only, with no trailing slash and no '.' or '..' part",
  )
  .refine(
    (path) => !RESERVED_PREFIXES.some((prefix) => isInside(path, prefix)),
    "must not be on /proc, /sys or /dev",
  );

const wholeNumber = (floor: number, ceiling: number) => z.number().int().min(floor).max(ceiling);

/**
 * What one sandbox run may do. Deny by default: there is no default for any value, so a policy
 * that leaves something out is refused rather than given something. Unknown fields are refused at
 * every level, and there is deliberately no field for what nothing can enforce yet or must not be
 * granted: no network (the network is always off), no credentials, no writable source, no
 * environment, no devices, no extra privileges. Adding one is a decision of its own (ADR 0016).
 */
const policySchema = z
  .strictObject({
    /** The image to run, pinned by digest. */
    image: z
      .string()
      .max(255)
      .regex(IMAGE_BY_DIGEST, "must be pinned by digest: name@sha256:<64 hex digits>"),
    limits: z.strictObject({
      cpus: z.number().min(FLOORS.cpus).max(SANDBOX_CEILINGS.cpus),
      memoryMb: wholeNumber(FLOORS.memoryMb, SANDBOX_CEILINGS.memoryMb),
      pids: wholeNumber(FLOORS.pids, SANDBOX_CEILINGS.pids),
      wallClockSeconds: wholeNumber(FLOORS.seconds, SANDBOX_CEILINGS.wallClockSeconds),
      /** The most standard output and standard error may hold, in bytes, each. */
      outputBytes: wholeNumber(1, SANDBOX_CEILINGS.outputBytes),
    }),
    mounts: z.strictObject({
      /** The code to look at, read-only. Left out when the run needs none. */
      source: z.strictObject({ containerPath }).optional(),
      /** The one place that can be written to, in memory, and gone when the run ends. */
      scratch: z.strictObject({
        containerPath,
        sizeMb: wholeNumber(FLOORS.scratchMb, SANDBOX_CEILINGS.scratchMb),
      }),
    }),
    /** The network is off. The only mode there is says so, so that it has to be written down. */
    network: z.strictObject({ mode: z.literal("none") }),
  })
  .superRefine((policy, context) => {
    const source = policy.mounts.source?.containerPath;
    const scratch = policy.mounts.scratch.containerPath;
    if (source !== undefined && (isInside(source, scratch) || isInside(scratch, source))) {
      context.addIssue({
        code: "custom",
        path: ["mounts"],
        message: "the source and the scratch space must not be the same place or inside each other",
      });
    }
  });

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** A policy that has been checked, copied and frozen. Only {@link parseSandboxPolicy} makes one. */
export type SandboxPolicy = DeepReadonly<z.output<typeof policySchema>>;

/**
 * Why a policy or a request was refused. The message names the fields at fault and why, and never
 * the values, so that nothing a caller sent ends up in a log.
 */
export class SandboxRequestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid sandbox request:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "SandboxRequestError";
    this.issues = issues;
  }
}

/** Describes zod's issues without the values or the field names a caller sent. */
function describeIssues(issues: readonly z.core.$ZodIssue[], prefix = ""): string[] {
  return issues.map((issue) => {
    const where = [prefix, ...issue.path.map(String)].filter((part) => part !== "").join(".");
    const why =
      issue.code === "unrecognized_keys" ? "has a field that a policy cannot have" : issue.message;
    return `${where === "" ? "(root)" : where}: ${why}`;
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * Checks a policy and returns a frozen copy of it, or throws {@link SandboxRequestError}. The copy
 * is what a driver runs, so changing the object that was passed in afterwards changes nothing.
 */
export function parseSandboxPolicy(input: unknown): SandboxPolicy {
  const checked = checkPolicy(input);
  if ("issues" in checked) throw new SandboxRequestError(checked.issues);
  return checked.policy;
}

/** Like {@link parseSandboxPolicy}, but says what was wrong instead of throwing. */
export function checkPolicy(
  input: unknown,
  fieldPrefix = "",
): { readonly policy: SandboxPolicy } | { readonly issues: string[] } {
  const result = policySchema.safeParse(input);
  if (!result.success) return { issues: describeIssues(result.error.issues, fieldPrefix) };
  return { policy: deepFreeze(result.data) };
}
