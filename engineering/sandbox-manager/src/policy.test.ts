import { describe, expect, it } from "vitest";
import { DIGEST, changed, validPolicyInput } from "./fixtures.js";
import { parseSandboxPolicy, SANDBOX_CEILINGS, SandboxRequestError } from "./policy.js";

const refusal = (input: unknown): readonly string[] => {
  try {
    parseSandboxPolicy(input);
  } catch (error) {
    if (error instanceof SandboxRequestError) return error.issues;
    throw error;
  }
  throw new Error("the policy was accepted");
};

const refusedAt = (input: unknown, field: string) =>
  expect(refusal(input).some((issue) => issue.startsWith(`${field}:`))).toBe(true);

describe("the ceilings", () => {
  it("are these numbers, so that raising one is a decision made in this file too", () => {
    expect(SANDBOX_CEILINGS).toEqual({
      cpus: 4,
      memoryMb: 8_192,
      pids: 4_096,
      scratchMb: 10_240,
      wallClockSeconds: 3_600,
      outputBytes: 16_777_216,
    });
  });

  it("cannot be changed while the program runs", () => {
    expect(Object.isFrozen(SANDBOX_CEILINGS)).toBe(true);
    expect(() => {
      (SANDBOX_CEILINGS as { cpus: number }).cpus = 64;
    }).toThrow(TypeError);
  });
});

describe("a complete policy", () => {
  it("is accepted and comes back as it was written", () => {
    expect(parseSandboxPolicy(validPolicyInput())).toEqual(validPolicyInput());
  });

  it("does not need a source mount", () => {
    expect(parseSandboxPolicy(changed("mounts.source", undefined)).mounts.source).toBeUndefined();
  });

  it("may use a fraction of a processor and may ask for exactly the ceilings", () => {
    expect(parseSandboxPolicy(changed("limits.cpus", 0.5)).limits.cpus).toBe(0.5);
    const atCeilings = validPolicyInput();
    atCeilings.limits = {
      cpus: SANDBOX_CEILINGS.cpus,
      memoryMb: SANDBOX_CEILINGS.memoryMb,
      pids: SANDBOX_CEILINGS.pids,
      wallClockSeconds: SANDBOX_CEILINGS.wallClockSeconds,
      outputBytes: SANDBOX_CEILINGS.outputBytes,
    };
    atCeilings.mounts.scratch.sizeMb = SANDBOX_CEILINGS.scratchMb;
    expect(parseSandboxPolicy(atCeilings)).toEqual(atCeilings);
  });

  it("is a frozen copy: changing what was passed in later, or the result, changes nothing", () => {
    const input = validPolicyInput();
    const policy = parseSandboxPolicy(input);
    input.limits.memoryMb = 8_000;
    input.network.mode = "host";
    expect(policy.limits.memoryMb).toBe(512);
    expect(policy.network.mode).toBe("none");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.limits)).toBe(true);
    expect(Object.isFrozen(policy.mounts.scratch)).toBe(true);
    expect(() => {
      (policy.limits as { memoryMb: number }).memoryMb = 1;
    }).toThrow(TypeError);
  });
});

describe("a policy gives nothing by default", () => {
  it.each([
    "image",
    "limits",
    "mounts",
    "network",
    "limits.cpus",
    "limits.memoryMb",
    "limits.pids",
    "limits.wallClockSeconds",
    "limits.outputBytes",
    "mounts.scratch",
    "mounts.scratch.containerPath",
    "mounts.scratch.sizeMb",
    "network.mode",
  ])("is refused without %s, naming it", (field) => {
    refusedAt(changed(field, undefined), field);
  });

  it.each([undefined, null, "policy", 7, true, []])("is refused when it is %j", (input) => {
    expect(refusal(input)).toHaveLength(1);
  });

  it.each([
    ["", "credentials", { token: "x" }],
    ["", "privileged", true],
    ["", "capabilities", ["NET_ADMIN"]],
    ["", "user", "root"],
    ["", "environment", { KEY: "value" }],
    ["", "devices", ["/dev/kvm"]],
    ["", "hostNetwork", true],
    ["limits", "swapMb", 1_024],
    ["mounts", "hostPaths", ["/"]],
    ["mounts", "dockerSocket", true],
    ["mounts.source", "readOnly", false],
    ["mounts.source", "writable", true],
    ["mounts.source", "hostPath", "/etc"],
    ["mounts.scratch", "persistent", true],
    ["network", "hosts", ["example.com"]],
  ])("has no field to ask for more, at %j: %s", (parent, name, value) => {
    const policy = validPolicyInput() as unknown as Record<string, unknown>;
    const target = (parent === "" ? [] : parent.split(".")).reduce(
      (node, part) => node[part] as Record<string, unknown>,
      policy,
    );
    target[name] = value;
    expect(refusal(policy)).toContain(
      `${parent || "(root)"}: has a field that a policy cannot have`,
    );
  });

  it("allows no network, and says so: any other mode is refused", () => {
    expect(parseSandboxPolicy(changed("network.mode", "none")).network).toEqual({ mode: "none" });
    for (const mode of ["allowlist", "host", "bridge", "", "None", 1, null]) {
      refusedAt(changed("network.mode", mode), "network.mode");
    }
    refusedAt(changed("network", { mode: "allowlist", hosts: ["example.com"] }), "network");
    refusedAt(changed("network", "none"), "network");
  });
});

