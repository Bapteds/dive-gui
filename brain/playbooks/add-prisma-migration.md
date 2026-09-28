# Playbook: Add a Prisma migration

> When to use: any change to `apps/api/prisma/schema.prisma` (new model, new column, new index, relation change) · Related: `brain/architecture/data-model.md`, `brain/codemap/api-core.md` (prisma section), `brain/conventions/testing.md` §2, `brain/operations/installation.md` · Updated: 2026-09-28

## Before you start
- Read `brain/architecture/data-model.md` (models, cascades, migration history) and `brain/decisions.md` if the change touches ownership or deletion rules.
- Decide with the user: field names, nullability and default for existing rows, `onDelete` behaviour, uniqueness (global or per owner), whether the data belongs in the DB at all (heavy or file-shaped state lives under `STORAGE_DIR`, see `brain/architecture/storage-layout.md`; meshing sessions and chamber builds have no DB row on purpose).
- Stop `npm run dev` before migrating: `migrate dev` regenerates the Prisma client, and on Windows a running API can hold the query engine file.
- Models to copy: the most recent migration `apps/api/prisma/migrations/20260831142110_chamber_saves/migration.sql` (new table, unique, index, cascade FK) and `20260703120000_add_run_cores/migration.sql` (new column with default).

## Steps
1. **Edit `apps/api/prisma/schema.prisma`**. Follow the SQLite conventions of the file:
   - no enums: a `String` column with a default (`role String @default("USER")`, `status String @default("queued")`), validated by zod on write and mirrored by a union in `@dive/shared` (`Role`, `RunStatus`); narrow on read (model: `toRole` in `apps/api/src/lib/role.ts`);
   - no arrays or JSON type: a `String` holding JSON (`Template.tags @default("[]")`, `ChamberSave.snapshot`);
   - owned data: `ownerId String` + `@relation(..., onDelete: Cascade)` + `@@index([ownerId])` (model: `ChamberSave`); `AuditLog` is deliberately FK-free;
   - `///` doc comment on the model and on non-obvious fields; `createdAt @default(now())`, `updatedAt @updatedAt`.
2. **New column on an existing table**: give it a `@default(...)` or make it optional. A required column without default forces Prisma into a "RedefineTables" copy (see `20260622061744_add_audit_log_and_account_status`) that fails on a non-empty production table.
3. **Create the migration** (generates SQL, applies it to `prisma/dev.db`, regenerates the client):
   ```bash
   npm run db:migrate -w @dive/api -- --name add_<thing>
   ```
   (`db:migrate` = `prisma migrate dev`.) To review the SQL before applying, run `cd apps/api && npx prisma migrate dev --create-only --name add_<thing>`, read `prisma/migrations/<timestamp>_add_<thing>/migration.sql`, then `npm run db:migrate -w @dive/api`. A hand-edited SQL comment explaining the change is welcome (model: `20260703120000_add_run_cores`). Never edit a migration that is already on `main` or deployed; add a new one.
4. **Wire the code**: service reads/writes through `prisma` (`apps/api/src/lib/prisma.ts`), a `toPublic<Model>` serializer that emits ISO dates and strips internal fields (model: `toPublicUser` in `apps/api/src/lib/serializeUser.ts`), zod schema in the module, shared type in `packages/shared/src/index.ts` if the web uses it (`npm run build:shared`). For the endpoint itself, follow `add-api-endpoint.md`.
5. **Deletion paths**: check `deleteUser` (`users.service.ts`) and `deleteProject` (`projects.service.ts`). Cascades remove the rows, but any on-disk state tied to the new model needs an explicit best-effort cleanup like `removeProjectStorage` / `removeTemplateStorage`.
6. **Seed**: `apps/api/prisma/seed.ts` only upserts the protected super-admin. Touch it only if the new model needs a mandatory row, and keep it idempotent (`upsert`).
7. **Tests**:
   - add the new model to `resetDatabase()` in `apps/api/tests/helpers.ts`, children before parents (current order: `auditLog`, `run`, `template`, `chamberSave`, `project`, `user`);
   - the test DB does not replay migrations: `tests/globalSetup.ts` runs `prisma db push --force-reset --skip-generate` from `schema.prisma` onto `prisma/test.db`, so the client must already be generated (step 3 did it);
   - cover the new constraints (unique -> 409, cascade on owner deletion, default values). Model: `apps/api/tests/chamberSaves.test.ts`.

8. **Deployment**:
   - `npm start` in `apps/api` is `prisma migrate deploy && node dist/server.js`, so `systemctl restart dive-api` applies pending migrations (see `deploy-and-update.md`). Back up the production DB file (`DATABASE_URL`, `/var/lib/dive/prod.db` in the installation guide) before restarting: Prisma has no automatic down-migration.
   - Never run `db:migrate` (`migrate dev`) or `db:reset` against the production DB; the production command is `npm run db:deploy -w @dive/api`.

## Verify
- `npm run db:migrate -w @dive/api` again: must report the schema in sync and create nothing.
- Migrations replay from scratch on a throwaway dev DB: `npm run db:reset` (destructive: wipes `prisma/dev.db`) then `npm run db:seed`. This is the only local check of the SQL itself, since tests use `db push`.
- `npm run build:shared` (if shared changed), then `cd apps/api && npx vitest run tests/<domain>.test.ts tests/users.test.ts tests/projects.test.ts` (deletion cascades).
- `npm run typecheck` and `npm run lint`.

## Update the brain
- [ ] `brain/architecture/data-model.md`: model table, relations diagram, cascades table, a row in the migration history table, business rules.
- [ ] Codemap `brain/codemap/api-core.md`: a section for the new `apps/api/prisma/migrations/<name>/migration.sql`, updated `schema.prisma` and `seed.ts` sections, `api-tests.md` for `helpers.ts`; then `python brain/codemap/build-index.py`.
- [ ] Changelog entry, with a "Deployment" note: the migration is applied by `npm start` (`prisma migrate deploy`) on the next service restart.
- [ ] Feature sheet(s) whose data changed.

## Pitfalls
- SQLite `@unique` on a `String` is case-sensitive (`ChamberSave.name`); normalise in the service if uniqueness must ignore case (emails are lowercased by the services).
- `prisma db push` in tests hides a broken or missing migration file: tests stay green while `migrate deploy` fails on the server. Always run the replay check above.
- Forgetting `resetDatabase()`: rows leak between test files (they run serially on one `test.db`) and FK errors appear when `user` is deleted first.
- New `String` "enum" values must be added to the zod schema AND the shared union, or reads narrow to the wrong value.
- The DB holds metadata only; do not move large or file-shaped data into a column.
