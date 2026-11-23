import { verifyWorkerDatabase, WorkerStartupError, type DatabaseProbes } from "@codemugs/jobs";
import { APP_ROLE, DISPATCHER_ROLE, type Pool } from "@codemugs/storage";

export { WorkerStartupError };
export type { DatabaseStartupCode as StartupCode } from "@codemugs/jobs";

/** What this process's handlers use. The checks themselves are the jobs library's. */
const PROBES: DatabaseProbes = {
  app: [
    "SELECT 1 FROM jobs LIMIT 1",
    "SELECT batch_id FROM events LIMIT 1",
    "SELECT event_count FROM event_aggregates LIMIT 1",
  ],
  dispatcher: ["SELECT 1 FROM jobs LIMIT 1"],
};

/**
 * Checks, before any job is taken, that each connection is the role it should be, that the role
 * has no more power than the role contract allows, and that the schema has what the handlers use.
 * See `verifyWorkerDatabase` for what each check is for. `roles` is for tests, which use throwaway
 * roles.
 */
export function verifyDatabase(
  pools: { app: Pool; dispatcher: Pool },
  roles: { app: string; dispatcher: string } = { app: APP_ROLE, dispatcher: DISPATCHER_ROLE },
): Promise<void> {
  return verifyWorkerDatabase(pools, PROBES, roles);
}
