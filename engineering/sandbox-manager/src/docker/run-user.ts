import { randomInt } from "node:crypto";

/**
 * The user and group a run's code has inside the container. Every run gets ids of its own (ADR 0021).
 *
 * The kernel counts some limits per user and not per container: `inotify` instances and watches,
 * for one. Under the hardened container the container is not in a user namespace of its own, so
 * the numbers are the host's, and runs that shared one id shared those limits with each other and
 * with every other process of that user on the host. A run that used them up made the others fail.
 */
export interface RunUser {
  readonly uid: number;
  readonly gid: number;
}

/**
 * The range the ids are drawn from, both ends included. It is chosen to be a range that no user of
 * a host is likely to have:
 *
 * - above every range that systemd documents for users (system users, dynamic service users, home
 *   directory users, and the ranges of containers, which end at 1 879 048 191), so that it is not
 *   the id of a user of the host;
 * - below 2^31, because some code (the kernel's `devpts` among it, as systemd's own documentation
 *   says) reads an id as a signed number.
 *
 * It is wide (200 million), so that two runs at once almost never get the same one. Nothing relies
 * on that: a collision gives two runs the same user, which is what every run had before, and the
 * runs still do not see each other (their processes, memory and files are their own). A host that
 * maps container ids through a user namespace (Docker's `userns-remap`) is not one this driver has
 * been tried on, and ids outside what it maps would make the run fail to start, not run unsafely.
 */
export const FIRST_RUN_ID = 1_900_000_000;
export const LAST_RUN_ID = 2_099_999_999;

/** A user and group that no other run has, as far as chance allows. */
export function newRunUser(): RunUser {
  // `randomInt` draws evenly, from the system's secure source, so that the next id cannot be
  // guessed from the last. It excludes the upper bound.
  const id = randomInt(FIRST_RUN_ID, LAST_RUN_ID + 1);
  return { uid: id, gid: id };
}

/** True for a user that is a whole number in the range. Anything else is a mistake of the caller. */
export function isRunUser(user: RunUser): boolean {
  return [user.uid, user.gid].every(
    (id) => Number.isSafeInteger(id) && id >= FIRST_RUN_ID && id <= LAST_RUN_ID,
  );
}
