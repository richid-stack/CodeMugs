import { randomUUID } from "node:crypto";
import { withTenant } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRepository } from "./connect.js";
import { ANALYSE_JOB_ATTEMPTS, ANALYSE_JOB_KIND } from "./constants.js";
import {
  analysisErrorCode,
  databaseErrorCode,
  describeDatabase,
  startHarness,
  type Harness,
  type Tenant,
} from "./db-harness.js";
import { readAnalysisPlan, requestAnalysis } from "./request.js";
import { getAnalysis, listAnalyses } from "./status.js";

describeDatabase("asking for an analysis, and how it is going", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A");
    b = await h.tenant("B");
    await h.bindInstallation(a.organisationId, 11);
    await h.bindInstallation(b.organisationId, 22);
    await withTenant(h.app, a.organisationId, (client) =>
      connectRepository(client, {
        projectId: a.projectId,
        installationId: 11,
        owner: "acme",
        name: "shop",
      }),
    );
    await withTenant(h.app, b.organisationId, (client) =>
      connectRepository(client, {
        projectId: b.projectId,
        installationId: 22,
        owner: "other",
        name: "thing",
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  /** An organisation with two projects, each connected to a repository of its own. */
  let pairs = 0;
  const twoConnected = async (): Promise<Tenant> => {
    pairs += 1;
    const tenant = await h.tenant(`pair-${String(pairs)}`);
    const installationId = 40 + pairs;
    await h.bindInstallation(tenant.organisationId, installationId);
    await withTenant(h.app, tenant.organisationId, async (client) => {
      await connectRepository(client, {
        projectId: tenant.projectId,
        installationId,
        owner: "acme",
        name: "first",
      });
      await connectRepository(client, {
        projectId: tenant.otherProjectId,
        installationId,
        owner: "acme",
        name: "second",
      });
    });
    return tenant;
  };
  const ask = (tenant: Tenant, projectId = tenant.projectId, ref = "main") =>
    withTenant(h.app, tenant.organisationId, (client) =>
      requestAnalysis(client, { projectId, ref }),
    );
  const state = (tenant: Tenant, requestId: string) =>
    withTenant(h.app, tenant.organisationId, (client) => getAnalysis(client, requestId));

  describe("requestAnalysis", () => {
    it("writes the request and the job together, and the job is about the request", async () => {
      const { requestId } = await ask(a);
      const request = await h.admin.query(
        "SELECT organisation_id, project_id, ref FROM analysis_requests WHERE id = $1",
        [requestId],
      );
      expect(request.rows).toEqual([
        { organisation_id: a.organisationId, project_id: a.projectId, ref: "main" },
      ]);
      const job = await h.admin.query(
        "SELECT organisation_id, kind, status, max_attempts FROM jobs WHERE subject_id = $1",
        [requestId],
      );
      expect(job.rows).toEqual([
        {
          organisation_id: a.organisationId,
          kind: ANALYSE_JOB_KIND,
          status: "queued",
          max_attempts: ANALYSE_JOB_ATTEMPTS,
        },
      ]);
    });

    it("leaves neither the request nor the job when the transaction does not commit", async () => {
      let requestId = "";
      await expect(
        withTenant(h.app, a.organisationId, async (client) => {
          requestId = (await requestAnalysis(client, { projectId: a.projectId, ref: "main" }))
            .requestId;
          throw new Error("the caller changed its mind");
        }),
      ).rejects.toThrow("the caller changed its mind");
      expect(
        (await h.admin.query("SELECT 1 FROM analysis_requests WHERE id = $1", [requestId]))
          .rowCount,
      ).toBe(0);
      expect(
        (await h.admin.query("SELECT 1 FROM jobs WHERE subject_id = $1", [requestId])).rowCount,
      ).toBe(0);
    });

    it("makes a request of its own each time", async () => {
      const first = await ask(a);
      const second = await ask(a);
      expect(first.requestId).not.toBe(second.requestId);
    });

    it("does not know a project of another organisation or none at all", async () => {
      expect(await analysisErrorCode(ask(a, b.projectId))).toBe("project_not_found");
      expect(await analysisErrorCode(ask(a, randomUUID()))).toBe("project_not_found");
    });

    it("says that a project that is not connected has no repository", async () => {
      expect(await analysisErrorCode(ask(a, a.otherProjectId))).toBe("connection_not_found");
    });

    it.each([
      ["an empty ref", ""],
      ["a ref with a space", "my branch"],
      ["a ref with a newline", "main\nevil"],
      ["a ref with a control character", "main\u0000"],
      ["a ref of 256 characters", "r".repeat(256)],
    ])("refuses %s", async (_label, ref) => {
      expect(await analysisErrorCode(ask(a, a.projectId, ref))).toBe("invalid_input");
    });

    it("refuses a project that is not a UUID", async () => {
      expect(await analysisErrorCode(ask(a, "not-a-uuid"))).toBe("invalid_input");
    });

    it("takes a branch with a slash, a tag and a commit", async () => {
      for (const ref of ["feature/x", "v1.2.3", "a".repeat(40)]) {
        expect((await ask(a, a.projectId, ref)).requestId).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  });

  describe("what the application role may write itself", () => {
    it("cannot pair a project with the connection of another project of its organisation", async () => {
      const d = await twoConnected();
      const connections = await h.admin.query<{ id: string; project_id: string }>(
        "SELECT id, project_id FROM repository_connections WHERE organisation_id = $1",
        [d.organisationId],
      );
      const ofOther = connections.rows.find((row) => row.project_id === d.otherProjectId);
      const ofThis = connections.rows.find((row) => row.project_id === d.projectId);
      const insert = (projectId: string, connectionId: string | undefined) =>
        withTenant(h.app, d.organisationId, (client) =>
          client.query(
            `INSERT INTO analysis_requests (organisation_id, id, project_id, connection_id, ref)
             VALUES ($1, $2, $3, $4, 'main')`,
            [d.organisationId, randomUUID(), projectId, connectionId],
          ),
        );
      expect(await databaseErrorCode(insert(d.projectId, ofOther?.id))).toBe("23503");
      // The same insert with the project's own connection is accepted, so it is the pairing that is refused.
      await expect(insert(d.projectId, ofThis?.id)).resolves.toMatchObject({ rowCount: 1 });
    });
  });

  describe("readAnalysisPlan", () => {
    it("says which repository to read, and at what ref", async () => {
      const { requestId } = await ask(a, a.projectId, "release/1");
      const plan = await withTenant(h.app, a.organisationId, (client) =>
        readAnalysisPlan(client, requestId),
      );
      expect(plan).toEqual({
        requestId,
        projectId: a.projectId,
        ref: "release/1",
        installationId: 11,
        owner: "acme",
        name: "shop",
      });
    });

    it("says the repository of the request's own project when an organisation has several", async () => {
      const d = await twoConnected();
      const first = await ask(d, d.projectId);
      const second = await ask(d, d.otherProjectId);
      const plans = await withTenant(h.app, d.organisationId, async (client) => [
        await readAnalysisPlan(client, first.requestId),
        await readAnalysisPlan(client, second.requestId),
      ]);
      expect(plans.map((plan) => plan?.name)).toEqual(["first", "second"]);
      expect(plans.map((plan) => plan?.projectId)).toEqual([d.projectId, d.otherProjectId]);
    });

    it("does not give one organisation another's request", async () => {
      const { requestId } = await ask(a);
      expect(
        await withTenant(h.app, b.organisationId, (client) => readAnalysisPlan(client, requestId)),
      ).toBeUndefined();
    });

    it("says nothing for a request that is not there, and refuses an id that is not a UUID", async () => {
      expect(
        await withTenant(h.app, a.organisationId, (client) =>
          readAnalysisPlan(client, randomUUID()),
        ),
      ).toBeUndefined();
      expect(
        await analysisErrorCode(
          withTenant(h.app, a.organisationId, (client) => readAnalysisPlan(client, "x")),
        ),
      ).toBe("invalid_input");
    });
  });

  describe("getAnalysis", () => {
    /** What a worker would have done to the job, written the way the dispatcher writes it. */
    const setJob = (requestId: string, sql: string) =>
      h.admin.query(`UPDATE jobs SET ${sql} WHERE subject_id = $1`, [requestId]);
    const storeRun = (tenant: Tenant, requestId: string, revision: string | null) =>
      h.admin.query(
        `INSERT INTO analysis_runs
           (organisation_id, id, project_id, revision, facts_version, truncated, summary,
            node_count, edge_count, digest)
         VALUES ($1, $2, $3, $4, 1, '{packages}', '{}', 7, 9, $5)`,
        [tenant.organisationId, requestId, tenant.projectId, revision, "a".repeat(64)],
      );

    it("is queued when nothing has taken the job", async () => {
      const { requestId } = await ask(a);
      expect(await state(a, requestId)).toMatchObject({
        requestId,
        projectId: a.projectId,
        ref: "main",
        status: "queued",
        attempts: 0,
      });
    });

    it("is running while a worker has it", async () => {
      const { requestId } = await ask(a);
      await setJob(requestId, "status = 'running', attempts = 1, lease_token = gen_random_uuid()");
      expect(await state(a, requestId)).toMatchObject({ status: "running", attempts: 1 });
    });

    it("is retrying, with the code, after a failure that will be tried again", async () => {
      const { requestId } = await ask(a);
      await setJob(requestId, "attempts = 1, last_error_code = 'download_failed'");
      expect(await state(a, requestId)).toMatchObject({
        status: "retrying",
        attempts: 1,
        failureCode: "download_failed",
      });
    });

    it("is failed, with the code, when the job is dead", async () => {
      const { requestId } = await ask(a);
      await setJob(
        requestId,
        "status = 'dead', attempts = 1, last_error_code = 'repository_too_large', finished_at = now()",
      );
      expect(await state(a, requestId)).toMatchObject({
        status: "failed",
        failureCode: "repository_too_large",
      });
    });

    it("is succeeded, with what was stored, when the run is there", async () => {
      const { requestId } = await ask(a);
      await setJob(requestId, "status = 'succeeded', attempts = 1, finished_at = now()");
      await storeRun(a, requestId, "b".repeat(40));
      const result = await state(a, requestId);
      expect(result).toMatchObject({
        status: "succeeded",
        run: { revision: "b".repeat(40), nodes: 7, edges: 9, truncated: ["packages"] },
      });
      expect(result?.run?.analysedAt).toBeInstanceOf(Date);
      expect(result).not.toHaveProperty("failureCode");
    });

    it("says a stored run is the answer even for a job that went on to fail after a retry", async () => {
      const { requestId } = await ask(a);
      await setJob(requestId, "attempts = 2, last_error_code = 'download_failed'");
      await storeRun(a, requestId, null);
      expect(await state(a, requestId)).toMatchObject({
        status: "succeeded",
        run: { revision: null },
      });
    });

    it("is unknown when the job has finished and there is no run, and when the job is gone", async () => {
      const first = await ask(a);
      await setJob(first.requestId, "status = 'succeeded', attempts = 1, finished_at = now()");
      expect(await state(a, first.requestId)).toMatchObject({ status: "unknown" });
      const second = await ask(a);
      await h.admin.query("DELETE FROM jobs WHERE subject_id = $1", [second.requestId]);
      expect(await state(a, second.requestId)).toMatchObject({ status: "unknown", attempts: 0 });
    });

    it("does not show one organisation another's request", async () => {
      const { requestId } = await ask(a);
      expect(await state(b, requestId)).toBeUndefined();
      expect(await state(a, randomUUID())).toBeUndefined();
    });

    it("does not take the job of another kind that has the same subject for the request's", async () => {
      const { requestId } = await ask(a);
      await h.admin.query(
        "UPDATE jobs SET kind = 'events.aggregate', status = 'dead', finished_at = now(), last_error_code = 'x' WHERE subject_id = $1",
        [requestId],
      );
      expect(await state(a, requestId)).toMatchObject({ status: "unknown" });
    });
  });

  describe("listAnalyses", () => {
    it("lists a project's analyses, newest first, and only that project's", async () => {
      const c = await h.tenant("C");
      await h.bindInstallation(c.organisationId, 33);
      await withTenant(h.app, c.organisationId, (client) =>
        connectRepository(client, {
          projectId: c.projectId,
          installationId: 33,
          owner: "c",
          name: "c",
        }),
      );
      const ids: string[] = [];
      for (const ref of ["one", "two", "three"]) {
        ids.push((await ask(c, c.projectId, ref)).requestId);
        await h.admin.query("SELECT pg_sleep(0.01)");
      }
      const list = await withTenant(h.app, c.organisationId, (client) =>
        listAnalyses(client, c.projectId),
      );
      expect(list.map((entry) => entry.ref)).toEqual(["three", "two", "one"]);
      expect(list.map((entry) => entry.requestId)).toEqual([...ids].reverse());
      const limited = await withTenant(h.app, c.organisationId, (client) =>
        listAnalyses(client, c.projectId, { limit: 2 }),
      );
      expect(limited.map((entry) => entry.ref)).toEqual(["three", "two"]);
      expect(
        await withTenant(h.app, c.organisationId, (client) =>
          listAnalyses(client, c.otherProjectId),
        ),
      ).toEqual([]);
    });

    it("lists nothing of another organisation's project", async () => {
      await ask(a);
      expect(
        await withTenant(h.app, b.organisationId, (client) => listAnalyses(client, a.projectId)),
      ).toEqual([]);
    });

    it.each([0, 101, 1.5, -1, Number.NaN])("refuses a limit of %s", async (limit) => {
      expect(
        await analysisErrorCode(
          withTenant(h.app, a.organisationId, (client) =>
            listAnalyses(client, a.projectId, { limit }),
          ),
        ),
      ).toBe("invalid_input");
    });

    it("refuses a project that is not a UUID", async () => {
      expect(
        await analysisErrorCode(
          withTenant(h.app, a.organisationId, (client) => listAnalyses(client, "x")),
        ),
      ).toBe("invalid_input");
    });
  });
});
