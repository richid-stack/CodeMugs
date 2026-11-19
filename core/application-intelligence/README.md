# application-intelligence

**Status:** In progress · Phase 2 Understanding. The analyser (a library and a command), the schema that checks its answer (step 7a) and the host's way of running it in a sandbox (step 7b) exist. **Its facts can be stored by [`@codemugs/system-graph`](../system-graph/README.md) (7c) but nothing does so yet, there is no GitHub App (7d), and nothing yet calls it for a customer: it has been run in a real sandbox only over this repository, the demo shop and test repositories.** How much isolation a sandbox gives is the sandbox manager's to show, and release gate 8 is not started.

Repository analysis: what a repository holds, as facts. The design is in [ADR 0024](../../docs/architecture/decisions/0024-repository-analysis.md), and how it runs in a sandbox is in [ADR 0025](../../docs/architecture/decisions/0025-analysis-in-the-sandbox.md).

## What is here

| Entry                                         | What it is                                                                                                                                                                                                                                                             | Who may use it                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@codemugs/application-intelligence`          | The constants, `repositoryFactsSchema`, `parseRepositoryFacts` (checks text that came out of the sandbox), the types of facts, and `analyseInSandbox`, `analyseArchive`, `stageAnalysis`, `AnalysisError` and `ANALYSIS_SANDBOX` (the ways to run the analysis, below) | The host                                                                                                               |
| `@codemugs/application-intelligence/analyser` | `analyse(source)`, `directorySource(root)` and `memorySource(files)`                                                                                                                                                                                                   | **Only code that runs inside a sandbox** (invariant 8). The tests of this package run it on this repository's own code |
| `dist/main.js <absolute path>`                | The command that the sandbox runs: one line of JSON on stdout and exit 0. Exit 2 for a path that is not absolute, exit 1 for any failure. It prints nothing on failure                                                                                                 | The sandbox                                                                                                            |

## Running it in a sandbox

`analyseInSandbox({ driver, workspaceRoot, image, minimumIsolation, repository })` is the one way for the host to analyse a repository, and the only code that may call it for a customer's. It copies the analyser, the parser and the repository into a new directory (`tool/` and `repo/`), shows that directory read-only to a run with no network, parses the answer with the schema, and removes the directory. The caller chooses the driver, the image (pinned by digest) and the weakest isolation that it accepts, and **there is no default for that**. The limits of the run are written in `ANALYSIS_SANDBOX`.

A failure is an `AnalysisError`, one of eleven short codes, each with a fixed sentence: nothing that the system, the sandbox or the repository said is ever in it. A repository that has a file or a directory that cannot be read is refused, not analysed in part. A working copy that could not be removed is `cleanup_failed`, and is reported even when something else failed first.

What has been run: in CI, the analysis of the demo shop and of this repository in a hardened Docker container and in gVisor gives the same facts as the same analyser in this process, and a repository written to hurt it does too. What has not: a repository larger than this one, one with its dependencies installed (the sandbox has no network), and any measure of how much a sandbox isolates.

## Analysing an archive

`analyseArchive({ driver, workspaceRoot, image, minimumIsolation, archive })` does the same for a repository that is a `.tar.gz`: it checks the sandbox first (so that nothing is downloaded for a host that cannot run it), takes the archive from `archive`, a function that gives it piece by piece to the sink it is handed (for the GitHub client, `(sink) => reader.downloadTarball(owner, name, ref, { maxBytes, onChunk: sink })`), unpacks it as it arrives with `@codemugs/archive` into `checkout-*` under the workspace, has it analysed as above, and removes both copies. The decision is [ADR 0029](../../docs/architecture/decisions/0029-connecting-an-archive-to-the-analysis.md).

An archive that is not a repository's (not gzip, cut short, a path that goes outside, a kind of entry that is refused) is `repository_unreadable`, one that is more than the unpacking accepts is `repository_too_large`, and a disk that cannot be written is `sandbox_failed`; the unpacking's own code is not kept. What the source throws when the download is what failed is thrown as it was. **Unpacking is on the host and is not isolated** ([ADR 0028](../../docs/architecture/decisions/0028-unpacking-a-repository-archive.md)), a repository is on the host's disk twice while it runs, and nothing calls it for a customer. In CI the real-sandbox tests unpack an archive of the demo shop and analyse it in each runtime; that test had not been run when this was written.

## What the facts hold

For each repository: the files (path, language, role, bytes, lines), the packages (every `package.json`: name, version, module type, dependencies by kind and source, names of scripts), the imports of TypeScript and JavaScript files (resolved to a file of the repository, a package, a built-in module or nothing), the environment variables that are read (names and how often, never values), the routes (with how sure the analysis is), the frameworks, and what was cut short or left out and why.

It holds **no file content and no secret**. A dependency from git, a URL or a file is recorded as that kind. A script is recorded by its name and not its command. Paths, specifiers and names still come from the repository, so they are **data and never instructions** (invariant 2).

## Limits, which are part of the contract

- TypeScript and JavaScript are parsed. Every other file is inventoried only.
- A route that is matched by a regular expression or built from variables is not found. A route found by comparing a request's method and path is a `heuristic`.
- Imports are resolved by relative path and by the extension swaps of TypeScript, and not through `tsconfig` paths, `exports` or workspaces.
- `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache` and `.codemugs` are not read, and symbolic links are never followed.
- Limits on files, bytes, imports, routes and time are in `ANALYSIS_LIMITS`. A caller can lower them and never raise them, and `limits.truncated` says what was cut short.

## Working here

```bash
pnpm --filter @codemugs/application-intelligence build
pnpm --filter @codemugs/application-intelligence test     # the command's tests need the build first
node core/application-intelligence/dist/main.js "$PWD"    # the facts for this repository
```

The tests in `sandbox.integration.test.ts` run the analysis in a real sandbox. They need a docker daemon and a Node image pinned by digest in `CODEMUGS_TEST_NODE_IMAGE` (CI sets it), and are skipped without them. With `REQUIRE_DOCKER_TESTS` and `REQUIRE_GVISOR_TESTS` set to `true` (CI does) a missing daemon, runtime or image is a failure and not a skip.

The tests include an analysis of this repository and of the demo shop, the hostile cases (a file of nested brackets, names with control characters, a `package.json` with a token in a dependency), and checks that every answer passes the schema.
