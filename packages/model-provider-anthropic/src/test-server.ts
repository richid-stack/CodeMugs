import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Not built: a stand-in for the provider's API, on this machine, for the tests of this package.

export interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, seen: Seen) => void;

const servers: Server[] = [];

/** A stand-in for the provider's API, on this machine, that notes what it is sent. */
export async function fakeApi(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const note: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(note);
      handler(request, response, note);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
}

/** Stops every server that was started. Each test file calls this after each test. */
export async function closeServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

export function answer(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "a-model",
    content: [{ type: "text", text: '{"summary":"ok"}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 15 },
    ...overrides,
  };
}
