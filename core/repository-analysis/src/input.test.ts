import type { TenantClient } from "@codemugs/storage";
import { describe, expect, it } from "vitest";
import { connectRepository, getConnection } from "./connect.js";
import { RepositoryAnalysisError } from "./errors.js";
import { readAnalysisPlan, requestAnalysis } from "./request.js";
import { getAnalysis, listAnalyses } from "./status.js";

/** A client that fails the test if anything is asked of it: what is not valid never gets as far as the database. */
const untouched = (): TenantClient => {
  const fail = (): never => {
    throw new Error("the database was asked");
  };
  return { organisationId: "00000000-0000-4000-8000-000000000001", query: fail } as never;
};

const ID = "00000000-0000-4000-8000-000000000002";
const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return error instanceof RepositoryAnalysisError ? error.code : String(error);
  }
  return "no error";
};

describe("what is not valid is refused before the database is asked", () => {
  const good = { projectId: ID, installationId: 1, owner: "acme", name: "shop" };

  it.each([
    ["a project that is not a UUID", { projectId: "x" }],
    ["an installation of 0", { installationId: 0 }],
    ["an installation that is a fraction", { installationId: 1.5 }],
    ["an installation that is too large to be exact", { installationId: 2 ** 53 }],
    ["an installation that is a string", { installationId: "1" }],
    ["an owner that begins with a hyphen", { owner: "-acme" }],
    ["an owner with a slash", { owner: "acme/shop" }],
    ["an owner of 40 characters", { owner: "a".repeat(40) }],
    ["a name that is a dot", { name: "." }],
    ["a name that is two dots", { name: ".." }],
    ["a name with a slash", { name: "a/b" }],
    ["a name that is empty", { name: "" }],
    ["a name of 101 characters", { name: "n".repeat(101) }],
  ])("connecting: %s", async (_label, overrides) => {
    expect(await code(connectRepository(untouched(), { ...good, ...overrides } as never))).toBe(
      "invalid_input",
    );
  });

  it.each(["", "a b", "a\tb", "a\u0085b", "r".repeat(256)])(
    "requesting: the ref %j",
    async (ref) => {
      expect(await code(requestAnalysis(untouched(), { projectId: ID, ref }))).toBe(
        "invalid_input",
      );
    },
  );

  it("requesting: a project that is not a UUID", async () => {
    expect(await code(requestAnalysis(untouched(), { projectId: "x", ref: "main" }))).toBe(
      "invalid_input",
    );
  });

  it("reading: an id that is not a UUID", async () => {
    expect(await code(getConnection(untouched(), "x"))).toBe("invalid_input");
    expect(await code(readAnalysisPlan(untouched(), "x"))).toBe("invalid_input");
    expect(await code(getAnalysis(untouched(), "x"))).toBe("invalid_input");
    expect(await code(listAnalyses(untouched(), "x"))).toBe("invalid_input");
  });

  it.each([0, 101, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "listing: a limit of %s",
    async (limit) => {
      expect(await code(listAnalyses(untouched(), ID, { limit }))).toBe("invalid_input");
    },
  );

  it("says nothing but a fixed sentence, so that what a caller sent is not given back", async () => {
    try {
      await requestAnalysis(untouched(), { projectId: ID, ref: "secret value\n" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryAnalysisError);
      expect((error as Error).message).toBe("an argument is not valid");
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("does ask the database for what is valid (so that the stub is a real check)", async () => {
    expect(await code(getConnection(untouched(), ID))).toBe("Error: the database was asked");
  });
});
