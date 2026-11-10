import type { WorkerEvent } from "@codemugs/jobs";
import { describe, expect, it } from "vitest";
import { logWorkerEvent } from "./events.js";
import { createLogger } from "./logger.js";

const job = {
  jobId: "7c1f0a52-1111-4222-8333-944455556666",
  organisationId: "0b8e7d10-aaaa-4bbb-8ccc-ddddeeeeffff",
  kind: "events.aggregate",
  attempt: 2,
};

function logged(event: WorkerEvent): Array<Record<string, unknown>> {
  const lines: string[] = [];
  logWorkerEvent(
    createLogger(
      "trace",
      (line) => lines.push(line),
      () => new Date(0),
    ),
    event,
  );
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("logWorkerEvent", () => {
  it("reports each kind of event with its identifiers, and a code where there is one", () => {
    expect(logged({ type: "claimed", ...job })[0]).toMatchObject({ level: "debug", ...job });
    expect(logged({ type: "succeeded", ...job })[0]).toMatchObject({ level: "info", ...job });
    expect(logged({ type: "retrying", code: "db_40001", ...job })[0]).toMatchObject({
      level: "warn",
      code: "db_40001",
      ...job,
    });
    expect(logged({ type: "dead", code: "missing_batch", ...job })[0]).toMatchObject({
      level: "error",
      code: "missing_batch",
      ...job,
    });
    expect(logged({ type: "lease_lost", ...job })[0]).toMatchObject({ level: "warn", ...job });
    expect(logged({ type: "error", phase: "claim", code: "db_57P01" })[0]).toMatchObject({
      level: "error",
      phase: "claim",
      code: "db_57P01",
    });
  });

  it("writes nothing but the fields it chooses, even if an event carries more", () => {
    const carrying = {
      type: "retrying",
      code: "handler_error",
      ...job,
      message: "card 4000-0000-customer-value failed",
      payload: { secret: "customer-value" },
      stack: "Error: customer-value",
    } as unknown as WorkerEvent;
    const [line] = logged(carrying);
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ["attempt", "code", "jobId", "kind", "level", "msg", "organisationId", "time"].sort(),
    );
    expect(JSON.stringify(line)).not.toContain("customer-value");
  });

  it("does the same for an error that is not about a job", () => {
    const carrying = {
      type: "error",
      phase: "complete",
      code: "unknown",
      jobId: "j",
      message: "customer-value",
    } as unknown as WorkerEvent;
    const [line] = logged(carrying);
    expect(JSON.stringify(line)).not.toContain("customer-value");
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ["code", "jobId", "level", "msg", "phase", "time"].sort(),
    );
  });
});
