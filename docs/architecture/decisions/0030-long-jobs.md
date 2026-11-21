# 0030. Jobs that take long: the work runs with no transaction open

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR 0012](0012-jobs-and-cross-tenant-claiming.md) runs a handler inside the tenant's transaction and completes the job in the same one, so a handler's writes happen exactly once. That is right for a job that reads and writes rows (the hourly counts of [ADR 0013](0013-event-processing.md)). It does not fit the work that comes next: analysing a repository downloads up to 512 MiB, unpacks it, runs a sandbox for up to two minutes and then stores the graph ([ADR 0029](0029-connecting-an-archive-to-the-analysis.md)), and later work calls a model. None of that is the database's, and it takes minutes.

The pool ends a session that sits idle inside a transaction after 30 seconds (`idleInTransactionTimeoutMs`), and an open transaction also holds a connection and holds back the cleaning of old rows. A handler that waits for a download inside its transaction would have its session ended by the database.

Testing that showed something worse. The pool listens for an error on a connection that is **idle in the pool**, and not on one that is checked out. When the database ended a session that a handler was holding, the connection's `error` event had no listener and was an uncaught exception, which ends the process. A worker would have stopped, for every tenant, because one handler waited too long.

## Decision

1. **A job that takes long is registered with `longJob(handler)`, and its work runs with no transaction open.** The handler gets `context.read(body)`, which runs `body` in a short transaction restricted to the job's organisation and ends it, and `context.signal`. It does its work and **returns a commit**: a function that is given the tenant's transaction client. The worker runs the commit and completes the job in one transaction, so what the commit writes is exactly once, as a handler's writes are. What the work does outside the database is at least once, as before. An ordinary function is still a handler of the old kind, and one worker can run both.
2. **`read` is bound to the job's organisation.** The work cannot choose another one: it is given no pool, only the means to read as the tenant that the job belongs to. The test reads through it with rows of another organisation present and sees none of them.
3. **A failure of the work is the same as a failure of a handler.** A `JobFailure` keeps its code and its choice of retrying, anything else is `handler_error` with the message dropped, and a database error is its SQLSTATE. A run whose lease was taken over has its commit rolled back and is turned away (`lease_lost`).
4. **`withTenant` listens for an error on its connection while the transaction is open.** When the database ends the session, the work's transaction fails with that error (the first one, which is the cause, and not what the next query says of it), nothing is committed, and the connection is discarded and not returned to the pool. A job that was cut off this way is recorded as `db_25p03`. This is a fix to every user of `withTenant`, the API as well as the worker.
5. **The lease has to be longer than the work.** There are still no heartbeats ([ADR 0012](0012-jobs-and-cross-tenant-claiming.md)). The worker that runs long jobs sets a long lease (up to a day is accepted) and passes `context.signal`, which aborts when the lease runs out, to what it calls.

## Rejected alternatives

- **Raise the idle timeout of the pool.** It would hide the problem for every other handler and every request, and it would still hold a connection and a snapshot for minutes.
- **Send a query now and then from the handler to keep the session busy.** It keeps the transaction open, and with it the connection and the snapshot, to work around a limit that is there for a reason.
- **Give the handler the pool and let it open its own transactions.** It could then open one for any organisation, and tenant isolation would depend on every handler getting that right ([ADR 0006](0006-tenant-isolation.md)). `read` does not have the choice to get wrong.
- **Make every handler two phases.** The jobs that exist read and write quickly, and the one transaction is simpler and is what they were tested as.

## Consequences

- **Nothing uses it yet.** The job that analyses a repository is the first long job. By [ADR 0014](0014-worker-process.md) it does not run in `apps/worker`, which never reads repository contents, but in a worker of its own.
- **Connections.** Each `read` and the commit take a connection for as long as they run and not for the whole job, so the rule that the application pool needs as many connections as the concurrency is more than enough for long jobs, and is kept.
- **The work can still be done twice.** A lease that runs out while the work is still going gives the job to another worker. The commit of the first is turned away, and the work of both was done. A long job has to be safe to repeat, and the analysis is (its run id is the idempotency key, [ADR 0026](0026-system-graph-storage.md)).
- **What was run.** Locally, on PostgreSQL 16, `pnpm verify` passed with the database tests required: 116 tests in `@codemugs/jobs` (14 are new: ten against the database for long jobs, four for what the worker refuses to start with) and 152 in `@codemugs/storage` (five new, for the connection's error), none skipped. The tests include a long job that waits for four times the idle limit of a pool whose limit is a third of a second and is stored once; the same wait in an ordinary handler, which the database ends and which is recorded as `db_25p03` (before the fix of decision 4 this test showed the uncaught error: the run reported two unhandled errors); a read that sees none of another organisation's rows; a commit that fails and is rolled back, with the work done again on the next attempt; a failure of the work stored by its code and never its message; a lease taken over during the work, whose commit is rolled back; and the signal that aborts at the end of the lease. Twelve deliberate bugs were put into the new code one at a time (a long job run as an ordinary one, a job never completed, a read in another organisation, a signal that never aborts, a handler that is not checked, a null handler, no listener, the last error kept and not the first, a commit after a lost session, the follow-on error thrown, a listener left on, a dead connection returned to the pool) and each was caught; the check of a commit that is not a function was removed because nothing could tell it from the error that its absence gives. CI runs the same tests on PostgreSQL 17 and 18, and what it ran is in the pull request and is not claimed here.
