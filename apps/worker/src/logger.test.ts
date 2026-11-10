import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function capture(level: Parameters<typeof createLogger>[0]) {
  const lines: string[] = [];
  const logger = createLogger(
    level,
    (line) => lines.push(line),
    () => new Date("2026-03-01T10:00:00.000Z"),
  );
  return { logger, lines };
}

describe("createLogger", () => {
  it("writes one JSON object per line with the level, time and message", () => {
    const { logger, lines } = capture("info");
    logger.info("job succeeded", { jobId: "j1", attempt: 2 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      jobId: "j1",
      attempt: 2,
      level: "info",
      time: "2026-03-01T10:00:00.000Z",
      msg: "job succeeded",
    });
  });

  it("never lets a field replace the level, the time or the message", () => {
    const { logger, lines } = capture("info");
    logger.warn("real message", { level: "debug", time: "yesterday", msg: "forged" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "warn",
      time: "2026-03-01T10:00:00.000Z",
      msg: "real message",
    });
  });

  it("writes only what the configured level asks for", () => {
    const { logger, lines } = capture("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    logger.fatal("e");
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(["c", "d", "e"]);
  });

  it("writes nothing at all when silent", () => {
    const { logger, lines } = capture("silent");
    logger.fatal("e");
    logger.error("d");
    expect(lines).toEqual([]);
  });

  it("leaves out fields that are undefined", () => {
    const { logger, lines } = capture("info");
    logger.info("m", { present: "yes", absent: undefined });
    expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("absent");
  });
});
