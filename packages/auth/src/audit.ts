import type { TenantClient } from "@codemugs/storage";

/** Who did it. `system` is the platform itself, for example during bootstrap. */
export type AuditActor = { type: "system" } | { type: "api_key" | "user" | "operator"; id: string };

/** Everything the platform records so far. Add a value here when something new is recorded. */
export type AuditAction =
  "organisation.created" | "project.created" | "api_key.issued" | "api_key.revoked";

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  target?: { type: "organisation" | "project" | "api_key"; id: string };
  requestId?: string;
  /**
   * Small, flat context. Never secrets or personal data (repository invariant 3), and never an
   * API key. The database rejects anything over 4 KiB.
   */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Appends one entry to the organisation's audit log, inside the caller's tenant transaction so
 * the entry commits or rolls back together with the change it describes. The organisation is the
 * one the transaction acts for; it cannot be chosen here.
 */
export async function recordAudit(client: TenantClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (organisation_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      client.organisationId,
      entry.actor.type,
      entry.actor.type === "system" ? null : entry.actor.id,
      entry.action,
      entry.target?.type ?? null,
      entry.target?.id ?? null,
      entry.requestId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
