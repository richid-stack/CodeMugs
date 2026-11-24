import type { DataClass } from "./types.js";

/**
 * Which classes of an organisation's data may go to a model provider. It is the platform's rule, read
 * from the organisation's own setting, and is not something that an agent or a request can change
 * (invariant 4). See the [data classification](../../../docs/security/data-classification.md), which
 * is a draft: the defaults are for the owner to confirm.
 */
export interface ModelPolicy {
  permittedClasses(organisationId: string): Promise<ReadonlySet<DataClass>>;
}

/** Nothing may be sent. The default: a class is sent only when a policy says so. */
export const denyAll: ModelPolicy = {
  permittedClasses: () => Promise.resolve(new Set<DataClass>()),
};

/** The same classes for every organisation, which is for tests and for a deployment that has decided so. */
export function permitClasses(classes: Iterable<DataClass>): ModelPolicy {
  const permitted: ReadonlySet<DataClass> = new Set(classes);
  return { permittedClasses: () => Promise.resolve(permitted) };
}
