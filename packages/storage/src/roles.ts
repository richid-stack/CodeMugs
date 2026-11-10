/**
 * The two database roles the running system uses. Infrastructure creates them and migrations
 * refuse to run without them (ADR 0009, ADR 0012). Neither is a superuser, and neither bypasses
 * row-level security.
 */

/** The restricted runtime role: the API, and the transactions a worker runs jobs in. */
export const APP_ROLE = "codemugs_app";

/**
 * The role worker processes use to find the next job in any tenant (ADR 0012). It can see the
 * jobs table and nothing else. The API never holds it.
 */
export const DISPATCHER_ROLE = "codemugs_dispatcher";
