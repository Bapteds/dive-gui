# Codemap: index

> File-by-file description of ALL the git-tracked code (role, exports, dependencies, pitfalls).
> Do not read end to end: find the sheet here, then the `## path/to/file` section you need (search by file name).
> Template and update rules: `_FORMAT.md`. Complete initial mapping: 2026-09-28.
> **Flat view**: `brain/INDEX.md` lists every file of the repository, one line each, generated from these sheets by `build-index.py` (`--check`: no undocumented file as of 2026-09-28).

## Sheets

| Sheet | Scope |
|---|---|
| `root-shared-mcp.md` | Root and tooling (`package.json`, tsconfig, ESLint, Prettier, CI, `.mcp.json`, `AGENTS.md`/`CLAUDE.md`, `.claude/`, brain tooling), `packages/shared/**` (shared contract, by theme), `apps/mcp/**` |
| `api-core.md` | `apps/api`: `app.ts`, `server.ts`, `config/`, `middleware/`, `types/`, `prisma/` (schema, seed, migrations), modules `auth`, `users`, `audit`, `dashboard`, `templates`, `meshing`, `chamber` |
| `api-lib.md` | `apps/api/src/lib/**`: storage (case, meshes, runs, viz, export, meshing, chamber, templates), command execution (`commandRunner`, `streamRunner`, `openfoamCommand`), OpenFOAM dict generators (`openfoamCase`, `snappyDicts`, `cfMeshDicts`), meshing pipelines, STL, transforms, terminal |
| `api-projects.md` | `apps/api/src/modules/projects/**`: projects, case files, case mesh, mesh library (merge, assembly), conversion, boundary conditions, solver runs, CFD-Post export, terminal gateway, router |
| `api-scripts.md` | `apps/api/scripts/**` (Python: `buildChamber.py`, CGNS/VTK, patch extraction, export, CSV → boundaryData, pytest tests, assets), `apps/api/tests/fixtures/**`, and `documents/` (reference material) |
| `api-tests.md` | `apps/api/tests/**` + `apps/api/vitest.config.ts`: what each suite locks |
| `web-core.md` | `apps/web` outside features: config (Vite, Tailwind, tsconfig), `main.tsx`, `app/` (providers, router, guards), `components/{ui,common,layout,brand}`, `pages/`, `lib/api/`, `styles/` (every token) |
| `web-features-platform.md` | `features/{account,admin,auth,dashboard,export,files,templates,terminal,visualize}` |
| `web-features-projects.md` | `features/projects`: case files (Easy/Advanced, Foam parser), boundary conditions, merge, conversion, import |
| `web-features-assemble-chamber.md` | `features/assemble` (3D assembly) and `features/chamber` (Chamber Creation) |
| `web-features-meshing-solver.md` | `features/meshing` (snappy/cfMesh) and `features/solver` (setup, config, turbulence, TopoSet, runs, residuals) |

Markdown documents (brain, zone `AGENTS.md`, specs, plans, `documents/`) have no codemap section: `INDEX.md` uses their title and introduction line.

## Find a file quickly

| Path prefix | Sheet |
|---|---|
| `packages/shared/` | `root-shared-mcp.md` |
| `apps/mcp/` | `root-shared-mcp.md` |
| `apps/api/src/{app,server}.ts`, `apps/api/src/{config,middleware,types}/`, `apps/api/prisma/` | `api-core.md` |
| `apps/api/src/modules/{auth,users,audit,dashboard,templates,meshing,chamber}/` | `api-core.md` |
| `apps/api/src/modules/projects/` | `api-projects.md` |
| `apps/api/src/lib/` | `api-lib.md` |
| `apps/api/scripts/`, `documents/` | `api-scripts.md` |
| `apps/api/tests/` | `api-tests.md` (fixtures: `api-scripts.md`) |
| `apps/web/src/{app,components,pages,lib,styles,test}/`, web config | `web-core.md` |
| `apps/web/src/features/{account,admin,auth,dashboard,export,files,templates,terminal,visualize}/` | `web-features-platform.md` |
| `apps/web/src/features/projects/` | `web-features-projects.md` |
| `apps/web/src/features/{assemble,chamber}/` | `web-features-assemble-chamber.md` |
| `apps/web/src/features/{meshing,solver}/` | `web-features-meshing-solver.md` |

## Updating

Any creation, deletion or rename of a file, or any change in the role of an export, requires updating the matching section **in the same change** (see `brain/README.md` §3), then regenerating `brain/INDEX.md` with `python brain/codemap/build-index.py`. Each section must keep its `**Role**:` line (or `**Covers**:` for a test): the index takes it from there. The `Stop` hook blocks when a file has no section and regenerates the index otherwise. For a new web feature folder or a new API module: add a line to both tables above and, if the target sheet grows beyond ~400 lines, create a new sheet.
