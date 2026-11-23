import {
  EDGE_KINDS,
  GraphError,
  NODE_KINDS,
  type GraphNode,
  type RunRecord,
} from "@codemugs/system-graph-read";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GraphService } from "../graph.js";
import { requireScope } from "../scopes.js";

/** A page is 100 unless the caller says, and never more than 1,000 (the library would allow more). */
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1_000;
const WHOLE_LIMIT = /^[1-9][0-9]{0,3}$/;
const DEPTH = /^[1-9][0-9]?$/;
// An id of a node is a whole number that fits the integer column that holds it.
const NODE_ID = /^(0|[1-9][0-9]{0,8})$/;
// A key is at most 1,024 characters, and a text that holds a NUL cannot be stored or compared.
const MAX_KEY = 1_024;

function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

const invalid = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
  refuse(request, reply, 400, "invalid_input", "A parameter of the request is not valid");

const noGraph = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
  refuse(request, reply, 404, "graph_not_found", "No graph was found for that analysis");

const noNode = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
  refuse(request, reply, 404, "node_not_found", "No such node was found in that graph");

/**
 * The query string as text that has only the parameters that the route takes. A parameter that the
 * route does not take is refused and not ignored, so that a client that names a project of its own
 * is told that it cannot (invariant 1: the project is the key's), and one that is given twice is
 * refused too, since it is not one text.
 */
function parametersOf(
  request: FastifyRequest,
  allowed: readonly string[],
): Record<string, string> | undefined {
  const query = request.query as Record<string, unknown>;
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (!allowed.includes(name) || typeof value !== "string") return undefined;
    found[name] = value;
  }
  return found;
}

const isText = (value: string): boolean =>
  value.length >= 1 && value.length <= MAX_KEY && !value.includes("\0");

/** A page size from the query: `undefined` when it was not given, `null` when it is not valid. */
function pageOf(text: string | undefined): number | null {
  if (text === undefined) return DEFAULT_PAGE;
  if (!WHOLE_LIMIT.test(text)) return null;
  const size = Number(text);
  return size <= MAX_PAGE ? size : null;
}

const oneOf = <T extends string>(allowed: readonly T[], text: string): T | undefined =>
  allowed.find((value) => value === text);

const toRunBody = (run: RunRecord) => ({
  id: run.id,
  projectId: run.projectId,
  revision: run.revision,
  factsVersion: run.factsVersion,
  nodes: run.nodeCount,
  edges: run.edgeCount,
  truncated: run.truncated,
  summary: run.summary,
  digest: run.digest,
  analysedAt: run.analysedAt,
});

const toNodeBody = (node: GraphNode) => ({
  id: node.id,
  kind: node.kind,
  key: node.key,
  attributes: node.attributes,
});

/**
 * The routes that read the graph that an analysis found. Registered inside the authenticated
 * scope, so `request.principal` is always set. The organisation and the project are the
 * credential's and nothing in a request can name another. All need `analysis:read` (ADR 0033).
 *
 * The id in a path is the analysis's, which is also its run's (ADR 0032). What comes back is names
 * from a customer's repository (paths, packages, routes): data, and never instructions. A graph
 * that is not the key's project's, one that does not exist and one that is not made yet (the
 * analysis has not succeeded) are the same `404 graph_not_found`.
 */
