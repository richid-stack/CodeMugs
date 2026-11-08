# database

**Status:** Partly started · Phase 1 Foundation. The schema, migrations and tenant isolation live in [`packages/storage`](../../packages/storage/README.md). What is still planned here: provisioning, backups, partitioning, retention and deletion policies.

## The role contract

Infrastructure creates the database roles. Migrations do not, and refuse to run if the application role is missing.

| Role             | Used by                                 | Must be                                                                                                                            |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `codemugs_app`   | The running application                 | `LOGIN`, not a superuser, no `BYPASSRLS`, no `CREATEDB`, no `CREATEROLE`; owns nothing                                             |
| a migration role | `runMigrations`, run from a deploy step | Owns the tables and may create them. Used over a direct connection (not a transaction-mode pooler). Never given to the application |

```sql
CREATE ROLE codemugs_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD '<from the secret store>';
```

The password comes from the secret store, never from code or a file in the repository. See [ADR 0006](../../docs/architecture/decisions/0006-tenant-isolation.md) for why the role must not own the tables and why `TRUNCATE` is not granted, and [ADR 0009](../../docs/architecture/decisions/0009-data-access-and-migrations.md) for the supported PostgreSQL versions (17 and 18).

Nothing here is provisioned yet: there is no deployment, so no production database exists.
