import { describe, expect, it } from "vitest";
import { GitHubError } from "./errors.js";
import {
  DEFAULT_API_URL,
  DEFAULT_API_VERSION,
  DEFAULT_DOWNLOAD_HOSTS,
  Transport,
} from "./transport.js";

const refused = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof GitHubError ? error.code : "other";
  }
  return undefined;
};

describe("what the transport is set to by default", () => {
  it("is GitHub's own API, a version of it, and the one host that serves archives", () => {
    expect(DEFAULT_API_URL).toBe("https://api.github.com");
    expect(DEFAULT_API_VERSION).toBe("2026-03-10");
    expect(DEFAULT_DOWNLOAD_HOSTS).toEqual(["codeload.github.com"]);
  });
});

describe("the addresses that a download may go to", () => {
  const transport = new Transport();
  const at = (address: string) => refused(() => transport.downloadUrl(address));

  it("takes the host that serves archives, with the credential that its address carries", () => {
    const url = transport.downloadUrl(
      "https://codeload.github.com/o/r/legacy.tar.gz/abc?token=XYZ",
    );
    expect(url.hostname).toBe("codeload.github.com");
    expect(url.search).toBe("?token=XYZ");
  });

  it.each([
    ["a host that is not allowed", "https://evil.example.com/x"],
    ["a host that only ends like the allowed one", "https://evilcodeload.github.com/x"],
    ["a host that only begins like the allowed one", "https://codeload.github.com.evil.example/x"],
    ["a name of this machine, which is not allowed here", "http://127.0.0.1/x"],
    ["plain http to the allowed host", "http://codeload.github.com/x"],
    ["a login of a user only", "https://user@codeload.github.com/x"],
    ["a login of a password only", "https://:secret@codeload.github.com/x"],
    ["a login of both", "https://user:secret@codeload.github.com/x"],
    ["a fragment", "https://codeload.github.com/x#frag"],
    ["a port that is not the port of https", "https://codeload.github.com:8443/x"],
    ["a scheme that is not http", "ftp://codeload.github.com/x"],
    ["a local file", "file:///etc/passwd"],
    ["a relative address", "/x/y"],
    ["nothing", ""],
  ])("refuses %s", (_name, address) => {
    expect(at(address)).toBe("redirect_refused");
  });

  it("takes the port of https when it is written out, since it is the same", () => {
    expect(at("https://codeload.github.com:443/x")).toBeUndefined();
  });

  it("compares host names without regard to case, on both sides", () => {
    const upper = new Transport({ downloadHosts: ["CodeLoad.GitHub.com"] });
    expect(refused(() => upper.downloadUrl("https://codeload.github.com/x"))).toBeUndefined();
    expect(refused(() => upper.downloadUrl("https://CODELOAD.GITHUB.COM/x"))).toBeUndefined();
  });

  it("takes a port and plain http on this machine when it is the host that was allowed, for tests", () => {
    const local = new Transport({ downloadHosts: ["127.0.0.1"] });
    expect(refused(() => local.downloadUrl("http://127.0.0.1:8123/x?token=a"))).toBeUndefined();
    // Only the host that was allowed: another name of this machine is not.
    expect(refused(() => local.downloadUrl("http://localhost:8123/x"))).toBe("redirect_refused");
  });

  it("does not let a host that was allowed be sent anywhere that is not https, unless it is this machine", () => {
    const remote = new Transport({ downloadHosts: ["files.example.com"] });
    expect(refused(() => remote.downloadUrl("http://files.example.com/x"))).toBe(
      "redirect_refused",
    );
    expect(refused(() => remote.downloadUrl("https://files.example.com:9443/x"))).toBe(
      "redirect_refused",
    );
  });
});

describe("the address of the API", () => {
  it.each([
    ["http to a host that is not this machine", "http://api.example.com"],
    ["a login of a user only", "https://user@api.github.com"],
    ["a login of a password only", "https://:pw@api.github.com"],
    ["a fragment", "https://api.github.com#x"],
    ["a query", "https://api.github.com?x=1"],
    ["a scheme that is not http", "ftp://api.github.com"],
    ["nothing", ""],
  ])("refuses %s", (_name, address) => {
    expect(refused(() => new Transport({ apiBaseUrl: address }))).toBe("invalid_input");
  });

  it.each([
    "https://api.github.com",
    "https://api.github.com/",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://[::1]:3000",
  ])("accepts %s", (address) => {
    expect(refused(() => new Transport({ apiBaseUrl: address }))).toBeUndefined();
  });
});
