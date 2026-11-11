import { describe, expect, it } from "vitest";
import { describeFailure } from "./failure.js";

const withCode = (message: string, code: unknown): Error =>
  Object.assign(new Error(message), { code });

describe("describeFailure", () => {
  it("names a database error by its SQLSTATE", () => {
    expect(describeFailure(withCode("password authentication failed", "28P01"))).toBe("db_28P01");
    expect(describeFailure(withCode("terminating connection", "57P01"))).toBe("db_57P01");
  });

  it("names a network error by its code", () => {
    expect(describeFailure(withCode("read ECONNRESET", "ECONNRESET"))).toBe("ECONNRESET");
    expect(describeFailure(withCode("connect ECONNREFUSED 10.0.0.5:5432", "ECONNREFUSED"))).toBe(
      "ECONNREFUSED",
    );
  });

  it("says unknown for anything else, and never repeats the message", () => {
    const secret = "customer-value-1234 on host db.internal as user app";
    for (const error of [
      new Error(secret),
      withCode(secret, "not-a-code"),
      withCode(secret, 42),
      withCode(secret, "econnreset"),
      secret,
      undefined,
      null,
    ]) {
      expect(describeFailure(error)).toBe("unknown");
    }
  });
});
