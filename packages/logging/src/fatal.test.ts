import { describe, expect, it } from "vitest";
import { describeFatal } from "./fatal.js";

describe("describeFatal", () => {
  it("gives the kind of error and where it happened, and not its message", () => {
    const error = new TypeError("the value customer-value-1234 is not valid");
    const described = describeFatal(error);
    expect(described["errorType"]).toBe("TypeError");
    expect(String(described["frames"])).toContain("fatal.test");
    expect(JSON.stringify(described)).not.toContain("customer-value-1234");
  });

  it("does not let a message that imitates a stack frame through", () => {
    const error = new Error("first customer-value-1234\n    at imitation (somewhere.js:1:1)");
    const described = describeFatal(error);
    expect(JSON.stringify(described)).not.toContain("customer-value-1234");
    expect(JSON.stringify(described)).not.toContain("imitation");
  });

  it("writes no frames when the stack does not start with the message", () => {
    const error = new Error("customer-value-1234");
    error.stack = "customer-value-1234 and whatever follows\n    at somewhere (x.js:1:1)";
    expect(describeFatal(error)).toEqual({ errorType: "Error" });
  });

  it("handles an error with no message", () => {
    const described = describeFatal(new RangeError());
    expect(described["errorType"]).toBe("RangeError");
    expect(String(described["frames"])).toContain("fatal.test");
  });

  it("keeps the SQLSTATE of a database error, and nothing it quotes", () => {
    const error = Object.assign(new Error('invalid input syntax: "customer-value-1234"'), {
      code: "22P02",
      severity: "ERROR",
      detail: "Failing row contains (customer-value-1234)",
    });
    const described = describeFatal(error);
    expect(described["code"]).toBe("22P02");
    expect(JSON.stringify(described)).not.toContain("customer-value-1234");
  });

  it("does not take a Node system error code for a SQLSTATE", () => {
    const error = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(describeFatal(error)).not.toHaveProperty("code");
  });

  it("says only that something that is not an error was thrown", () => {
    expect(describeFatal("customer-value-1234")).toEqual({ errorType: "NonError" });
    expect(describeFatal({ message: "customer-value-1234" })).toEqual({ errorType: "NonError" });
    expect(describeFatal(undefined)).toEqual({ errorType: "NonError" });
  });
});
