import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits } from "./edits.js";
import type { Incident } from "./schema.js";

/** The shop as it is on main. */
export const SHOP_DIRECTORY = fileURLToPath(new URL("../../demo-shop/", import.meta.url));

const COPY_README = `# demo-shop

An in-memory order-taking application: it prices orders (discount codes, tax by country, whole
cents), reserves stock, makes an order once when a request is sent twice, and lists a customer's
orders in pages.

| Route                       | What it does                                                                     |
| --------------------------- | -------------------------------------------------------------------------------- |
| \`GET /health\`               | \`{ "ok": true }\`                                                                 |
| \`GET /products\`             | The catalogue                                                                    |
| \`POST /orders\`              | Makes an order. An \`Idempotency-Key\` header makes a repeat return the same one   |
| \`GET /customers/:id/orders\` | Their orders, newest first. \`page\` and \`pageSize\` (default 10, at most 50)        |

It writes one JSON event per line to standard output (see \`src/telemetry.ts\`).

\`\`\`bash
node --test "src/**/*.test.ts"   # Node 22.18 or later runs TypeScript directly
PORT=3000 node src/main.ts
\`\`\`
`;

/**
 * A copy of the shop that stands on its own, as a customer's repository would: its own
 * configuration and its own short readme, and nothing that says where it came from or that anything
 * is wrong with it.
 */
export async function materialiseShop(
  target: string,
  source: string = SHOP_DIRECTORY,
): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(join(source, "src"), join(target, "src"), { recursive: true });
  await writeFile(join(target, "README.md"), COPY_README);

  // The shop's package.json describes the shop's place in this repository (its name, and what it is
  // for), so the copy gets one that only says how to run it.
  const shop = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
    version: string;
    engines: Record<string, string>;
    scripts: Record<string, string>;
  };
  const manifest = {
    name: "demo-shop",
    version: shop.version,
    private: true,
    type: "module",
    engines: shop.engines,
    scripts: shop.scripts,
  };
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The shop's own tsconfig extends the repository's, which is not in a copy, so the options it
  // takes from there are written into the copy's.
  const own = JSON.parse(await readFile(join(source, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  const base = JSON.parse(await readFile(join(source, "../../tsconfig.base.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  const config = {
    compilerOptions: { ...base.compilerOptions, ...own.compilerOptions },
    include: own.include,
  };
  await writeFile(join(target, "tsconfig.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** A copy of the shop with the fault of `incident` in it. Only this is given to the engine. */
export async function materialiseIncident(
  target: string,
  incident: Pick<Incident, "edits">,
  source: string = SHOP_DIRECTORY,
): Promise<void> {
  await materialiseShop(target, source);
  await applyEdits(target, incident.edits);
}
