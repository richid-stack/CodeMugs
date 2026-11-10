export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

/**
 * What a log line may carry besides its message: plain values only. An error, a request, a row or
 * any other object cannot be passed by accident, which is the point (repository invariant 3). A
 * caller still has to pass only identifiers and short codes.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface Logger {
  fatal(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

const SEVERITY = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
} as const satisfies Record<LogLevel, number>;

/**
 * One JSON object per line on standard output, which is where an orchestrator collects it. The
 * level, time and message are written last, so a field can never replace them.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => Date = () => new Date(),
): Logger {
  const threshold = SEVERITY[level];
  const emit =
    (own: Exclude<LogLevel, "trace" | "silent">) =>
    (message: string, fields: LogFields = {}): void => {
      if (SEVERITY[own] < threshold) return;
      write(JSON.stringify({ ...fields, level: own, time: now().toISOString(), msg: message }));
    };
  return {
    fatal: emit("fatal"),
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
  };
}
