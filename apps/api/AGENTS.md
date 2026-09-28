# Zone rules: `apps/api` (Express API)

> Loaded automatically when working in `apps/api/`. Complements the root `AGENTS.md`. Python scripts have their own rules in `apps/api/scripts/AGENTS.md`.
> Deep references: `brain/architecture/api-routes.md`, `data-model.md`, `storage-layout.md`, `configuration.md`, codemaps `brain/codemap/api-*.md`.

## Module pattern (copy the neighbors)
`src/modules/<domain>/<domain>.routes.ts` (guards + `validate` + `asyncHandler`) → `.controller.ts` (thin: read `req`, call service, `res.status(x).json({ <resource> })`) → `.service.ts` (business logic, Prisma, FS, processes) + `.schemas.ts` (zod). Sub-domains of `projects/` follow the same trio and are mounted in `projects.routes.ts`.

## Hard rules
- **Errors**: `throw new AppError(status, 'STABLE_CODE', 'client-safe message')`; add new codes to `SERVER_ERROR_CODES` in `@dive/shared` (the list is already out of sync, see K32).
- **Validation strips unknown keys**: `validate()` replaces `req.body` with the zod output, so every field the controller reads must be in the schema (bug K1 comes from this).
- **Visibility**: project services start with `assertProjectVisible`; an invisible project is **404**, never 403. Owner-only actions: 403 `FORBIDDEN`.
- **External commands**: argv only via `runCommand` / `streamRunner` / `planOpenfoamCommand` (sources `OPENFOAM_BASHRC`); never a shell string. Binaries, interpreters and timeouts come from `src/config/env.ts`. A failing tool yields a step report (`success | failed | skipped`), not an exception.
- **Paths**: only through the storage helpers (`sanitizeRelative`, `confineJoin`, `caseStorage`, `meshStorage`…); critical writes are atomic (tmp + rename).
- **Single instance**: run/meshing handles and locks (`runExclusive`, chamber per-hash lock) live in memory; do not design for multiple API processes.
- **Config**: every env var is declared and validated in `src/config/env.ts` and documented in `.env.example` (11 are currently missing there, K33).
- **Chamber**: `src/modules/chamber` passes FINAL values to the builder; anything added to the builder params changes the cache hash.

## Tests
- Vitest + supertest, isolated SQLite (`tests/globalSetup.ts` runs `prisma db push --force-reset`), `STORAGE_DIR` = `test-storage`. Never run a real external tool: inject fakes with `setCommandRunner` / `setStreamRunner` and reset them to `null` in `afterEach`; the fake must write the files the real tool would.
- Compare commands with `logicalCommand()`, not `spec.command`: with `OPENFOAM_BASHRC` set in `.env`, commands are wrapped in `bash -c` (why `conversion.test.ts` / `meshes.test.ts` fail locally).
- `npm test -w @dive/api` does not rebuild `@dive/shared`: run `npm run build:shared` first. Targeted: `cd apps/api && npx vitest run tests/<file>.test.ts`.

## Playbooks
`brain/playbooks/add-api-endpoint.md`, `add-prisma-migration.md`, `add-env-var.md`, `integrate-external-tool.md`, `deploy-and-update.md`.
