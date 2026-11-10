import { aggregateEventsHandler, EVENTS_AGGREGATE_KIND } from "@codemugs/ingestion";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers.js";

describe("the registered handlers", () => {
  it("run the event aggregation and nothing else yet", () => {
    expect(Object.keys(handlers)).toEqual([EVENTS_AGGREGATE_KIND]);
    expect(handlers[EVENTS_AGGREGATE_KIND]).toBe(aggregateEventsHandler);
  });
});