describe("limits", () => {
  const limits: Array<[string, number, number]> = [
    ["limits.cpus", 0.01, SANDBOX_CEILINGS.cpus],
    ["limits.memoryMb", 16, SANDBOX_CEILINGS.memoryMb],
    ["limits.pids", 1, SANDBOX_CEILINGS.pids],
    ["limits.wallClockSeconds", 1, SANDBOX_CEILINGS.wallClockSeconds],
    ["limits.outputBytes", 1, SANDBOX_CEILINGS.outputBytes],
    ["mounts.scratch.sizeMb", 1, SANDBOX_CEILINGS.scratchMb],
  ];

  it.each(limits)("%s accepts its smallest and largest value", (field, floor, ceiling) => {
    expect(() => parseSandboxPolicy(changed(field, floor))).not.toThrow();
    expect(() => parseSandboxPolicy(changed(field, ceiling))).not.toThrow();
  });

  it.each(limits)(
    "%s refuses zero, below the floor, above the ceiling and non-numbers",
    (field, floor, ceiling) => {
      for (const bad of [
        0,
        -1,
        floor / 2,
        ceiling + 1,
        Number.NaN,
        Infinity,
        -Infinity,
        "1",
        null,
        true,
      ]) {
        refusedAt(changed(field, bad), field);
      }
    },
  );

  it.each(limits.filter(([field]) => field !== "limits.cpus"))(
    "%s refuses a fraction",
    (field, floor) => {
      refusedAt(changed(field, floor + 0.5), field);
    },
  );
});

describe("the image", () => {
  it.each([
    `alpine@sha256:${DIGEST}`,
    `ghcr.io/example/analyser@sha256:${DIGEST}`,
    `registry.example.com:5000/team/app.name_v2-x@sha256:${DIGEST}`,
    `a/b/c/d@sha256:${"0123456789abcdef".repeat(4)}`,
  ])("accepts %s", (image) => {
    expect(parseSandboxPolicy(changed("image", image)).image).toBe(image);
  });

  it.each([
    ["a tag", "alpine:3.20"],
    ["latest", "alpine:latest"],
    ["a name alone", "alpine"],
    ["a tag next to a digest", `alpine:3.20@sha256:${DIGEST}`],
    ["a short digest", `alpine@sha256:${"a".repeat(63)}`],
    ["a long digest", `alpine@sha256:${"a".repeat(65)}`],
    ["capital letters in the digest", `alpine@sha256:${"A".repeat(64)}`],
    ["another algorithm", `alpine@sha512:${DIGEST}`],
    ["capital letters in the name", `Alpine@sha256:${DIGEST}`],
    ["something that looks like an option", `--privileged@sha256:${DIGEST}`],
    ["an option before the name", `-v /:/host alpine@sha256:${DIGEST}`],
    ["a space", `alpine @sha256:${DIGEST}`],
    ["a newline", `alpine\n@sha256:${DIGEST}`],
    ["a semicolon", `alpine;id@sha256:${DIGEST}`],
    ["a trailing slash", `alpine/@sha256:${DIGEST}`],
    ["an empty name", `@sha256:${DIGEST}`],
    ["text after the digest", `alpine@sha256:${DIGEST}x`],
    ["a URL scheme", `https://alpine@sha256:${DIGEST}`],
    ["a name that is too long", `${"a".repeat(250)}@sha256:${DIGEST}`],
    ["a number", 7],
    ["null", null],
  ])("refuses %s", (_what, image) => {
    refusedAt(changed("image", image), "image");
  });
});

