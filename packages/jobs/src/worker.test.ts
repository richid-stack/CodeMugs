import type { Pool } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  infrastructureCode,
  JobConfigurationError,
  JobFailure,
} from "./errors.js";
import { claimJobs, enqueueJob, requeueJob } from "./queue.js";
import { runWorker, type JobHandler, type WorkerOptions } from "./worker.js";

// None of these touch a database: every check below happens before the first query, and the
// stubs fail loudly if that ever stops being true.
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be used");
    },
  },
);
const pool = (max: number): Pool => ({ options: { max } }) as unknown as Pool;
const tenantClient = {
  organisationId: "00000000-0000-4000-8000-000000000000",
  query: () => Promise.reject(new Error("the database must not be used")),
};
const handler: JobHandler = () => Promise.resolve();

describe("classifyFailure", () => {
  it("keeps the code and retry choice of a JobFailure", () => {
    expect(classifyFailure(new JobFailure("rate_limited"))).toEqual({
      code: "rate_limited",
      retryable: true,
    });
    expect(classifyFailure(new JobFailure("bad_input", { retryable: false }))).toEqual({
      code: "bad_input",
      retryable: false,
    });
  });

  it.each([
    ["spaces", "has spaces"],
    ["an email address", "jane@example.com"],
    ["upper case", "Rate_Limited"],
    ["empty", ""],
    ["too long", "a".repeat(65)],
    ["a line break", "a\nb"],
  ])("replaces a code with %s", (_label, code) => {
    expect(classifyFailure(new JobFailure(code))).toEqual({
      code: "invalid_failure_code",
      retryable: true,
    });
  });

  it("accepts a code of exactly 64 characters", () => {
    expect(classifyFailure(new JobFailure("a".repeat(64))).code).toBe("a".repeat(64));
  });

  it("records a database error by its SQLSTATE and nothing else", () => {
    const error = Object.assign(new Error("duplicate key value violates ... (jane@example.com)"), {
      code: "23505",
      detail: "Key (email)=(jane@example.com) already exists.",
    });
    expect(classifyFailure(error)).toEqual({ code: "db_23505", retryable: true });
  });

  it.each([
    ["an ordinary error", new Error("contains customer data")],
    ["a Node system error", Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" })],
    ["a string", "contains customer data"],
    ["undefined", undefined],
    ["an object", { message: "contains customer data" }],
  ])("records %s as handler_error", (_label, thrown) => {
    expect(classifyFailure(thrown)).toEqual({ code: "handler_error", retryable: true });
  });
});

describe("infrastructureCode", () => {
  it("is the SQLSTATE for a database error and 'unknown' for anything else", () => {
    expect(infrastructureCode(Object.assign(new Error("x"), { code: "57P01" }))).toBe("57P01");
    expect(infrastructureCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "unknown",
    );
    expect(infrastructureCode(new Error("x"))).toBe("unknown");
  });
});

describe("enqueueJob", () => {
  it.each(["", "Upper", "1abc", "has space", "a".repeat(65), "tab\t"])(
    "refuses the kind %j before touching the database",
    async (kind) => {
      await expect(enqueueJob(tenantClient, { kind })).rejects.toBeInstanceOf(
        JobConfigurationError,
      );
    },
  );

  it.each(["not-a-uuid", "", "00000000-0000-4000-8000-00000000000"])(
    "refuses the subject id %j",
    async (subjectId) => {
      await expect(enqueueJob(tenantClient, { kind: "ok", subjectId })).rejects.toBeInstanceOf(
        JobConfigurationError,
      );
    },
  );

  it.each([0, 101, 1.5, Number.NaN])("refuses maxAttempts %s", async (maxAttempts) => {
    await expect(enqueueJob(tenantClient, { kind: "ok", maxAttempts })).rejects.toBeInstanceOf(
      JobConfigurationError,
    );
  });

  it("does not repeat a bad value in its error", async () => {
    const failure = await enqueueJob(tenantClient, { kind: "ok", subjectId: "secret-value" }).catch(
      (error: unknown) => error,
    );
    expect(String((failure as Error).message)).not.toContain("secret-value");
  });
});

describe("requeueJob", () => {
  it("refuses a bad kind or subject before touching the database", async () => {
    await expect(requeueJob(tenantClient, { kind: "Bad", subjectId: "x" })).rejects.toBeInstanceOf(
      JobConfigurationError,
    );
    await expect(requeueJob(tenantClient, { kind: "ok", subjectId: "x" })).rejects.toBeInstanceOf(
      JobConfigurationError,
    );
  });
});

describe("claimJobs", () => {
  const valid = { kinds: ["ok"], limit: 1, leaseSeconds: 60 };
  it.each([
    ["no kinds", { ...valid, kinds: [] }],
    ["a bad kind", { ...valid, kinds: ["Bad"] }],
    ["a zero limit", { ...valid, limit: 0 }],
    ["a limit over 100", { ...valid, limit: 101 }],
    ["a fractional limit", { ...valid, limit: 1.5 }],
    ["a zero lease", { ...valid, leaseSeconds: 0 }],
    ["a lease over a day", { ...valid, leaseSeconds: 86_401 }],
  ])("refuses %s before touching the database", async (_label, options) => {
    await expect(claimJobs(noDatabase as Pool, options)).rejects.toBeInstanceOf(
      JobConfigurationError,
    );
  });
});

describe("runWorker", () => {
  const base = (): WorkerOptions => ({
    dispatcher: noDatabase as Pool,
    app: pool(10),
    handlers: { ok: handler },
    signal: new AbortController().signal,
  });

  it.each([
    ["no handlers", { handlers: {} }],
    ["a handler kind that is not a valid name", { handlers: { "Not Valid": handler } }],
    ["zero concurrency", { concurrency: 0 }],
    ["a fractional concurrency", { concurrency: 1.5 }],
    ["more than 100 jobs at once", { concurrency: 101 }],
    ["a poll interval under 10 ms", { pollIntervalMs: 5 }],
    ["a zero lease", { leaseSeconds: 0 }],
    ["a lease over a day", { leaseSeconds: 86_401 }],
    ["an application pool smaller than the concurrency", { app: pool(2), concurrency: 4 }],
  ])("refuses %s, before it takes any job", async (_label, change) => {
    await expect(runWorker({ ...base(), ...change })).rejects.toBeInstanceOf(JobConfigurationError);
  });

  it("returns at once, taking nothing, when it is already told to stop", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runWorker({ ...base(), signal: controller.signal })).resolves.toBeUndefined();
  });
});
