import {
  RepositoryAnalysisError,
  type AnalysisState,
  type RepositoryAnalysisErrorCode,
  type RepositoryConnection,
} from "@codemugs/repository-analysis";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AnalysisService } from "../analysis.js";
import { requireScope } from "../scopes.js";

/** What a caller is told of a request that cannot be done. Fixed sentences: nothing it sent comes back. */
const REFUSALS: Readonly<Record<RepositoryAnalysisErrorCode, { status: number; message: string }>> =
  {
    invalid_input: { status: 400, message: "A field of the request is not valid" },
    project_not_found: { status: 404, message: "The project of this API key was not found" },
    // Not told apart from an installation that another organisation has.
    installation_not_found: {
      status: 404,
      message: "That GitHub installation is not available to this organisation",
    },
    connection_exists: {
      status: 409,
      message: "This project is connected to a repository already",
    },
    connection_not_found: { status: 404, message: "This project is not connected to a repository" },
  };

function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

/**
 * Runs a route, and answers a `RepositoryAnalysisError` as what it is. Any other error is not the
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
    if (error instanceof RepositoryAnalysisError) {
      const refusal = REFUSALS[error.code];
      return refuse(request, reply, refusal.status, error.code, refusal.message);
    }
    throw error;
  }
}

/**
 * The body as an object that has the fields that the route takes and no other. A field that the
 * route does not take is refused and not ignored, so that a client that sends a project of its own
 * choosing is told that it cannot, and not left to think that it did (invariant 1: the project is
 * the key's).
 */
function bodyWith(body: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((key) => fields.includes(key)) ? record : undefined;
}

const toConnectionBody = (connection: RepositoryConnection) => ({
  connectionId: connection.connectionId,
  projectId: connection.projectId,
  installationId: connection.installationId,
  owner: connection.owner,
  name: connection.name,
  connectedAt: connection.connectedAt,
});

/** The analysis as the API gives it: its id is the request's, which is also the run's. */
const toAnalysisBody = (state: AnalysisState) => ({
  id: state.requestId,
  projectId: state.projectId,
  ref: state.ref,
  requestedAt: state.requestedAt,
  status: state.status,
  attempts: state.attempts,
  ...(state.failureCode === undefined ? {} : { failureCode: state.failureCode }),
  ...(state.run === undefined ? {} : { run: state.run }),
});

// A page size is a plain number of one to four digits; the library says how large it may be.
const LIMIT = /^[1-9][0-9]{0,3}$/;

/**
 * The routes that connect the repository of the key's project and ask for it to be analysed.
 * Registered inside the authenticated scope, so `request.principal` is always set. The
 * organisation and the project are the credential's and nothing in a request can name another.
 *
 * Connecting and asking need `analysis:write` and reading needs `analysis:read`; neither implies
 * the other (ADR 0033). A request is recorded and a job queued here and the repository is read by
 * a worker of its own, so a `202` means "will be done", and `GET /v1/analyses/:id` says how it is
 * going (ADR 0031).
 */
export function registerAnalysisRoutes(
  v1: FastifyInstance,
  { analysis }: { analysis: AnalysisService | undefined },
): void {
  const unavailable = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    refuse(request, reply, 503, "analysis_unavailable", "Repository analysis is not available");

  const callerOf = (request: FastifyRequest) => {
    const principal = request.principal;
    if (principal === null) {
      // Unreachable: the authentication hook answers every request that has no principal.
      throw new Error("authenticated route reached without a principal");
    }
    return principal;
  };

  /** `POST /v1/repository`: says that the key's project is a repository, once. */
  v1.post("/repository", { onRequest: requireScope("analysis:write") }, (request, reply) => {
    const principal = callerOf(request);
    if (analysis === undefined) return unavailable(request, reply);
    const body = bodyWith(request.body, ["installationId", "owner", "name"]);
    const { installationId, owner, name } = body ?? {};
    if (
      body === undefined ||
      typeof installationId !== "number" ||
      typeof owner !== "string" ||
      typeof name !== "string"
    ) {
      const refusal = REFUSALS.invalid_input;
      return refuse(request, reply, refusal.status, "invalid_input", refusal.message);
    }
    return answering(request, reply, async () => {
      const connection = await analysis.connect(principal, { installationId, owner, name });
      return reply.code(201).send(toConnectionBody(connection));
    });
  });

  /** `GET /v1/repository`: the repository that the key's project is. */
  v1.get("/repository", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (analysis === undefined) return unavailable(request, reply);
    return answering(request, reply, async () => {
      const connection = await analysis.repository(principal);
      if (connection === undefined) {
        const refusal = REFUSALS.connection_not_found;
        return refuse(request, reply, refusal.status, "connection_not_found", refusal.message);
      }
      return toConnectionBody(connection);
    });
  });

  /** `POST /v1/analyses`: asks for the repository to be analysed at a ref. */
  v1.post("/analyses", { onRequest: requireScope("analysis:write") }, (request, reply) => {
    const principal = callerOf(request);
    if (analysis === undefined) return unavailable(request, reply);
    const body = bodyWith(request.body, ["ref"]);
    const ref = body?.ref;
    if (typeof ref !== "string") {
      const refusal = REFUSALS.invalid_input;
      return refuse(request, reply, refusal.status, "invalid_input", refusal.message);
    }
    return answering(request, reply, async () => {
      const { id } = await analysis.request(principal, { ref });
      return reply
        .code(202)
        .header("location", `/v1/analyses/${id}`)
        .send({ id, status: "queued" });
    });
  });

  /** `GET /v1/analyses`: the analyses of the key's project, newest first. */
  v1.get("/analyses", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (analysis === undefined) return unavailable(request, reply);
    const raw = (request.query as Record<string, unknown>).limit;
    if (raw !== undefined && (typeof raw !== "string" || !LIMIT.test(raw))) {
      const refusal = REFUSALS.invalid_input;
      return refuse(request, reply, refusal.status, "invalid_input", refusal.message);
    }
    return answering(request, reply, async () => {
      const states = await analysis.analyses(
        principal,
        raw === undefined ? {} : { limit: Number(raw) },
      );
      return { analyses: states.map(toAnalysisBody) };
    });
  });

  /** `GET /v1/analyses/:id`: how one analysis is going. */
  v1.get("/analyses/:id", { onRequest: requireScope("analysis:read") }, (request, reply) => {
    const principal = callerOf(request);
    if (analysis === undefined) return unavailable(request, reply);
    const { id } = request.params as { id: string };
    return answering(request, reply, async () => {
      const state = await analysis.analysis(principal, id);
      // Another project's analysis, another organisation's and one that is not there are the same.
      if (state === undefined) {
        return refuse(
          request,
          reply,
          404,
          "analysis_not_found",
          "No analysis with that id was found",
        );
      }
      return toAnalysisBody(state);
    });
  });
}
