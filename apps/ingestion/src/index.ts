export { MAX_EVENTS_PER_BATCH } from "@codemugs/event-schemas";
export { recordEvents } from "./record.js";
export type {
  EventResult,
  IngestOptions,
  IngestOutcome,
  IngestResult,
  IngestScope,
} from "./record.js";
export {
  checkBatchShape,
  EARLIEST_OCCURRED_AT,
  MAX_ATTRIBUTE_DEPTH,
  MAX_FUTURE_MS,
  validateEvent,
} from "./validate.js";
export type { BatchShapeError, Rejection, RejectionReason } from "./validate.js";
