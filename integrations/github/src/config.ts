import { parseEnv, Secret, type Env } from "@codemugs/configuration";
import { z } from "zod";

const numericId = (what: string) =>
  z.string({ error: "is required" }).regex(/^[1-9][0-9]{0,14}$/, `must be ${what}, a whole number`);

const credentialsShape = {
  CODEMUGS_GITHUB_APP_ID: numericId("the App ID"),
  // New apps have a Client ID that starts with `Iv` and is 20 characters long.
  CODEMUGS_GITHUB_APP_CLIENT_ID: z
    .string({ error: "is required" })
    .regex(/^Iv[0-9A-Za-z.]{8,40}$/, "must be the app's Client ID, which starts with Iv"),
  CODEMUGS_GITHUB_APP_PRIVATE_KEY: z
    .string({ error: "is required" })
    .refine(
      (value) => value.trim().startsWith("-----BEGIN "),
      "must be the private key in the .pem file that GitHub gives (it starts with -----BEGIN), not a client secret",
    ),
};

type CredentialsEnv = { [Name in keyof typeof credentialsShape]: string };

const credentialsOf = (env: CredentialsEnv) => ({
  appId: Number(env.CODEMUGS_GITHUB_APP_ID),
  clientId: env.CODEMUGS_GITHUB_APP_CLIENT_ID,
  /** A key kept in a variable often has its line breaks written as `\\n`. */
  privateKey: new Secret(normaliseKey(env.CODEMUGS_GITHUB_APP_PRIVATE_KEY)),
});

const credentialsSchema = z.object(credentialsShape).transform(credentialsOf);

const schema = z
  .object({
    ...credentialsShape,
    CODEMUGS_GITHUB_APP_INSTALLATION_ID: numericId("the installation ID"),
  })
  .transform((env) => ({
    ...credentialsOf(env),
    installationId: Number(env.CODEMUGS_GITHUB_APP_INSTALLATION_ID),
  }));

function normaliseKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("\n") ? trimmed : trimmed.replaceAll("\\n", "\n");
}

export type GitHubAppConfig = z.output<typeof schema>;
export type GitHubAppCredentials = z.output<typeof credentialsSchema>;

/**
 * The settings of the GitHub App, from the environment. The identifiers are not secrets; the
 * private key is, and is a {@link Secret}. An error names the variable and never its value.
 */
export function loadGitHubAppConfig(env: Env = process.env): GitHubAppConfig {
  return parseEnv(schema, env);
}

/**
 * The app's own settings and no installation: what a process needs that serves more than one
 * installation, as the process that analyses the repositories of customers does (ADR 0035): the
 * installation to use is each request's, the one that its organisation was given, so the process has
 * none of its own. The key is a {@link Secret}, and an error names the variable and never its value.
 */
export function loadGitHubAppCredentials(env: Env = process.env): GitHubAppCredentials {
  return parseEnv(credentialsSchema, env);
}
