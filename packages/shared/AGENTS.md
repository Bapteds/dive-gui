# Zone rules: `packages/shared` (`@dive/shared` contract)

> Loaded automatically when working in `packages/shared/`. Complements the root `AGENTS.md`.
> Deep reference: `brain/codemap/root-shared-mcp.md` (section `packages/shared/src/index.ts`, organized by theme).

## Hard rules
- **Single source of truth** for everything used by both the API and the web: roles, length limits, error codes (`SERVER_ERROR_CODES`), zod schemas, solver catalog and profiles, turbulence models, meshing configs, BC object types, chamber model (ranges, relations, `computeChamberGeneratorDims` / Gen Dim v3). Never duplicate one of these in an app.
- **Rebuild after every change**: `npm run build:shared` (dual CJS + ESM build in `dist/`). The API, `tsc` and Vitest read `dist/`; only Vite dev reads the sources. Root `npm test` / `npm run typecheck` rebuild it, per-workspace commands do not.
- **Both consumers move together**: after changing an export, check its usages in `apps/api/src` and `apps/web/src` (and `apps/mcp` for API shapes) in the same change.
- **Chamber model parity**: `computeChamberGeneratorDims` mirrors the workbook `documents/Gen Dim v3 Only Calculator (standalone).xlsx` (source of record). Changing a formula requires updating `apps/api/tests/chamberModel.test.ts` and `apps/web/src/features/chamber/chamberForm.test.ts`. Display labels may change freely; keys (`x1`..`x4`, `variant`) never do (saved builds and cache keys depend on them).
- **Solver catalog**: ESI OpenFOAM v2406 binaries only (never `foamRun`); known gaps M18 and K39 in `brain/known-issues.md`.

## Playbooks
`brain/playbooks/add-solver-or-turbulence-model.md`, `add-chamber-input-or-parameter.md`, `add-api-endpoint.md` (error codes).
