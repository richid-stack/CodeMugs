import { isAbsolute } from "node:path";
import { analyse } from "./analyse.js";
import { directorySource } from "./source.js";

/**
 * The command that runs inside the sandbox: `node main.js <absolute path of the repository>`. It
 * prints the facts as one line of JSON and nothing else, and exits with 0. It prints nothing on
 * failure, and says so by its exit code: what it could say about a failure would come from the
 * repository.
 */
const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  process.exit(2);
}

try {
  const facts = await analyse(directorySource(root));
  process.stdout.write(`${JSON.stringify(facts)}\n`);
} catch {
  process.exit(1);
}