describe("paths inside the sandbox", () => {
  const places = ["mounts.source.containerPath", "mounts.scratch.containerPath"];
  const apply = (field: string, value: unknown): unknown => {
    const policy = changed(field, value) as ReturnType<typeof validPolicyInput>;
    // Keep the other path out of the way so that only the one under test can be at fault.
    if (field.includes("source")) policy.mounts.scratch.containerPath = "/elsewhere";
    else if (policy.mounts.source) policy.mounts.source.containerPath = "/code";
    return policy;
  };

  it.each(places)(
    "%s accepts plain absolute paths, also ones that only start like a reserved place",
    (field) => {
      for (const path of [
        "/work",
        "/a/b-c/d_e.f",
        "/procedure",
        "/system",
        "/devices",
        "/sys.d",
        "/x/proc",
        "/tmpdir",
        "/tmp-area",
        "/x/tmp",
      ]) {
        expect(() => parseSandboxPolicy(apply(field, path))).not.toThrow();
      }
    },
  );

  it.each(places)("%s refuses a path that could change how the mount is read", (field) => {
    for (const path of [
      "/a,b",
      "/a:b",
      "/a=b",
      "/a b",
      "/a\nb",
      "/a\0b",
      "/a;b",
      "/a'b",
      "/a\\b",
      "/a$b",
      "/a*b",
    ]) {
      refusedAt(apply(field, path), field);
    }
  });

  it.each(places)("%s refuses paths that are not plain and absolute", (field) => {
    for (const path of [
      "",
      "/",
      "work",
      "./work",
      "/a/",
      "/a//b",
      "/a/./b",
      "/a/..",
      "/a/../b",
      "/..",
      "/.",
      `/${"a".repeat(255)}`,
      7,
      null,
    ]) {
      refusedAt(apply(field, path), field);
    }
  });

  it.each(places)("%s refuses the places that belong to the runtime", (field) => {
    for (const path of [
      "/proc",
      "/proc/1",
      "/sys",
      "/sys/fs/cgroup",
      "/dev",
      "/dev/shm",
      "/tmp",
      "/tmp/work",
    ]) {
      refusedAt(apply(field, path), field);
    }
  });

  it("refuses a source and a scratch space that are the same place or inside each other", () => {
    for (const [source, scratch] of [
      ["/work", "/work"],
      ["/work", "/work/tmp"],
      ["/work/code", "/work"],
    ] as const) {
      const policy = validPolicyInput();
      policy.mounts.source = { containerPath: source };
      policy.mounts.scratch.containerPath = scratch;
      refusedAt(policy, "mounts");
    }
  });

  it("allows places that only share the beginning of a name", () => {
    const policy = validPolicyInput();
    policy.mounts.source = { containerPath: "/work" };
    policy.mounts.scratch.containerPath = "/workspace";
    expect(() => parseSandboxPolicy(policy)).not.toThrow();
  });
});

describe("what a refusal says", () => {
  it("names the fields and the reason, not the values", () => {
    const marker = "value-that-must-not-be-printed";
    const issues = refusal({
      ...validPolicyInput(),
      image: marker,
      limits: { ...validPolicyInput().limits, memoryMb: marker },
      mounts: { scratch: { containerPath: `/${marker},x`, sizeMb: 64 } },
    });
    expect(issues.some((issue) => issue.startsWith("image:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("limits.memoryMb:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("mounts.scratch.containerPath:"))).toBe(true);
    expect(issues.join("\n")).not.toContain(marker);
  });

  it("does not print the name of a field it does not know", () => {
    const marker = "field-name-that-must-not-be-printed";
    const error = (() => {
      try {
        parseSandboxPolicy({ ...validPolicyInput(), [marker]: 1 });
      } catch (caught) {
        return caught as SandboxRequestError;
      }
      throw new Error("the policy was accepted");
    })();
    expect(error.message).not.toContain(marker);
    expect(error.issues).toContain("(root): has a field that a policy cannot have");
    expect(error.name).toBe("SandboxRequestError");
  });

  it("lists every problem, not just the first", () => {
    const issues = refusal({
      ...validPolicyInput(),
      image: "x",
      network: { mode: "host" },
      limits: {},
    });
    expect(issues.length).toBeGreaterThanOrEqual(7);
  });
});
