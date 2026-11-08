// Test helpers shared by packages that have database tests. Import them from
// "@codemugs/storage/testing" in test files only, never from production code.
export { adminDatabaseUrl, APP_ROLE, createTestDatabase } from "./postgres.js";
export type { TestDatabase } from "./postgres.js";
export { findSchemaViolations } from "./schema-guard.js";