export function registerGraphRoutes(
  v1: FastifyInstance,
  { graph }: { graph: GraphService | undefined },
): void {
  const callerOf = (request: FastifyRequest) => {
    const principal = request.principal;
    if (principal === null) {
      // Unreachable: the authentication hook answers every request that has no principal.
      throw new Error("authenticated route reached without a principal");
    }
    return principal;
  };

  const unavailable = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    refuse(request, reply, 503, "graph_unavailable", "Reading the graph is not available");

  /**
   * Runs a route, and answers a `GraphError` for a parameter as `400`. Any other error is not the
   * caller's to see: it goes on to the error handler, which answers 500 and logs it.
   */
  async function answering(
    request: FastifyRequest,
    reply: FastifyReply,
    work: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GraphError && error.code === "invalid_input") {
        return invalid(request, reply);
      }
      throw error;
    }
  }

  /** `GET /v1/graph`: the graph of the key's project as it is now. */
  v1.get("/graph", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (graph === undefined) return unavailable(request, reply);
    if (parametersOf(request, []) === undefined) return invalid(request, reply);
    return answering(request, reply, async () => {
      const run = await graph.latest(principal);
      if (run === undefined) {
        return refuse(request, reply, 404, "graph_not_found", "This project has no graph yet");
      }
      return { run: toRunBody(run) };
    });
  });

  /** `GET /v1/analyses/:id/graph`: what one analysis found, in numbers. */
  v1.get("/analyses/:id/graph", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (graph === undefined) return unavailable(request, reply);
    if (parametersOf(request, []) === undefined) return invalid(request, reply);
    const { id } = request.params as { id: string };
    return answering(request, reply, async () => {
      const run = await graph.run(principal, id);
      return run === undefined ? noGraph(request, reply) : { run: toRunBody(run) };
    });
  });

  /** `GET /v1/analyses/:id/nodes`: the nodes, in the order of their ids, a page at a time. */
  v1.get("/analyses/:id/nodes", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (graph === undefined) return unavailable(request, reply);
    const parameters = parametersOf(request, ["kind", "limit", "after"]);
    const limit = pageOf(parameters?.limit);
    const kind = parameters?.kind === undefined ? undefined : oneOf(NODE_KINDS, parameters.kind);
    const after = parameters?.after;
    if (
      parameters === undefined ||
      limit === null ||
      (parameters.kind !== undefined && kind === undefined) ||
      (after !== undefined && !NODE_ID.test(after))
    ) {
      return invalid(request, reply);
    }
    const { id } = request.params as { id: string };
    return answering(request, reply, async () => {
      const nodes = await graph.nodes(principal, id, {
        limit,
        ...(kind === undefined ? {} : { kind }),
        ...(after === undefined ? {} : { afterId: Number(after) }),
      });
      if (nodes === undefined) return noGraph(request, reply);
      // A page that is full may be followed by another: `next` is what to pass as `after`.
      const last = nodes.at(-1);
      return {
        nodes: nodes.map(toNodeBody),
        ...(nodes.length === limit && last !== undefined ? { next: last.id } : {}),
      };
    });
  });

  /** `GET /v1/analyses/:id/node?kind=&key=`: one node, by what it is and its key. */
  v1.get("/analyses/:id/node", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (graph === undefined) return unavailable(request, reply);
    const parameters = parametersOf(request, ["kind", "key"]);
    const kind = parameters?.kind === undefined ? undefined : oneOf(NODE_KINDS, parameters.kind);
    const key = parameters?.key;
    if (kind === undefined || key === undefined || !isText(key)) return invalid(request, reply);
    const { id } = request.params as { id: string };
    return answering(request, reply, async () => {
      const node = await graph.node(principal, id, kind, key);
      if (node === undefined) return noGraph(request, reply);
      return node === null ? noNode(request, reply) : { node: toNodeBody(node) };
    });
  });

  /** `GET /v1/analyses/:id/nodes/:nodeId/neighbours`: what a node is joined to, one edge away. */
  v1.get(
    "/analyses/:id/nodes/:nodeId/neighbours",
    { onRequest: requireScope("analysis:read") },
    (request, reply) => {
      const principal = callerOf(request);
      if (graph === undefined) return unavailable(request, reply);
      const parameters = parametersOf(request, ["direction", "edge", "limit"]);
      const limit = pageOf(parameters?.limit);
      const direction = oneOf(["out", "in"] as const, parameters?.direction ?? "out");
      const edge = parameters?.edge === undefined ? undefined : oneOf(EDGE_KINDS, parameters.edge);
      const { id, nodeId } = request.params as { id: string; nodeId: string };
      if (
        parameters === undefined ||
        limit === null ||
        direction === undefined ||
        (parameters.edge !== undefined && edge === undefined) ||
        !NODE_ID.test(nodeId)
      ) {
        return invalid(request, reply);
      }
      return answering(request, reply, async () => {
        const found = await graph.neighbours(principal, id, Number(nodeId), {
          direction,
          limit,
          ...(edge === undefined ? {} : { kind: edge }),
        });
        if (found === undefined) return noGraph(request, reply);
        if (found === null) return noNode(request, reply);
        return {
          neighbours: found.map((entry) => ({
            edge: { kind: entry.edge.kind, attributes: entry.edge.attributes },
            node: toNodeBody(entry.node),
          })),
        };
      });
    },
  );

  /**
   * `GET /v1/analyses/:id/imports?path=&direction=&depth=&limit=`: the files that a file reaches
   * through imports. `importers` is what a change to the file can reach, `imports` what it depends on.
   */
  v1.get(
    "/analyses/:id/imports",
    { onRequest: requireScope("analysis:read") },
    (request, reply) => {
      const principal = callerOf(request);
      if (graph === undefined) return unavailable(request, reply);
      const parameters = parametersOf(request, ["path", "direction", "depth", "limit"]);
      const limit = pageOf(parameters?.limit);
      const direction = oneOf(["importers", "imports"] as const, parameters?.direction ?? "");
      const path = parameters?.path;
      const depth = parameters?.depth;
      if (
        parameters === undefined ||
        limit === null ||
        direction === undefined ||
        path === undefined ||
        !isText(path) ||
        (depth !== undefined && !DEPTH.test(depth))
      ) {
        return invalid(request, reply);
      }
      const { id } = request.params as { id: string };
      return answering(request, reply, async () => {
        const files = await graph.imports(principal, id, path, {
          direction,
          limit,
          ...(depth === undefined ? {} : { maxDepth: Number(depth) }),
        });
        if (files === undefined) return noGraph(request, reply);
        if (files === null) return noNode(request, reply);
        return { files: files.map((file) => ({ ...toNodeBody(file.node), depth: file.depth })) };
      });
    },
  );
}
