import { createLogger } from "@codemugs/logging";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { WorkerStartupError } from "./preflight.js";
import { superviseWorker, type WorkerHandle } from "./process.js";

const EVENTS = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const;
type Listener = (...args: unknown[]) => void;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A worker that is running, and what was asked of it. */
function handle(overrides: Partial<{ stop: () => Promise<void>; finished: Promise<void> }> = {}) {
  let end: () => void = () => undefined;
  const finished = overrides.finished ?? new Promise<void>((resolve) => (end = resolve));
  const stop = vi.fn(
    overrides.stop ??
      (() => {
        end();
        return finished;
      }),
  );
  return { stop, finished } satisfies WorkerHandle;
}

describe("superviseWorker", () => {
  const saved = new Map<string, Listener[]>();
  let lines: string[];
  let exit: MockInstance<typeof process.exit>;
  let fatalEvents: number;

  const logger = () => createLogger("debug", (line) => lines.push(line));
  const logged = (text: string): boolean => lines.some((line) => line.includes(text));

  beforeEach(() => {
    lines = [];
    fatalEvents = 0;
    // The test runner has handlers of its own for these, and a fake event would reach them.
    for (const name of EVENTS) {
      saved.set(name, process.listeners(name as "SIGTERM") as Listener[]);
      process.removeAllListeners(name);
    }
    exit = vi.spyOn(process, "exit").mockImplementation((() => {
      fatalEvents += 1;
    }) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const name of EVENTS) {
      process.removeAllListeners(name);
      for (const listener of saved.get(name) ?? []) process.on(name, listener);
    }
    exit.mockRestore();
    process.exitCode = undefined;
  });

  it("starts the worker and returns when it has stopped by itself without a failure", async () => {
    const worker = handle({ finished: Promise.resolve() });
    await superviseWorker({
      logger: logger(),
      shutdownTimeoutMs: 1_000,
      start: () => Promise.resolve(worker),
    });
    expect(logged("worker starting")).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(worker.stop).not.toHaveBeenCalled();
  });

  describe("a refusal to start", () => {
    it("is logged by its code and variable, and ends the program with 1", async () => {
      await superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () =>
          Promise.reject(new WorkerStartupError("wrong_role", "DATABASE_URL", "must be x")),
      });
      expect(process.exitCode).toBe(1);
      const fatal = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line["level"] === "fatal");
      expect(fatal).toMatchObject({ code: "wrong_role", variable: "DATABASE_URL" });
      expect(String(fatal?.["msg"] ?? fatal?.["message"])).toContain("DATABASE_URL");
    });

    it("is not hidden when it is a refusal with a code of its own", async () => {
      await superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () =>
          Promise.reject(
            new WorkerStartupError<"sandbox_unavailable">("sandbox_unavailable", "X", "no"),
          ),
      });
      expect(process.exitCode).toBe(1);
      expect(logged("sandbox_unavailable")).toBe(true);
    });

    it("is the only kind of error that is logged here: any other is thrown to the caller", async () => {
      await expect(
        superviseWorker({
          logger: logger(),
          shutdownTimeoutMs: 1_000,
          start: () => Promise.reject(new Error("could not connect to postgres://u:secret@h/d")),
        }),
      ).rejects.toThrow("could not connect");
      expect(logged("secret")).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("a worker that fails", () => {
    it("is logged and ends the program with 1", async () => {
      const worker = handle({ finished: Promise.reject(new Error("the queue is gone")) });
      worker.finished.catch(() => undefined);
      await superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () => Promise.resolve(worker),
      });
      expect(process.exitCode).toBe(1);
      expect(logged("worker stopped unexpectedly")).toBe(true);
    });

    it("is not reported again when it fails while it was being stopped", async () => {
      let fail: (error: Error) => void = () => undefined;
      const finished = new Promise<void>((_resolve, reject) => (fail = reject));
      finished.catch(() => undefined);
      const worker = handle({ finished, stop: () => finished });
      const done = superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () => Promise.resolve(worker),
      });
      await sleep(5);
      process.emit("SIGTERM");
      fail(new Error("stopped badly"));
      await done;
      await sleep(5);
      expect(logged("worker stopped unexpectedly")).toBe(false);
      // The stop itself failed, which is reported as such.
      expect(logged("error during shutdown")).toBe(true);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("a request to stop", () => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "on %s stops the worker once and says so",
      async (signal) => {
        const worker = handle();
        const done = superviseWorker({
          logger: logger(),
          shutdownTimeoutMs: 1_000,
          start: () => Promise.resolve(worker),
        });
        await sleep(5);
        process.emit(signal);
        // A second request while it is stopping, by the same signal or the other, is not a second stop.
        process.emit(signal);
        process.emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
        await done;
        await sleep(5);
        expect(worker.stop).toHaveBeenCalledTimes(1);
        expect(logged("shutdown requested")).toBe(true);
        expect(logged("shutdown complete")).toBe(true);
        expect(process.exitCode).toBeUndefined();
      },
    );

    it("that comes while the worker is still starting is carried out as soon as it has started", async () => {
      const worker = handle();
      let ready: () => void = () => undefined;
      const starting = new Promise<void>((resolve) => (ready = resolve));
      const done = superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: async () => {
          await starting;
          return worker;
        },
      });
      await sleep(5);
      process.emit("SIGTERM");
      expect(worker.stop).not.toHaveBeenCalled();
      ready();
      await done;
      await sleep(5);
      expect(worker.stop).toHaveBeenCalledTimes(1);
    });

    it("that fails to complete is logged, and ends the program with 1", async () => {
      const worker = handle({
        stop: () => Promise.reject(new Error("pool would not close")),
        finished: new Promise(() => undefined),
      });
      void superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () => Promise.resolve(worker),
      });
      await sleep(5);
      process.emit("SIGTERM");
      await sleep(10);
      expect(logged("error during shutdown")).toBe(true);
      expect(process.exitCode).toBe(1);
    });

    it("that takes too long ends the program with 1, and says that jobs were in progress", async () => {
      const worker = handle({
        stop: () => new Promise(() => undefined),
        finished: new Promise(() => undefined),
      });
      void superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 20,
        start: () => Promise.resolve(worker),
      });
      await sleep(5);
      process.emit("SIGTERM");
      expect(exit).not.toHaveBeenCalled();
      await sleep(60);
      expect(exit).toHaveBeenCalledWith(1);
      expect(logged("exiting with jobs in progress")).toBe(true);
    });

    it("that comes before the worker has started also has its time, and says that nothing had started", async () => {
      void superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 20,
        start: () => new Promise(() => undefined),
      });
      await sleep(5);
      process.emit("SIGINT");
      await sleep(60);
      expect(exit).toHaveBeenCalledWith(1);
      expect(logged("before the worker had started")).toBe(true);
    });
  });

  describe("a process in a state that nobody knows", () => {
    it.each([
      ["uncaught exception", () => process.emit("uncaughtException", new Error("x"))],
      [
        "unhandled rejection",
        () => process.emit("unhandledRejection", new Error("x"), Promise.resolve()),
      ],
    ])("ends on an %s, logging that it did", async (name, raise) => {
      const worker = handle();
      const done = superviseWorker({
        logger: logger(),
        shutdownTimeoutMs: 1_000,
        start: () => Promise.resolve(worker),
      });
      await sleep(5);
      raise();
      expect(fatalEvents).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(logged(name)).toBe(true);
      await worker.stop();
      await done;
    });
  });
});
