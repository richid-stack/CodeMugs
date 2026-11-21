import { randomUUID } from "node:crypto";
import { withTenant } from "@codemugs/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRepository, getConnection } from "./connect.js";
import {
  analysisErrorCode,
  databaseErrorCode,
  describeDatabase,
  startHarness,
  type Harness,
  type Tenant,
} from "./db-harness.js";

describeDatabase("connecting a project to a repository", () => {
  let h: Harness;
  let a: Tenant;
  let b: Tenant;
  const INSTALLATION_A = 1_001;
  const INSTALLATION_B = 2_002;

  beforeAll(async () => {
    h = await startHarness();
    a = await h.tenant("A");
    b = await h.tenant("B");
    await h.bindInstallation(a.organisationId, INSTALLATION_A);
    await h.bindInstallation(b.organisationId, INSTALLATION_B);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  const connect = (
    tenant: Tenant,
    overrides: Partial<Parameters<typeof connectRepository>[1]> = {},
    installationId = INSTALLATION_A,
  ) =>
    withTenant(h.app, tenant.organisationId, (client) =>
      connectRepository(client, {
        projectId: tenant.projectId,
        installationId,
        owner: "richid-stack",
        name: "CodeMugs",
        ...overrides,
      }),
    );

  it("connects a project, and reads the connection back", async () => {
    const { connectionId } = await connect(a);
    const connection = await withTenant(h.app, a.organisationId, (client) =>
      getConnection(client, a.projectId),
    );
    expect(connection).toMatchObject({
      connectionId,
      projectId: a.projectId,
      installationId: INSTALLATION_A,
      owner: "richid-stack",
      name: "CodeMugs",
    });
    expect(connection?.connectedAt).toBeInstanceOf(Date);
  });

  it("says that a project that is connected already cannot be connected again", async () => {
    const tenant = await h.tenant("twice");
    await h.bindInstallation(tenant.organisationId, 5_001);
    await connect(tenant, {}, 5_001);
    expect(await analysisErrorCode(connect(tenant, { name: "other" }, 5_001))).toBe(
      "connection_exists",
    );
  });

  it("leaves a project that has no connection with none", async () => {
    const connection = await withTenant(h.app, a.organisationId, (client) =>
      getConnection(client, a.otherProjectId),
    );
    expect(connection).toBeUndefined();
  });

  it("does not know a project of another organisation, or one that does not exist", async () => {
    expect(await analysisErrorCode(connect(a, { projectId: b.otherProjectId }))).toBe(
      "project_not_found",
    );
    expect(await analysisErrorCode(connect(a, { projectId: randomUUID() }))).toBe(
      "project_not_found",
    );
  });

  it("does not let an organisation use an installation that is another's, and does not say whose", async () => {
    // Installation B is bound to organisation B. For A it is the same as one that nobody has.
    const foreign = await analysisErrorCode(
      connect(a, { projectId: a.otherProjectId }, INSTALLATION_B),
    );
    const nobodys = await analysisErrorCode(connect(a, { projectId: a.otherProjectId }, 999_999));
    expect(foreign).toBe("installation_not_found");
    expect(nobodys).toBe("installation_not_found");
    // Nothing was written by either.
    const rows = await h.admin.query("SELECT 1 FROM repository_connections WHERE project_id = $1", [
      a.otherProjectId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("reads only its own organisation's connections", async () => {
    const [x, y] = [await h.tenant("reads-x"), await h.tenant("reads-y")];
    await h.bindInstallation(x.organisationId, 5_002);
    await h.bindInstallation(y.organisationId, 5_003);
    await connect(x, {}, 5_002);
    await connect(y, {}, 5_003);
    const seen = await withTenant(h.app, x.organisationId, (client) =>
      client.query("SELECT organisation_id FROM repository_connections"),
    );
    expect(seen.rows).toEqual([{ organisation_id: x.organisationId }]);
    expect(
      await withTenant(h.app, x.organisationId, (client) => getConnection(client, y.projectId)),
    ).toBeUndefined();
  });

  it.each([
    ["a project that is not a UUID", { projectId: "p1" }],
    ["an installation of 0", { installationId: 0 }],
    ["an installation that is not whole", { installationId: 1.5 }],
    ["an installation that is not a number", { installationId: "1" as unknown as number }],
    ["an owner with a slash", { owner: "a/b" }],
    ["an owner that starts with a hyphen", { owner: "-a" }],
    ["an owner of 40 characters", { owner: "a".repeat(40) }],
    ["an empty name", { name: "" }],
    ["a name of ..", { name: ".." }],
    ["a name with a space", { name: "my repo" }],
    ["a name with a path in it", { name: "a/../b" }],
    ["a name of 101 characters", { name: "n".repeat(101) }],
  ])("refuses %s", async (_label, overrides) => {
    expect(await analysisErrorCode(connect(a, { projectId: a.otherProjectId, ...overrides }))).toBe(
      "invalid_input",
    );
  });

  describe("what the application role may do", () => {
    it("cannot bind an installation to its own organisation", async () => {
      const code = await databaseErrorCode(
        withTenant(h.app, a.organisationId, (client) =>
          client.query(
            "INSERT INTO github_installations (organisation_id, installation_id) VALUES ($1, $2)",
            [a.organisationId, 3_003],
          ),
        ),
      );
      expect(code).toBe("42501");
    });

    it("cannot change or remove an installation, a connection or a request", async () => {
      for (const sql of [
        "UPDATE github_installations SET installation_id = installation_id + 1",
        "DELETE FROM github_installations",
        "UPDATE repository_connections SET owner = 'someone-else'",
        "DELETE FROM repository_connections",
        "UPDATE analysis_requests SET ref = 'x'",
        "DELETE FROM analysis_requests",
      ]) {
        expect(
          await databaseErrorCode(
            withTenant(h.app, a.organisationId, (client) => client.query(sql)),
          ),
        ).toBe("42501");
      }
    });

    it("cannot make a connection to an installation that is another's even by writing the row itself", async () => {
      const code = await databaseErrorCode(
        withTenant(h.app, a.organisationId, (client) =>
          client.query(
            `INSERT INTO repository_connections
               (organisation_id, id, project_id, provider, installation_id, owner, name)
             VALUES ($1, $2, $3, 'github', $4, 'x', 'y')`,
            [a.organisationId, randomUUID(), a.otherProjectId, INSTALLATION_B],
          ),
        ),
      );
      expect(code).toBe("23503"); // The foreign key carries the organisation.
    });

    it("cannot write a connection for another organisation", async () => {
      const code = await databaseErrorCode(
        withTenant(h.app, a.organisationId, (client) =>
          client.query(
            `INSERT INTO repository_connections
               (organisation_id, id, project_id, provider, installation_id, owner, name)
             VALUES ($1, $2, $3, 'github', $4, 'x', 'y')`,
            [b.organisationId, randomUUID(), b.otherProjectId, INSTALLATION_B],
          ),
        ),
      );
      expect(code).toBe("42501"); // Row-level security: the row is not the tenant's.
    });

    it("cannot bind one installation to two organisations (an operator's mistake)", async () => {
      expect(await databaseErrorCode(h.bindInstallation(b.organisationId, INSTALLATION_A))).toBe(
        "23505",
      );
    });
  });
});
