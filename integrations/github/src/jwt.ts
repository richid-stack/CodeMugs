import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { Secret } from "@codemugs/configuration";
import { GitHubError } from "./errors.js";

/** GitHub accepts a JWT that expires within ten minutes of the moment it is checked. */
const LIFETIME_SECONDS = 540;
/** Issued in the past, so that a clock that is a little ahead of GitHub's does not fail. */
const BACKDATE_SECONDS = 60;

export interface AppJwtOptions {
  /** The app's Client ID (which starts with `Iv`), GitHub's recommended `iss`. */
  readonly clientId: string;
  readonly privateKey: Secret;
  /** Milliseconds since the epoch. For tests. */
  readonly now?: () => number;
}

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The key, or `key_invalid`: a client secret, a public key, a key of another kind or a small one is refused. */
function loadKey(privateKey: Secret): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKey.reveal());
  } catch {
    // The error of the library can say what the input looked like. It is not passed on.
    throw new GitHubError("key_invalid");
  }
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new GitHubError("key_invalid");
  }
  return key;
}

/**
 * A JSON Web Token that says "I am this app", signed with its private key (RS256), good for nine
 * minutes. It is a credential, so it is a {@link Secret}: it is used to ask GitHub for an
 * installation token and for nothing else, and is never stored.
 */
export function createAppJwt(options: AppJwtOptions): Secret {
  const key = loadKey(options.privateKey);
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iat: now - BACKDATE_SECONDS,
    exp: now + LIFETIME_SECONDS,
    iss: options.clientId,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString(
    "base64url",
  );
  return new Secret(`${header}.${payload}.${signature}`);
}
