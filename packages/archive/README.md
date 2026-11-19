# @codemugs/archive

Unpacks a repository's `.tar.gz` into an empty directory, from bytes that arrive in pieces, with every name, size and count bounded. It is for archives that a customer chose, which are untrusted.

**Status:** Phase 2 · Understanding (started, step 7d-2). The reader exists and is tested, including against archives written to hurt it. **Nothing calls it for a customer yet** (its callers are `analyseArchive` of [`@codemugs/application-intelligence`](../../core/application-intelligence/README.md), which a customer's repository does not reach yet, and the live GitHub check), it has been run on one archive that GitHub made (this repository's, 434 files, in the live check on 2026-11-19), and it is **not isolated**: it runs in the host's process. Release gate 8 is not touched by it. The decision and its limits are in [ADR 0028](../../docs/architecture/decisions/0028-unpacking-a-repository-archive.md).

## What it does

```ts
import { createTarballExtractor } from "@codemugs/archive";

const extractor = await createTarballExtractor({
  destination: "/absolute/path/to/an/empty/directory",
});
// for each piece of the download, in order:
await extractor.write(chunk);
// when the download is complete:
const summary = await extractor.finish(); // counts and sizes, never a name
// if the download fails: await extractor.abort();
```

`extractTarball(source, options)` does the same from an async iterable of bytes.

- Reads what `git archive` makes (ustar headers, extended headers for long names, the global header) and refuses everything else: hard links, devices, pipes, sparse files and GNU long names are `unsupported_entry`.
- Removes the archive's own top directory, and requires every entry to be under the same one.
- Refuses any path that is absolute, goes up, has an empty or `.` name, is not UTF-8 or is too long, and any name that is made twice or used through a file or a link that the archive made (`unsafe_path`).
- Makes a symbolic link to `.` and never reads the target. Makes files with `O_EXCL` and mode 0600, directories with 0700, whatever the archive says.
- Bounds everything (`ARCHIVE_LIMITS`): entries, bytes of content, what the gzip stream expands to, depth, the length of a name and of a path, the memory of the paths, an extended header. A caller can lower a limit and never raise it.
- Fails with an `ArchiveError`, which holds one of seven codes and a fixed sentence and **never** a name, a size or a path from the archive. The first failure stays.

The caller makes the destination (an absolute path to an empty directory that is not a link) and removes it. An unpacking that fails leaves what it made.

## Run on an archive that GitHub made

The tests use `git archive`, which GitHub uses. The live check of [`@codemugs/github`](../../integrations/github/README.md) unpacks the real download, and did so once on 2026-11-19: this repository's archive, 434 files, accepted and removed ([ADR 0028](../../docs/architecture/decisions/0028-unpacking-a-repository-archive.md)). That run did not meet a symbolic link, a path over 79 characters, a file over 76,846 bytes or a private repository.

## What does not exist yet

- **Use for a customer.** `analyseArchive` joins a download, this reader, staging and the analysis ([ADR 0029](../../docs/architecture/decisions/0029-connecting-an-archive-to-the-analysis.md)), and nothing calls it for a customer: the job that would is step 9.
- **Isolation.** The reader has no process of its own, no memory limit from outside and no deadline. See the ADR.

## Testing

`pnpm --filter @codemugs/archive test`. No network and no database. The tests make their archives with `src/testing.ts` (also exported as `@codemugs/archive/testing`), which can write archives that no honest tool would, and one test uses `git archive` from the machine's `git`.
