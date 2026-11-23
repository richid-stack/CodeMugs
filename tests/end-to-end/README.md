# end-to-end

**Status:** In progress · Phase 2 Understanding, step 9a, sixth part · [ADR 0038](../../docs/architecture/decisions/0038-the-test-of-the-whole-path.md)

The whole path of the first slice, in one test: a request to the API connects a repository and asks for it to be analysed, the process that analyses repositories takes the job, downloads the repository from a stand-in for GitHub (which serves [the demo shop](../demo-shop/README.md) as an archive), has it analysed and stores the graph, and the API serves that graph back, only to the project it belongs to. Everything between is the real code over a real PostgreSQL: the API, the queue, the process and its startup checks, the analyser, the store and the reads. Only GitHub is replaced.

This package holds tests and nothing that is built or run: it is private and has no `dist/`. It starts the API and the process in the test's own process, through the entry points that `@codemugs/api` and `@codemugs/analysis-worker` export for that (`src/index.ts` in each).

## Two flavours

The same scenario runs with two sandboxes:

- **A real sandbox** (docker, `hardened-container`, no network, the image `CODEMUGS_TEST_NODE_IMAGE`). It needs a docker daemon and that image on the host. Without them it is skipped; CI sets `REQUIRE_DOCKER_TESTS=true` and the image, so there a missing daemon or image fails the run.
- **A stand-in sandbox**, which runs the same command on this machine with no isolation, over a repository of ours. It shows the path and nothing of isolation, and it is what runs where there is no docker.

## What it shows

- Before anything has been analysed, the graph is `404 graph_not_found` and the analysis is `queued`.
- After the process has run, two analyses of the same commit have succeeded, and the API serves both: the latest is the second, each is of the commit that was analysed, and the same commit gives the same digest, nodes and edges.
- Paging through the nodes gives as many as the run says, with the demo shop's routes, its environment variable and its files, with the paths as the repository has them.
- What a change to a file reaches (importers) and what a file is joined to answer from the stored graph.
- GitHub was asked about the repository of the connection, with the installation that the operator bound, and the commit it was asked to download is the one the branch resolved to.
- No line of the shop's source is in what the API gives or in what the process logged, and no key or connection string is in the log.
- Another project of the same organisation, and another organisation, get the same `404` for every graph route.
- No unpacked or staged copy of the repository is left in the working folder.

## What it does not show

GitHub itself (an archive is served by a stand-in, so the App's token exchange, rate limits and a private repository are not exercised here), a large repository, the time a real one takes, rate limiting, or that isolation holds: **release gate 8 has not started and no isolation claim is made.** Nothing here may be switched on for a customer.

## Running it

```bash
export CODEMUGS_TEST_DATABASE_URL=postgres://…   # a superuser on a disposable PostgreSQL
pnpm build
pnpm --filter @codemugs/end-to-end test
```

Set `CODEMUGS_TEST_NODE_IMAGE` (a Node image pinned by digest, present on the host) as well to run the real-sandbox flavour.
