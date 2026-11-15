# application-intelligence

**Status:** In progress · Phase 2 Understanding. The analyser (a library and a command) and the schema that checks its answer exist (step 7a). **It is not yet run in the sandbox (7b), its facts are not stored (7c) and there is no GitHub App (7d).** Until 7b, nothing runs it on customer code, and it must not be.

Repository analysis: what a repository holds, as facts. The design is in [ADR 0024](../../docs/architecture/decisions/0024-repository-analysis.md).

## What is here

| Entry                                         | What it is                                                                                                                                                             | Who may use it                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@codemugs/application-intelligence`          | The constants, `repositoryFactsSchema`, `parseRepositoryFacts` (checks text that came out of the sandbox) and the types of facts                                       | The host                                                                                                               |
| `@codemugs/application-intelligence/analyser` | `analyse(source)`, `directorySource(root)` and `memorySource(files)`                                                                                                   | **Only code that runs inside a sandbox** (invariant 8). The tests of this package run it on this repository's own code |
| `dist/main.js <absolute path>`                | The command that the sandbox runs: one line of JSON on stdout and exit 0. Exit 2 for a path that is not absolute, exit 1 for any failure. It prints nothing on failure | The sandbox                                                                                                            |

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

The tests include an analysis of this repository and of the demo shop, the hostile cases (a file of nested brackets, names with control characters, a `package.json` with a token in a dependency), and checks that every answer passes the schema.
