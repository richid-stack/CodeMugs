import { createShop } from "./shop.ts";
import { JsonLinesTelemetry } from "./telemetry.ts";

const port = Number(process.env["PORT"] ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("PORT must be a whole number from 0 to 65535");
  process.exit(1);
}

const telemetry = new JsonLinesTelemetry((line) => {
  process.stdout.write(`${line}\n`);
});
const { server } = createShop({ telemetry });
server.listen(port, "127.0.0.1", () => {
  telemetry.emit("shop.started", { port });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
