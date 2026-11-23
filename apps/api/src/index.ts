/**
 * The API as a library, for the test of the whole path (`tests/end-to-end`), which builds it over a
 * real database in the same process as the other programs it drives. The program itself is
 * `main.ts`, which is what `node dist/main.js` runs.
 */
export { buildApp, type BuildAppOptions, type BuiltApp } from "./app.js";
export { appServices, createDatabaseServices, type DatabaseServices } from "./database.js";
