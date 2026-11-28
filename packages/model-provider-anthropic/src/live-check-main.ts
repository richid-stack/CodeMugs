import { Secret } from "@codemugs/configuration";
import { runLiveCheck } from "./live-check.js";

// Run by hand from the "Model provider check" workflow, from main only. The key comes from the
// environment of that one step, and is never printed. The model's name and the prices are not secret.

function whole(name: string, fallback: number): number {
  const text = process.env[name];
  const value = text === undefined || text === "" ? fallback : Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`${name} is not a whole number`);
    process.exit(2);
  }
  return value;
}

const key = process.env["CODEMUGS_MODEL_API_KEY"];
const model = process.env["CODEMUGS_MODEL_NAME"];
if (key === undefined || key === "") {
  console.error("CODEMUGS_MODEL_API_KEY is not set");
  process.exit(2);
}
if (model === undefined || model === "") {
  console.error("CODEMUGS_MODEL_NAME is not set");
  process.exit(2);
}

const result = await runLiveCheck({
  apiKey: new Secret(key),
  model,
  // Upper bounds, so that what a step is reserved for under the cap is more than it can cost.
  price: {
    inputMicrosPerMillionTokens: whole("CODEMUGS_MODEL_INPUT_MICROS_PER_MILLION", 15_000_000),
    outputMicrosPerMillionTokens: whole("CODEMUGS_MODEL_OUTPUT_MICROS_PER_MILLION", 75_000_000),
  },
  capMicros: whole("CODEMUGS_MODEL_CHECK_CAP_MICROS", 200_000),
  out: (line) => {
    console.log(line);
  },
});
process.exit(result.passed ? 0 : 1);
