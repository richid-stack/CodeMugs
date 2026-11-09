import type { IngestOutcome, IngestScope } from "@codemugs/ingestion";

/**
 * Records a request body of events for the caller named by `scope`. Throws when it cannot, so
 * the client retries; a result means every event was dealt with.
 */
export type EventIngester = (scope: IngestScope, body: unknown) => Promise<IngestOutcome>;
