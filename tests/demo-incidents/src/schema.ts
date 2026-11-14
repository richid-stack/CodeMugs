import { z } from "zod";
import { DETECTOR_NAMES } from "./detectors.js";

export const INCIDENT_KINDS = [
  "null-handling",
  "concurrency",
  "boundary",
  "idempotency",
  "arithmetic",
] as const;

/** A path inside the shop's `src` directory, with no way out of it. */
const sourcePath = z
  .string()
  .regex(/^src\/[a-z0-9][a-z0-9./-]*\.ts$/)
  .refine((path) => !path.split("/").some((part) => part === "" || part === ".." || part === "."), {
    message: "no empty part, . or .. in a path",
  });

/** Lines of text, which are joined with a line feed. A line feed inside a line is not allowed. */
const lines = z
  .array(z.string().refine((line) => !line.includes("\n"), { message: "one line to a string" }))
  .min(1);

export const editSchema = z.strictObject({
  file: sourcePath,
  /** The text to change, which must be in the file exactly once. */
  find: lines,
  replace: lines,
});

export const incidentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  title: z.string().min(5).max(120),
  kind: z.enum(INCIDENT_KINDS),
  severity: z.enum(["low", "medium", "high"]),
  /** 1 is a bug a reader finds from the symptom alone, 3 needs a theory about timing or state. */
  difficulty: z.number().int().min(1).max(3),
  /** What is wrong in the code, for whoever grades a diagnosis. Never given to the engine. */
  rootCause: z.string().min(20),
  /** What puts the fault into a copy of the shop. Undoing them is the reference fix. */
  edits: z.array(editSchema).min(1),
  symptoms: z.strictObject({
    /** The detector in `detectors.ts` that finds it in the shop's telemetry. */
    detector: z.enum(DETECTOR_NAMES),
    /** What shows in the telemetry, in words. */
    telemetry: z.string().min(10),
    /** What a customer would say. It is untrusted text, as every message is. */
    report: z.strictObject({
      channel: z.enum(["support", "chat"]),
      text: z.string().min(10),
    }),
  }),
  /** The shop's own tests that fail when the fault is in, as `file > test name`. */
  witness: z.strictObject({ failingTests: z.array(z.string().min(1)).min(1) }),
});

export type Edit = z.output<typeof editSchema>;
export type Incident = z.output<typeof incidentSchema>;
