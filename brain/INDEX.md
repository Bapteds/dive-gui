# Index of every repository file

> One line per file (556 files): one-sentence role and detailed codemap sheet. **Generated**, do not edit by hand: `python brain/codemap/build-index.py` (`--check` lists undocumented files). Search it; do not read it end to end.

Detail of a code file: open the sheet shown and search for the `## path/to/file` section. Documents: the description is their title and introduction line.

## Repository root

- `.editorconfig` : UTF-8, LF line endings, 2-space indentation, final newline, trailing whitespace trimmed (disabled for `*.md`). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `.gitattributes` : Normalizes the whole repository to LF (`* text=auto eol=lf`), because the team develops on Windows and deploys on Debian; forces LF for `*.sh` and `*.py`. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `.gitignore` : Ignores `node_modules/`, `dist/`, `build/`, `coverage/`, `.env` and `.env.*` files (except `.env.example`), SQLite databases (`*.db`, `*.db-journal`, `apps/api/prisma/dev.db*`), the storage `apps/api/storage/` and … · [root-shared-mcp](codemap/root-shared-mcp.md)
- `.mcp.json` : Declares the MCP server `dive` for Claude Code: `npx tsx apps/mcp/src/server.ts` (launched from the repository root). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `.nvmrc` : Node version `24`. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `.prettierrc.json` : Semicolons, single quotes, trailing commas everywhere, width 100. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `AGENTS.md` : instructions common to every AI agent (project, session protocol, golden rules, commands, brain map, design in brief). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `CLAUDE.md` : Claude Code entry point: imports `AGENTS.md` (`@AGENTS.md`) and adds the Claude-specific parts (memory, changelog hook, UI skills, index, Windows shells). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `README.md` : technical reference for humans (architecture, prerequisites, dev, configuration, Debian deployment, CFD tools per feature, commands, auth, REST API, links to the brain). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `brain.zip` : **(undocumented: add a section in brain/codemap)**
- `eslint.config.js` : ESLint 9 "flat" configuration of the monorepo via `tseslint.config`. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `package-lock.json` : npm lockfile for the whole monorepo (workspaces), used by `npm ci` in CI and in production. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `package.json` : root of the `dive-turbinen` workspace (private, ESM, `engines.node >=20`). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `tsconfig.base.json` : Common TypeScript base: `target ES2022`, `strict`, `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `.claude`

- `.claude/settings.json` : shared Claude Code project settings: declares the `Stop` hook that runs `.claude/hooks/check-changelog.sh`. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `.claude/hooks`

- `.claude/hooks/check-changelog.sh` : `Stop` hook (bash, Git Bash / WSL / Linux) that blocks the end of turn once if an uncommitted code file is newer than the latest entry in `brain/changelog/`. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `.github/workflows`

- `.github/workflows/ci.yml` : CI pipeline triggered on push to `main` and on every pull request, with cancellation of superseded runs (`concurrency: ci-${{ github.ref }}`). · [root-shared-mcp](codemap/root-shared-mcp.md)

## `apps/api`

- `apps/api/.env.example` : Template of the API environment variables, grouped by feature with operational comments (target Debian, OpenFOAM ESI, xvfb for pvbatch, OpenMPI flags, terminal disabled by default, `TRUST_PROXY`, seed). · [api-core](codemap/api-core.md)
- `apps/api/AGENTS.md` : Zone rules: `apps/api` (Express API) : Loaded automatically when working in `apps/api/`.
- `apps/api/CLAUDE.md` : Claude Code zone rules: `apps/api` : Imports the zone rules below (shared with Codex and other agents through `apps/api/AGENTS.md`).
- `apps/api/package.json` : package `@dive/api` (CommonJS). · [api-core](codemap/api-core.md)
- `apps/api/tsconfig.json` : Extends the base; `module: CommonJS`, `moduleResolution: Node`, `outDir: dist`, `rootDir: src`, `lib: ES2022`, `types: ["node"]`. · [api-core](codemap/api-core.md)
- `apps/api/vitest.config.ts` : API test configuration. · [api-core](codemap/api-core.md)

## `apps/api/prisma`

- `apps/api/prisma/schema.prisma` : Prisma schema of the API (SQLite datasource `env("DATABASE_URL")`, generator `prisma-client-js` with `binaryTargets = ["native", "debian-openssl-3.0.x"]` so that a client generated on Windows runs on Debian 12). · [api-core](codemap/api-core.md)
- `apps/api/prisma/seed.ts` : idempotently provisions the permanent super-admin. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations`

- `apps/api/prisma/migrations/migration_lock.toml` : Prisma lock: `provider = "sqlite"`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260619093204_init`

- `apps/api/prisma/migrations/20260619093204_init/migration.sql` : Creates the `User` table (`id`, `email`, `fullName`, `passwordHash`, `role` default `'USER'`, `isProtected` default false, `tokenVersion` default 0, `createdAt`, `updatedAt`) and the unique index `User_email_key`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260622061744_add_audit_log_and_account_status`

- `apps/api/prisma/migrations/20260622061744_add_audit_log_and_account_status/migration.sql` : Creates `AuditLog` (no foreign key) and its indexes `createdAt`, `actorId`, `targetId`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260622070404_add_project`

- `apps/api/prisma/migrations/20260622070404_add_project/migration.sql` : Creates `Project` (`id`, `title`, `ownerId`, timestamps) with the foreign key `ownerId` to `User` as `ON DELETE CASCADE`, and the index `Project_ownerId_idx`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260622072302_add_project_collaborators`

- `apps/api/prisma/migrations/20260622072302_add_project_collaborators/migration.sql` : Creates the Prisma implicit join table `_ProjectCollaborators` (`A` to `Project`, `B` to `User`, both cascading), the unique index `(A, B)` and the index on `B`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260622121210_add_template`

- `apps/api/prisma/migrations/20260622121210_add_template/migration.sql` : Creates `Template` (`id`, `name`, `description` nullable, `ownerId` cascading to `User`, timestamps) and the index `Template_ownerId_idx`. · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260624102016_add_run_model`

- `apps/api/prisma/migrations/20260624102016_add_run_model/migration.sql` : Creates `Run` (`projectId` cascading to `Project`, `solver`, `status` default `'queued'`, `pid`, `exitCode`, `command`, `logPath`, `reason`, `startedAt`, `finishedAt`, timestamps) and the indexes `projectId` and … · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260702130000_add_template_tags`

- `apps/api/prisma/migrations/20260702130000_add_template_tags/migration.sql` : Adds `Template.tags` (TEXT, not null, default `'[]'`, serialized JSON array). · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260703120000_add_run_cores`

- `apps/api/prisma/migrations/20260703120000_add_run_cores/migration.sql` : Adds `Run.cores` (INTEGER, not null, default 1). · [api-core](codemap/api-core.md)

## `apps/api/prisma/migrations/20260831142110_chamber_saves`

- `apps/api/prisma/migrations/20260831142110_chamber_saves/migration.sql` : Creates `ChamberSave` (`id`, `name`, `ownerId` cascading to `User`, `snapshot` TEXT, timestamps), the unique index `ChamberSave_name_key` and the index `ChamberSave_ownerId_idx`. · [api-core](codemap/api-core.md)

## `apps/api/scripts`

- `apps/api/scripts/AGENTS.md` : Zone rules: `apps/api/scripts` (Python tools) : Loaded automatically when working in `apps/api/scripts/`.
- `apps/api/scripts/CLAUDE.md` : Claude Code zone rules: `apps/api/scripts` : Imports the zone rules below (shared with Codex and other agents through `apps/api/scripts/AGENTS.md`).
- `apps/api/scripts/CgnsInspect.py` : reads a CGNS produced by `FoamToCgns.py` / `CgnsMergeTime.py` and prints a JSON validation report. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/CgnsMergeTime.py` : merges the per-time-step HDF5 CGNS files (ParaView's `out_<i>.cgns`) into ONE transient CGNS readable by Ansys CFD-Post (`BaseIterativeData` / `ZoneIterativeData` / `FlowSolutionPointers` nodes). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/CgnsToVtk.py` : converts a CGNS (ADF or HDF5) into pure-topology legacy ASCII VTK for `vtkUnstructuredToFoam`. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/FoamToCgns.py` : exports a solved OpenFOAM case to CGNS for CFD-Post (cell-centered data, polyhedra not decomposed). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/_test_hub_shroud_math.py` : Standalone unit test (outside pytest: the `_` prefix prevents its collection) of the pure functions `_hub_point_radii` and `_shroud_fillet_profile` of `buildChamber.py`, imported as the `buildChamber` module (to be run f … · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/_verify_outlet_ratio.py` : manual check of a vaned build: outlet sizing and preservation of the hub/shroud profiles. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/bakeVaneBladeProfile.py` : offline (one-time) tool that extracts the clean NURBS vane profile from the SolidWorks STEP and writes it to `assets/guideVanes_blade_profile.json`, registered onto the mid-height section of `guideVanes_blade.stl`. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/buildChamber.py` : "one-shot" geometry builder of the Chamber Creation feature. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/csv_to_boundaryData.py` : converts a velocity profile CSV (ParaView / CFX-Post export at the runner outlet) into the `constant/boundaryData/<patch>/` format read by `timeVaryingMappedFixedValue`. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/extractPatches.py` : reads the boundary patches of an OpenFOAM case and produces a compact GLB + JSON manifest + `edges.bin` for the three.js viewer. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/mirrorStep.py` : produces the mirrored STEP of a chamber (YZ plane, x to -x, then translation by `xmin + xmax`) for the "Change rotational direction" action: same bounding box, only the chirality changes. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/preprocessVanes.py` : offline (one-time) tool that splits `GuideVanes50DegOpen.stl` (17 components: 16 blades + 1 shell) into committed assets. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/requirements-geometry.txt` : Pinned environment of the geometry suite (mirror of the local WSL CadQuery venv): `cadquery==2.8.0`, `trimesh==4.12.2`, `numpy==2.4.6`, `scipy==1.18.0`, `networkx==3.6.1`, `manifold3d==3.5.2`, `shapely==2.1.2` … · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/requirements.txt` : Version floors of the runtime dependencies, per script: `vtk>=9.2` (CgnsToVtk, CgnsInspect; `FoamToCgns.py` excluded because ParaView), `h5py>=3.0` (CgnsMergeTime), `pyvista>=0.43`, `trimesh>=4.0`, `numpy>=1.24` (extract … · [api-scripts](codemap/api-scripts.md)

## `apps/api/scripts/assets`

- `apps/api/scripts/assets/guideVanes.json` : Metadata of the distributor asset (written by `preprocessVanes.py`, read by `_load_vane_meta()` in `buildChamber.py`). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/assets/guideVanes_blade.stl` : Binary STL (~380 KB): one representative blade, recentered on the ring axis, base opening 50°. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/assets/guideVanes_blade_profile.json` : Clean vane profile (160 `airfoil` points [x, y] in meters, asset frame) extracted from the SolidWorks STEP by `bakeVaneBladeProfile.py`. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/assets/guideVanes_outlet.stl` : Binary STL (~420 KB): the annular outlet face of the passage (hub to shroud, slightly conical), exported separately from CAD and recentered on its own axis. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/assets/guideVanes_walls.stl` : Binary STL (~9.7 MB): the passage wall shell (hub + shroud) at full resolution, without the outlet cap. · [api-scripts](codemap/api-scripts.md)

## `apps/api/scripts/tests`

- `apps/api/scripts/tests/conftest.py` : infrastructure of the real geometry suite (no mocks). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/tests/test_build_chamber.py` : the guarantees of `buildChamber.py` the API depends on: output contract (last stdout line `OK:`; `KO:` + exit code 1), watertight STL, golden volume (`GOLDEN`, tolerance `VOL_RTOL = 5e-3`), names and order of the manifes … · [api-scripts](codemap/api-scripts.md)

## `apps/api/scripts/tests/params`

- `apps/api/scripts/tests/params/hollow-vanes-overrides.json` : Real parameters (`hollow` variant, `guideVanes: true`, `feetEnabled: false`, `partScale` 1, overrides `dFirst` 2.92 / `dMiddle` 2.23126, `outletOuterD` 1.68, `outletRatio` 0.45, `simplifyGenerator: false`). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/tests/params/hollow-vanes.json` : Vaned `hollow` variant, feet enabled, `partScale` 0.7944 (the maximum that fits in `height` 2.7; at 1 the build is refused), `outletOuterD` 1.68, `outletRatio` 0.45. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/tests/params/stepped-feet-off.json` : Identical to `stepped.json` with `feetEnabled: false` (used for the feet volume delta). · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/tests/params/stepped-vanes.json` : `stepped` variant with `guideVanes: true`; asymmetric chamfer 2 (`chamferLength2` 0.90435, `chamferWidth2` 0.63466) and `distFromEnd` 2.19593. · [api-scripts](codemap/api-scripts.md)
- `apps/api/scripts/tests/params/stepped.json` : Reference `stepped` configuration (no vanes, feet at 40°, symmetric chamfers 1.29158). · [api-scripts](codemap/api-scripts.md)

## `apps/api/src`

- `apps/api/src/app.ts` : factory for the Express application, without listening (imported directly by the supertest tests). · [api-core](codemap/api-core.md)
- `apps/api/src/server.ts` : process bootstrap. Creates the app, launches `reconcileOrphanRuns()` (active solver runs from a previous process set to `failed`) and `reconcileOrphanMeshingRuns()` without awaiting them, listens on `env.PORT`, then … · [api-core](codemap/api-core.md)

## `apps/api/src/config`

- `apps/api/src/config/env.ts` : validated configuration for the whole API. · [api-core](codemap/api-core.md)

## `apps/api/src/lib`

- `apps/api/src/lib/AppError.ts` : Single operational error class of the API. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/audit.ts` : audit log of sensitive actions (auth and administration) in the append-only `AuditLog` table. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/boundaryData.ts` : converts a runner outlet CSV profile (draft tube inlet) into `constant/boundaryData/<inlet>/{points, 0/U [, 0/k, 0/omega]}` for a `timeVaryingMappedFixedValue` BC. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/caseStorage.ts` : `fileTreeStorage` facade pinned to `<STORAGE_DIR>/projects/<projectId>/case/`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/cfMeshDicts.ts` : pure rendering of `system/meshDict` for `cartesianMesh` (cfMesh) and resolution of the base cell size. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/cfMeshPipeline.ts` : runs the cfMesh pipeline of a meshing session and returns a step report in the same format as snappy. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/cgnsStorage.ts` : `fileTreeStorage` facade on `<STORAGE_DIR>/projects/<projectId>/cgns/`, which stores the CGNS sources (and the intermediate `.vtk` of the conversion) away from the case so that a case reset does not touch them. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/chamberStorage.ts` : global cache (not tied to a project) of the chamber generator's artifacts, under `<STORAGE_DIR>/chamber/<hash>/`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/commandRunner.ts` : injectable wrapper of `child_process.execFile` for one-shot tools. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/cores.ts` : `coreBudget(): number` returns the maximum number of cores a parallel job may use: `env.SOLVER_TOTAL_CORES` if it is > 0, otherwise `os.cpus().length`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/exportStorage.ts` : storage of a project's CFD-Post export artifacts under `<STORAGE_DIR>/projects/<projectId>/export/`, sibling of `case/`, `cgns/`, `viz/`, `runs/`: producing or clearing an export does not touch the case, and a case reset … · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/fileTreeStorage.ts` : directory-tree storage core parameterized by an absolute root, shared by all facades. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/jwt.ts` : signing and verification of access JWTs (short-lived, `sub` + `role`) and refresh JWTs (long-lived, `sub` + `tokenVersion`, stored in an httpOnly cookie; a logout increments the version to revoke). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/logger.ts` : Minimal dependency-free console logger: `logger.info` / `warn` / `error(message, ...args)` prefix an ISO timestamp and the level (`[INFO]`, `[WARN]`, `[ERROR]`) and delegate to `console.log` / `console.warn` / … · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshBackupStorage.ts` : single-slot backup of a project's case, to make mesh edits reversible (patch renaming/retyping, autoPatch, merge, BC application). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshImport.ts` : converts a single mesh file (`.cgns` or Fluent/Gmsh `.msh`) into the `constant/polyMesh` of a target case, with a step report. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshPatches.ts` : Pure, defensive parsing of the patch names of a cfMesh input surface, for the per-patch BC type editor. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshPipelineRun.ts` : plumbing shared by the snappyHexMesh and cfMesh pipelines: shape of the step report, short-circuiting sequential runner (buffered or streaming to a log), and a preliminary "Allclean". · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshSourceVizStorage.ts` : 3D render cache of a mesh library source, under `projects/<id>/meshes/<meshId>/.viz/{patches.glb, manifest.json, edges.bin}`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshStorage.ts` : reusable library of a project's imported polyMesh sources and transient merge workspace, under `projects/<id>/meshes/`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshTransform.ts` : in-process rigid transformation of a `constant/polyMesh/points` file (`p' = R·p + t`) to "bake" the placement of a part added during an assembly, with bit-for-bit parity with the browser's three.js preview (same … · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshingStorage.ts` : storage of standalone meshing sessions (STL to snappyHexMesh or cfMesh to polyMesh), under `<STORAGE_DIR>/meshing/<sessionId>/`, not tied to a project. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/meshingVizStorage.ts` : 3D render cache of a meshing session's resulting mesh, `meshing/<sessionId>/.viz/{patches.glb, manifest.json, edges.bin}`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/openfoamCase.ts` : purely textual OpenFOAM domain (no I/O). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/openfoamCommand.ts` : single invocation point for OpenFOAM utilities and single failure rule. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/password.ts` : `hashPassword(plain): Promise<string>` hashes with argon2id (library default parameters, salt included in the encoded hash). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/prisma.ts` : Exports `prisma`, the single `PrismaClient` of the API (avoids multiple SQLite connection pools). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/residualParser.ts` : pure parser of an OpenFOAM solver log into a time series of initial residuals plus convergence or divergence signals. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/role.ts` : Re-exports `ROLES` and `Role` from `@dive/shared`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/runStorage.ts` : storage of a project's solver runs, `projects/<id>/runs/<runId>/solver.log`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/serializeUser.ts` : `PublicUser` is the public shape of a user (`id`, `email`, `fullName`, `role`, `isProtected`, `isActive`, `lastLoginAt | null`, `createdAt`, `updatedAt` in ISO 8601). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/snappyDicts.ts` : pure renderings of a snappyHexMesh session's dictionaries (kept separate from the solver-oriented files of `openfoamCase`) and computation of the background domain from the STL bbox. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/snappyPipeline.ts` : runs a session's snappyHexMesh pipeline and returns the step report. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/stlBounds.ts` : pure TypeScript parsing of an STL into its axis-aligned bounding box, to size the snappy domain and the keep point without OpenFOAM. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/stlMerge.ts` : in-process merge of several STLs (ASCII or binary) into a single multi-solid ASCII STL, one solid (hence one cfMesh patch) per file. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/streamRunner.ts` : injectable, never-throwing runner for long processes (solver, streamed meshing steps). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/templateStorage.ts` : `fileTreeStorage` facade for reusable file templates, `<STORAGE_DIR>/templates/<templateId>/files/<free tree>`. · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/terminalSession.ts` : an interactive shell session for the project terminal, independent of the transport (the WebSocket bridge is `terminal.gateway.ts`). · [api-lib](codemap/api-lib.md)
- `apps/api/src/lib/vizStorage.ts` : 3D render cache of a project's case mesh, `projects/<id>/viz/{patches.glb, manifest.json, edges.bin}`, produced by `scripts/extractPatches.py`. · [api-lib](codemap/api-lib.md)

## `apps/api/src/middleware`

- `apps/api/src/middleware/asyncHandler.ts` : Exports `asyncHandler(handler): RequestHandler`: wraps a possibly asynchronous handler and forwards any rejected promise to `next`, so that `errorHandler` runs. · [api-core](codemap/api-core.md)
- `apps/api/src/middleware/errorHandler.ts` : renders the normalized envelope `{ error: { code, message } }`. · [api-core](codemap/api-core.md)
- `apps/api/src/middleware/rateLimit.ts` : Exports `loginRateLimiter` (`express-rate-limit`): 10 attempts per 15 minutes per IP (1000 if `process.env.NODE_ENV === 'test'`), standard `RateLimit-*` headers, 429 `RATE_LIMITED` response. · [api-core](codemap/api-core.md)
- `apps/api/src/middleware/requireAuth.ts` : requires an access token `Authorization: Bearer <jwt>`. · [api-core](codemap/api-core.md)
- `apps/api/src/middleware/requireRole.ts` : Exports `requireRole(role: TokenRole): RequestHandler`: 401 `UNAUTHENTICATED` if `req.user` is missing, 403 `FORBIDDEN` if the role differs. · [api-core](codemap/api-core.md)
- `apps/api/src/middleware/validate.ts` : zod validation of requests. · [api-core](codemap/api-core.md)

## `apps/api/src/modules/audit`

- `apps/api/src/modules/audit/audit.controller.ts` : Exports `listAuditLogsController(req, res)`: reads `req.validated.query.limit` (fallback `AUDIT_DEFAULT_LIMIT`) and responds `200 { logs }`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/audit/audit.routes.ts` : Exports `createAuditRouter(): Router`, mounted on `/api/v1/audit-logs`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/audit/audit.schemas.ts` : Exports `AUDIT_DEFAULT_LIMIT = 50`, `AUDIT_MAX_LIMIT = 200`, `listAuditLogsQuerySchema` (`limit` coerced to an integer 1..200, default 50) and the type `ListAuditLogsQuery`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/audit/audit.service.ts` : read-only access to the audit log (writing lives in `lib/audit`). · [api-core](codemap/api-core.md)

## `apps/api/src/modules/auth`

- `apps/api/src/modules/auth/auth.controller.ts` : HTTP adapters for authentication; they handle the refresh cookie and auditing. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/auth/auth.cookies.ts` : Exports `REFRESH_COOKIE_NAME = 'refresh_token'`, `setRefreshCookie(res, token)` (lifetime `REFRESH_TOKEN_TTL_DAYS` days) and `clearRefreshCookie(res)`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/auth/auth.routes.ts` : Exports `createAuthRouter(): Router`, mounted on `/api/v1/auth`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/auth/auth.schemas.ts` : Exports `loginSchema` (email trim + format, non-empty password with no minimum), `updateMeSchema` (`fullName` 1..`FULL_NAME_MAX_LENGTH`), `changePasswordSchema` (`currentPassword` non-empty, `newPassword` … · [api-core](codemap/api-core.md)
- `apps/api/src/modules/auth/auth.service.ts` : Express-independent authentication logic. · [api-core](codemap/api-core.md)

## `apps/api/src/modules/chamber`

- `apps/api/src/modules/chamber/chamber-saves.controller.ts` : Chamber save adapters: `listChamberSavesController` (`200 { saves }`), `createChamberSaveController` (`201 { save }`), `updateChamberSaveController` (`200 { save }`), `deleteChamberSaveController` (`204`). · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber-saves.schemas.ts` : Exports `chamberSaveCreateSchema` (`name` trim 1..`CHAMBER_SAVE_NAME_MAX`, `snapshot: chamberBuildSchema`), `chamberSaveUpdateSchema` (`name?`, `snapshot?`, at least one of the two) and `chamberSaveIdParamSchema`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber-saves.service.ts` : named, shared saves of `POST /chamber/build` bodies. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber.controller.ts` : adapters for the chamber generator. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber.routes.ts` : Exports `createChamberRouter(): Router`, mounted on `/api/v1/chamber`, entirely behind `requireAuth`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber.schemas.ts` : zod schemas for the chamber routes: build body (inputs X1..X4, constraints, relations, geometric options) and hash and export parameters. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/chamber/chamber.service.ts` : evaluates the empirical model (`@dive/shared`) then delegates geometry to `scripts/buildChamber.py` (CadQuery). · [api-core](codemap/api-core.md)

## `apps/api/src/modules/dashboard`

- `apps/api/src/modules/dashboard/dashboard.controller.ts` : Exports `getDashboardController`: builds the `Viewer` and responds `200` with `getDashboard(viewer)`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/dashboard/dashboard.routes.ts` : Exports `createDashboardRouter()`, mounted on `/api/v1/dashboard`: `requireAuth` then `GET /`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/dashboard/dashboard.service.ts` : single aggregate queried by the home page: machine metrics (`node:os`) and runs visible to the user. · [api-core](codemap/api-core.md)

## `apps/api/src/modules/meshing`

- `apps/api/src/modules/meshing/meshing.controller.ts` : adapters for the Meshing page (global sessions, not tied to a project). · [api-core](codemap/api-core.md)
- `apps/api/src/modules/meshing/meshing.routes.ts` : Exports `createMeshingRouter()`, mounted on `/api/v1/meshing`, behind `requireAuth`: `GET /`, `POST /`, `POST /copy`, `POST /from-chamber`, `GET|PATCH|DELETE /:id`, `POST|GET|DELETE /:id/stl`, `POST /:id/run` … · [api-core](codemap/api-core.md)
- `apps/api/src/modules/meshing/meshing.schemas.ts` : zod schemas for the meshing routes: session creation, rename and copy, transfer from Chamber, snappy/cfMesh configuration. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/meshing/meshing.service.ts` : logic for standalone mesh sessions (STL/FMS to snappyHexMesh or cfMesh to `constant/polyMesh`). · [api-core](codemap/api-core.md)

## `apps/api/src/modules/projects`

- `apps/api/src/modules/projects/boundary.controller.ts` : controller of the "Boundary conditions" overlay. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/boundary.schemas.ts` : zod shape schema for the BC overlay payload. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/boundary.service.ts` : applies a per-component boundary condition preset (Turbine / Pipe / DraftTube / Chamber + driving mode) to all `0/` fields of the case, optionally with the rotor dictionary (MRF or dynamic mesh) for a turbine. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/conversion.controller.ts` : HTTP adapters for the CGNS upload and the CGNS→OpenFOAM conversion. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/conversion.schemas.ts` : Zod schemas: `convertCgnsSchema` (`cgnsFile`, `templateId`, non-empty strings) and `cgnsNameQuerySchema` (non-empty `name`), with the types `ConvertCgnsInput` and `CgnsNameQuery`. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/conversion.service.ts` : management of a project's CGNS sources (stored outside the case via `cgnsStorage`) and the "Convert to Foam" pipeline that produces `constant/polyMesh` from a chosen CGNS, applying a template for the rest of the configur … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/export.controller.ts` : HTTP adapters for the OpenFOAM→CGNS export ("Export" tab). · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/export.schemas.ts` : Schema `exportArtifactParamSchema`: params `id` + `artifact` ∈ `cgns | session | memo | report`; type `ExportArtifactParam`. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/export.service.ts` : 4-step pipeline that turns a solved OpenFOAM case into a CGNS loadable by Ansys CFD-Post, plus a `.cse` session, a memo and a report. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/files.controller.ts` : HTTP adapters for case files, and the shared multipart parser `parseCaseUpload` (reused by the CGNS, meshes, templates and meshing routes). · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/files.schemas.ts` : zod schemas for the case-file endpoints. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/files.service.ts` : logic of a project's OpenFOAM case folder: tree, import, reset, zip, verification of mandatory files, base scaffolding and "Make runnable" per solver/turbulence model, synchronization of the `boundaryField`s with the mes … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/mesh.controller.ts` : HTTP adapters for the 3D viewer of the case mesh ("Visualize" tab) and for editing its patches / backup. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/mesh.schemas.ts` : zod schemas for the actions on the case mesh. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/mesh.service.ts` : 3D rendering of the case mesh (offline extraction of the boundary surfaces to GLB + JSON manifest, cached in the `viz/` store) and editing operations on `boundary` with propagation into the `0/` fields, single-slot backu … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/meshes.controller.ts` : HTTP adapters for the multi-mesh library and the merge/assembly. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/meshes.schemas.ts` : zod schemas for the merge plan and for edits of library sources. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/meshes.service.ts` : per-project library of reusable polyMesh meshes (stored outside the case under `meshes/`, see `meshStorage`), "Assembly v2" merge pipeline that combines an ordered subset into the case's `constant/polyMesh`, and per-sour … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/projects.controller.ts` : HTTP adapters for project CRUD and collaborators. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/projects.routes.ts` : Express router of the module, mounted on `/api/v1/projects`. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/projects.schemas.ts` : Zod schemas: `createProjectSchema` and `renameProjectSchema` (`title` trimmed, 1 to `PROJECT_TITLE_MAX_LENGTH`), `addCollaboratorSchema` (valid `email`), `projectIdParamSchema` (`id`), `collaboratorParamSchema` (`id` … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/projects.service.ts` : project business logic and the visibility rule shared by the whole module (and by `templates`, `chamber`, `dashboard` via the `Viewer` type). · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/runs.controller.ts` : HTTP adapters for solver runs: `startRunController` (201 `{ run }`), `listRunsController` (200 `{ runs }`), `getRunController` (200 `{ run }`), `getRunLogController` (200, raw payload), `stopRunController` (200 `{ run }` … · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/runs.schemas.ts` : Schemas: `startRunSchema` (optional `solver` ∈ `SOLVER_IDS`, optional `cores` coerced integer 1 to 1024) and `runIdParamSchema` (`id`, `runId`), type `StartRunInput`. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/runs.service.ts` : the app's first long-running job. · [api-projects](codemap/api-projects.md)
- `apps/api/src/modules/projects/terminal.gateway.ts` : WebSocket gateway to an interactive shell (`terminalSession`) whose cwd is the project's storage root. · [api-projects](codemap/api-projects.md)

## `apps/api/src/modules/templates`

- `apps/api/src/modules/templates/templates.controller.ts` : adapters for shared file templates, plus three handlers mounted on the projects router. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/templates/templates.routes.ts` : Exports `createTemplatesRouter()`, mounted on `/api/v1/templates`, behind `requireAuth`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/templates/templates.schemas.ts` : Exports `createTemplateSchema` (`name`, `description?`, raw `tags?` up to 24 items of 72 characters, `file?` `{ path, content }`), `updateTemplateSchema` (at least one field), `templateIdParamSchema`, `createFileSchema` … · [api-core](codemap/api-core.md)
- `apps/api/src/modules/templates/templates.service.ts` : shared reusable templates. · [api-core](codemap/api-core.md)

## `apps/api/src/modules/users`

- `apps/api/src/modules/users/users.controller.ts` : Back-office adapters: `listUsersController` (`{ users }`), `getUserController`, `createUserController` (201), `updateUserController`, `deleteUserController` (204). · [api-core](codemap/api-core.md)
- `apps/api/src/modules/users/users.routes.ts` : Exports `createUsersRouter()`, mounted on `/api/v1/users`, entirely behind `requireAuth` + `requireRole('SUPER_ADMIN')`: `GET /`, `POST /`, `GET|PATCH|DELETE /:id`. · [api-core](codemap/api-core.md)
- `apps/api/src/modules/users/users.schemas.ts` : Exports `roleSchema` (re-export), `createUserSchema` (`fullName`, `email`, `password`, `role`, all required), `updateUserSchema` (same fields optional plus `isActive?`, at least one field), `userIdParamSchema` and the ty … · [api-core](codemap/api-core.md)
- `apps/api/src/modules/users/users.service.ts` : account management by the super-admin, with hard rules: unique lowercase email, protected super-admin cannot be demoted, disabled or deleted, users cannot disable or delete themselves. · [api-core](codemap/api-core.md)

## `apps/api/src/types`

- `apps/api/src/types/express.d.ts` : Global augmentation of `Express.Request`: `user?: PublicUser & { role: Role }` (set by `requireAuth`) and `validated?: { body?, params?, query? }` (set by `validate`). · [api-core](codemap/api-core.md)

## `apps/api/tests`

- `apps/api/tests/account.test.ts` : `PATCH /api/v1/auth/me` (401 without auth, renaming one's own `fullName`, `passwordHash` never serialized, 422 `VALIDATION_ERROR` on a blank name, `role`/`email` fields ignored: no privilege escalation) and … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/accountStatus.test.ts` : `PATCH /api/v1/users/:id { isActive }`. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/appConfig.test.ts` : Single test of `GET /api/v1/config` without authentication: returns exactly `{ terminalEnabled: false }` since `TERMINAL_ENABLED` is not defined in the test env (the project terminal is disabled by default). · [api-tests](codemap/api-tests.md)
- `apps/api/tests/audit.test.ts` : `GET /api/v1/audit-logs` (401, 403 `FORBIDDEN` for a `USER`) and action recording: `LOGIN` with `actorEmail` and `createdAt`, `USER_CREATED` with `targetEmail` and `metadata.role`, `USER_DISABLED`, sorting and the … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/auth.test.ts` : `POST /auth/login` (200 + `accessToken` + `user` without `passwordHash` or `tokenVersion`, `refresh_token` cookie `HttpOnly` and `Path=/api/v1/auth`), 401 `INVALID_CREDENTIALS` with the same `Invalid email or password` m … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/boundary.test.ts` : the pure boundary conditions renderers of `src/lib/openfoamCase` (CFD contract from `documents/*_BCs*.txt`) and the `POST /projects/:id/boundary-conditions/apply` endpoint. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/cfMeshDicts.test.ts` : `resolveMaxCellSize` (configured size, otherwise bounds diagonal/40, `null` without size or bounds for an FMS input) and `renderMeshDict` from `src/lib/cfMeshDicts`: `surfaceFile` and `maxCellSize`, optional entries omit … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/chamber.test.ts` : Chamber Creation, `POST /api/v1/chamber/build` and the hash-based reads (`/chamber/:hash/manifest|geometry|edges|export/:kind`). · [api-tests](codemap/api-tests.md)
- `apps/api/tests/chamberModel.test.ts` : `computeChamberOutputs` (12 X1 to X3 fits with relations off, `linear`/`power` shapes, snap to the 50 mm `CHAMBER_GRID_MM` grid, default structural relations `height = LEB + LEOW`, `LEB = 2 × HLE`, chamfer chain … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/chamberPatchTypes.test.ts` : contract parity: `CHAMBER_PATCH_TYPES` (`@dive/shared`) equals the `PATCH_TYPES` dict of `apps/api/scripts/buildChamber.py`. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/chamberSaves.test.ts` : `/api/v1/chamber/saves` (named, shared snapshots of the build body): 401 on read and create, creation with trimmed name and `owner { id, fullName }`, snapshot normalized by the schema (defaults `variant: 'stepped'` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/conversion.test.ts` : CGNS upload (`POST/GET/DELETE /projects/:id/cgns`, 400 `INVALID_CGNS` for non-`.cgns`, 404 for an invisible project or a missing file) and the `POST /projects/:id/cgns/convert` pipeline: steps `cgnsToVtk` → `vtkToFoam` → … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/dashboard.test.ts` : `GET /api/v1/dashboard`: shape of server metrics (`cpuPercent` between 0 and 100, `cores > 0`, `memTotalBytes > 0`), `activeRuns` with `projectTitle`, `recentRuns`, grouped `runCounts`, `recentProjects` with per-project … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/export.test.ts` : OpenFOAM → CGNS export (`POST/GET /projects/:id/export`, `GET …/export/download/:artifact`): 4 steps `inspect` → `convert` → `validate` → `cfdpost`, `profile` (`solver: simpleFoam`, `steady`, `incompressible` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/fileTreeStorage.test.ts` : `comparePaths` from `src/lib/fileTreeStorage` (a folder and its children come before a prefix sibling: `0`, `0/p`, `0/U`, then `0.orig`) and `extractArchiveAt` ("H9" decompression cap: 413 `ARCHIVE_TOO_LARGE` before any … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/globalSetup.ts` : vitest `globalSetup`, executed once before the whole suite. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/helpers.ts` : utilities shared by all integration tests: single app instance, database reset, user factories, tokens, and the `logicalCommand` tool for fake OpenFOAM runners. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/mesh.test.ts` : project mesh viewer (Visualize tab) and editing of the case mesh. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshFromMeshing.test.ts` : `POST /projects/:id/mesh/from-meshing` (WS-F), 14 tests: 401; 404 for a stranger (case untouched), unknown session; 422 bad target, unsafe `sessionId`, blank name; super-admin allowed; 409 `MESH_IN_PROGRESS` via … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshPatches.test.ts` : Pure unit tests of `src/lib/meshPatches`: `parseFmsPatches` reads names and types from the FMS header (`[]` without a patch block); `parseStlSolidNames` lists the `solid`s of a multi-solid ASCII STL ( … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshTransform.test.ts` : `transformMeshPoints` and `isIdentityTransform` from `src/lib/meshTransform`, the server half of the parity proof with the three.js preview. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshes.test.ts` : multi-mesh library and assembly pipeline (`/projects/:id/meshes/**`). · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshing.test.ts` : standalone Meshing (`/api/v1/meshing/**`, STL → snappyHexMesh or cfMesh → polyMesh). · [api-tests](codemap/api-tests.md)
- `apps/api/tests/meshingStorage.test.ts` : helpers of `src/lib/meshingStorage`: `slugifySessionName` (lowercase, accents removed, fallback `session`), `sanitizeStlName` (safe basename, `.stl` extension forced, traversal removed, fallback `surface.stl`) … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/openfoamCase.test.ts` : `collapseBoundaryToSinglePatch` (a single `defaultFaces`, `nFaces` summed, minimum `startFace`, header kept), `removeEmptyBoundaryPatches` (removes 0-face patches and renumbers, including dashed names; `only` filter) … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/projectFiles.test.ts` : case files of a project (`/projects/:id/files/**`): empty tree, 401, 404 for an outsider; folder import (bare polyMesh placed under `constant/polyMesh/`); 400 `NO_FILES_UPLOADED`; zip import; 400 `INVALID_ARCHIVE` for a … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/projects.test.ts` : `POST /api/v1/projects` (401, 201 with `ownerId` not serialized but actually stored, 422 blank title), `PATCH /projects/:id` (rename, 422, 404 for an outsider without leaking existence), `GET /projects` (only one's own p … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/projectsAccess.test.ts` : visibility (project hidden from a non-member, visible to an added collaborator, super-admin sees everything), `GET /projects/:id` (404 `NOT_FOUND` for a non-member, `owner` and `collaborators` for the owner), `DELETE` (2 … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/residualParser.test.ts` : Pure unit tests of `src/lib/residualParser`. · [api-tests](codemap/api-tests.md)
- `apps/api/tests/runnable.test.ts` : Unit tests of `src/lib/openfoamCase`: `renderSolverFile` for `simpleFoam`, `pimpleFoam` (PIMPLE, `Euler`, `adjustTimeStep`, no `residualControl`), `rhoSimpleFoam` (`perfectGas` thermo, `0/T`, absolute `0/p` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/snappyDicts.test.ts` : `computeDomain` (enlarged box, cell count from `baseCellSize`, location-in-mesh point at the center for internal, in an outer corner for external, explicit point takes precedence), `regionNameFor`, `renderBlockMeshDict` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/snappyPipeline.test.ts` : `runSnappyPipeline` called directly (without HTTP): dictionaries written into `system/`, order `blockMesh`, `surfaceFeatureExtract`, `snappyHexMesh`, `checkMesh`; MPI chain when `cores > 1` (`decomposePar`, `mpirun` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/solver.test.ts` : lifecycle of solver runs (`/projects/:id/runs/**`): start 201 `running`, classification `converged` (banner), `completed` (exit 0 without banner), `failed` (non-zero exit, `FOAM FATAL ERROR`, spawn ENOENT with `reason` " … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/solverCatalog.test.ts` : Pure contract of `@dive/shared`: every solver in `SOLVER_LIBRARY` has an entry in `SOLVER_CATALOG` and `isConfigurableSolver` true (`foamRun` and unknown ids excluded); `full` tier for the `incompressible`/`compressible` … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/stlBounds.test.ts` : Pure unit tests of `src/lib/stlBounds`: `parseStlBounds` on binary STL (detected only by the exact size 84 + n·50) and ASCII, `valid: false` and `triangleCount: 0` on unreadable content; `unionBounds` component by compon … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/stlMerge.test.ts` : Unit tests of `mergeStlFilesToAscii` (`src/lib/stlMerge`) on a temporary folder cleaned in `afterEach`: merge into a multi-solid ASCII STL (one `solid` per file, named after the root name), binary STL read back and re-em … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/templates.test.ts` : shared templates (`/api/v1/templates/**`): 401, creation and listing for everyone with `owner.email`, 404, update by the author (403 outsider, super-admin allowed), deletion by the author; template files (creation, 409 … · [api-tests](codemap/api-tests.md)
- `apps/api/tests/users.test.ts` : back office `/api/v1/users`: 401, 403 `FORBIDDEN` for a `USER`, list with the protected super-admin first and without secrets, creation 201 with working login, 409 `EMAIL_TAKEN`, 422 short password, single read and 404 … · [api-tests](codemap/api-tests.md)

## `apps/api/tests/fixtures`

- `apps/api/tests/fixtures/CgnsToVtk.py` : Never-executed stub (`sys.exit("stub: ...")`): the conversion checks that the script exists before launching python, and `apps/api/vitest.config.ts` points `CGNS_TO_VTK_SCRIPT` at this file while injecting a fake command … · [api-scripts](codemap/api-scripts.md)
- `apps/api/tests/fixtures/extractPatches.py` : Never-executed stub, same principle: `vitest.config.ts` points `EXTRACT_PATCHES_SCRIPT` at this file to satisfy the existence check of the extraction pipeline. · [api-scripts](codemap/api-scripts.md)

## `apps/mcp`

- `apps/mcp/.env.example` : Configuration template for the MCP server: `DIVE_API_URL` (includes `/api/v1`; deployed example `http://192.168.5.51/api/v1` behind a reverse proxy on port 80, or `http://localhost:4000/api/v1` in dev), `DIVE_MCP_EMAIL` … · [root-shared-mcp](codemap/root-shared-mcp.md)
- `apps/mcp/README.md` : documentation of the MCP server: principle (HTTP wrapper, re-login on 401 because the access token lives 15 minutes), setup (service account, `.env`, `npm install`, registration via `.mcp.json`, standalone test … · [root-shared-mcp](codemap/root-shared-mcp.md)
- `apps/mcp/package.json` : Package `@dive/mcp` (ESM, `type: module`). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `apps/mcp/tsconfig.json` : Extends `tsconfig.base.json`; `module`/`moduleResolution` `NodeNext` (hence imports suffixed with `.js`), `outDir: dist`, `rootDir: src`, `lib` ES2022 + DOM (for `fetch`, `FormData`, `Blob`), `types: ["node"]`. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `apps/mcp/src`

- `apps/mcp/src/client.ts` : HTTP client for the DIVE API for a long-running Node process. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `apps/mcp/src/config.ts` : loads `apps/mcp/.env` (path resolved from the file, so independent of the working directory chosen by Claude Code) with `dotenv`, then validates the variables. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `apps/mcp/src/server.ts` : entry point of the MCP server `dive-mcp` v0.1.0 over stdio transport. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `apps/web`

- `apps/web/.env.example` : Environment template: `VITE_API_URL=http://localhost:4000/api/v1` (API base URL, `/api/v1` prefix included). · [web-core](codemap/web-core.md)
- `apps/web/AGENTS.md` : Zone rules: `apps/web` (React SPA) : Loaded automatically when working in `apps/web/`.
- `apps/web/CLAUDE.md` : Claude Code zone rules: `apps/web` : Imports the zone rules below (shared with Codex and other agents through `apps/web/AGENTS.md`).
- `apps/web/index.html` : Host document: `lang="en"`, favicon `/favicon.svg`, `color-scheme: light`, `theme-color #F5F7FA`, meta description, title "DIVE Turbinen", `div#root`, module script `/src/main.tsx`. · [web-core](codemap/web-core.md)
- `apps/web/package.json` : manifest of the `@dive/web` workspace (`type: module`, private). · [web-core](codemap/web-core.md)
- `apps/web/postcss.config.js` : ESM PostCSS config: plugins `tailwindcss` then `autoprefixer`. · [web-core](codemap/web-core.md)
- `apps/web/tailwind.config.ts` : semantic mirror of `tokens.css` for Tailwind 3 (`content`: `index.html`, `src/**/*.{ts,tsx}`), `tailwindcss-animate` plugin. · [web-core](codemap/web-core.md)
- `apps/web/tsconfig.json` : App TS config: extends `../../tsconfig.base.json` (strict, `noUnusedLocals`, `noUnusedParameters`, ES2022), `moduleResolution: Bundler`, `jsx: react-jsx`, `noEmit`, `allowImportingTsExtensions`, alias `@/*` to `./src/*` … · [web-core](codemap/web-core.md)
- `apps/web/tsconfig.node.json` : Composite TS config for `vite.config.ts` only (ES2022, lib ES2023, strict), outputs under `./node_modules/.tmp/`. · [web-core](codemap/web-core.md)
- `apps/web/tsconfig.node.tsbuildinfo` : TypeScript build artifact (~45 KB) tracked by git although it should be ignored; stale (the config now writes to `node_modules/.tmp/`). · [web-core](codemap/web-core.md)
- `apps/web/tsconfig.tsbuildinfo` : TypeScript build artifact tracked by git (one line: roots `./src/app.tsx`, `./src/main.tsx`, `./src/vite-env.d.ts`, `"errors": true`, TS 5.9.3); stale and should be untracked. · [web-core](codemap/web-core.md)
- `apps/web/vite.config.ts` : Vite config (React plugin, port 5173). · [web-core](codemap/web-core.md)
- `apps/web/vitest.config.ts` : Separate Vitest config: React plugin, `@` alias only, `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`, `include: ['src/**/*.test.{ts,tsx}']`, `css: false`. · [web-core](codemap/web-core.md)

## `apps/web/public`

- `apps/web/public/favicon.svg` : 32x32 SVG favicon: rounded white square carrying the DIVE diamond (square rotated 45°) in `#004A99`. · [web-core](codemap/web-core.md)
- `apps/web/public/logo.svg` : Binary-like asset (Adobe Illustrator export, 793.51 x 211.364): official DIVE Turbinen logo, diamond emblem + wordmark, fills `#004A99` (dominant), `#EE7F00` and `#BCBDBF`. · [web-core](codemap/web-core.md)

## `apps/web/src`

- `apps/web/src/App.tsx` : Application root: `export default function App()` renders `<Providers><RouterProvider router={router} /></Providers>`. · [web-core](codemap/web-core.md)
- `apps/web/src/main.tsx` : Entry point: imports the Inter weights `@fontsource/inter` 400, 500, 600, 700 and 700-italic (self-hosted), then `./styles/index.css`, and mounts `<StrictMode><App/></StrictMode>` in `#root` (throws … · [web-core](codemap/web-core.md)
- `apps/web/src/vite-env.d.ts` : References `vite/client` and types `ImportMetaEnv` with a single variable: `readonly VITE_API_URL: string`. · [web-core](codemap/web-core.md)

## `apps/web/src/app`

- `apps/web/src/app/guards.tsx` : router route guards. They read the session status via `useAuth()` (`features/auth/AuthProvider`) and decide whether to show the loader, redirect, or render the children. · [web-core](codemap/web-core.md)
- `apps/web/src/app/providers.tsx` : composes the global providers around the routed tree. · [web-core](codemap/web-core.md)
- `apps/web/src/app/router.tsx` : route tree (`createBrowserRouter`, data router, required by `useBlocker`). · [web-core](codemap/web-core.md)

## `apps/web/src/components/brand`

- `apps/web/src/components/brand/BrandLockup.tsx` : renders the official logo `/logo.svg` as an `<img>` with explicit width/height (no layout shift). · [web-core](codemap/web-core.md)
- `apps/web/src/components/brand/Diamond.tsx` : the DIVE diamond in SVG (`rect` rotated 45°), a recurring motif (bullets, active nav marker, empty states, super-admin badge). · [web-core](codemap/web-core.md)

## `apps/web/src/components/common`

- `apps/web/src/components/common/EmptyState.tsx` : centered "teach the next step" empty state: `bg-primary-tint` pill with `Diamond`, title, one help line, optional action. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/ErrorState.tsx` : shared load-error block (`role="alert"`, `bg-danger-tint` background, `AlertTriangle` icon) with a secondary "Try again" button. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/FullPageLoader.tsx` : full-screen loader (`min-h-[100dvh]`, `bg-bg`): `BrandLockup size="lg"` + `Loader2` spinner + "Loading your workspace", `role="status"` `aria-live="polite"`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/PageHeader.tsx` : page title row: `h1` `text-2xl font-semibold`, optional subtitle, right-aligned action slot (stacked below `sm`). · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/RenameDialog.tsx` : small controlled modal to rename an entity through a single field. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/RoleBadge.tsx` : user role badge. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/StatusBadge.tsx` : active/disabled account badge, icon + text (never color alone). · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/UnsavedChangesPrompt.test.tsx` : navigation is blocked and the prompt shown when `when=true`; no interception when `when=false`; "Stay on page" stays on the page; "Discard changes" closes the prompt. · [web-core](codemap/web-core.md)
- `apps/web/src/components/common/UnsavedChangesPrompt.tsx` : guard against losing unsaved input. · [web-core](codemap/web-core.md)

## `apps/web/src/components/layout`

- `apps/web/src/components/layout/AppShell.tsx` : authenticated layout: `.skip-link` skip link to `#main`, `Header`, then `Sidebar` + `<main id="main" tabIndex={-1}>` containing a `Suspense` (`Loader2` spinner, "Loading") around the `<Outlet/>`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/layout/Header.tsx` : top bar `sticky top-0 z-sticky h-16`: on the left `MobileNav` (below `lg`) + `BrandLockup` link to `/` (`aria-label="DIVE Turbinen home"`, `alt=""`), on the right `UserMenu`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/layout/MobileNav.tsx` : the side navigation as a sliding panel (Radix Dialog) below 1024px; `Menu` button, closes on every `pathname` change. · [web-core](codemap/web-core.md)
- `apps/web/src/components/layout/Sidebar.tsx` : desktop side navigation (`w-60`, visible from `lg` up), icon + label items, diamond marker on the active item (`aria-current` provided by `NavLink`). · [web-core](codemap/web-core.md)
- `apps/web/src/components/layout/UserMenu.tsx` : avatar button (initials) opening a `DropdownMenu`: name, email, `RoleBadge`, "Account settings" link (`/account`, via `asChild` + `Link`), destructive "Log out". · [web-core](codemap/web-core.md)
- `apps/web/src/components/layout/nav.ts` : single model of the main navigation, shared by `Sidebar` and `MobileNav`. · [web-core](codemap/web-core.md)

## `apps/web/src/components/ui`

- `apps/web/src/components/ui/alert-dialog.tsx` : confirmation dialog on Radix AlertDialog, `max-w-[420px]`, `rounded-md`, `shadow-lg`, `content-in/out` animations. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/avatar.tsx` : round Radix avatar (`size-9 rounded-full`), initials fallback on `bg-primary-tint text-primary`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/badge.tsx` : compact label `text-xs font-medium rounded-sm px-2 py-1`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/button.tsx` : the single button primitive of the application. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/dialog.tsx` : Radix Dialog modal, `max-w-[480px]`, built-in `X` close button at top right. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/dropdown-menu.tsx` : tokenized Radix dropdown menu (`z-dropdown`, `shadow-md`, `rounded-sm`, items `rounded-xs`). · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/field.tsx` : label + control + help/error wrapper with ARIA wiring through React context. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/input.tsx` : 40px text field, thin border darkened on hover, blue focus ring, danger border if `aria-invalid`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/label.tsx` : Radix label (`text-sm font-medium text-text`, `peer-disabled` styles). · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/native-select.tsx` : native `<select>` styled like `Input` (40px, overlaid lucide `ChevronDown` chevron), for dense forms or ones registered via react-hook-form. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/password-input.tsx` : `Input` with a show/hide button (`Eye`/`EyeOff`, `aria-pressed`, dynamic `aria-label`). · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/segmented.tsx` : segmented control built on real `input type="radio"` (native radiogroup semantics, arrow keys), each option is a wrapping `<label>`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/select.tsx` : Radix select whose trigger is shaped like `Input` and consumes `useFieldControl()`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/separator.tsx` : 1px Radix separator `bg-border`, horizontal by default, `decorative` by default. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/skeleton.tsx` : Loading block `bg-border/70 rounded-sm` with an `animate-shimmer` sweep hidden under `motion-reduce`, `aria-hidden`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/sonner.tsx` : tokenized `sonner` toast host and single import point for `toast`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/table.tsx` : ruled table primitives (`divide-y`), `bg-bg` `text-xs` header, `h-14 tabular-nums` cells, `overflow-x-auto` container. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/tabs.tsx` : underline-style Radix tabs: active tab `border-primary font-semibold text-primary` (never orange). · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/textarea.tsx` : Text area mirroring `Input` (`min-h-20`, same states), consumes `useFieldControl()`. · [web-core](codemap/web-core.md)
- `apps/web/src/components/ui/tooltip.tsx` : Radix tooltip on a dark background `bg-text text-white`, `z-tooltip`. · [web-core](codemap/web-core.md)

## `apps/web/src/features/account`

- `apps/web/src/features/account/ChangePasswordSection.test.tsx` : a mismatched confirmation blocks submission and shows `The passwords do not match.` without calling the API; a server `ApiError('INVALID_PASSWORD')` becomes the field error `That password is incorrect.` (call checked wit … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/ChangePasswordSection.tsx` : password change form (current, new, confirmation) with a show/hide toggle `PasswordInput`. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/ProfileSection.test.tsx` : email and role label (`User`) displayed as text, no field labeled `Email`; `Save changes` button disabled as long as the name has not changed, then `updateMe('Katharina Vogel-Brandt')` and `setUser` called once. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/ProfileSection.tsx` : account identity. Email and role rendered as a `<dl>` (managed by the back office, muted note displayed); only `fullName` is editable, with its own save action. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/SettingsSection.tsx` : Presentational component `SettingsSection({ title, description, children, className? })` (interface `SettingsSectionProps` exported): bordered `<section>` (`rounded-md border bg-surface shadow-sm`) with an `h2` header + … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/schemas.test.ts` : `profileSchema` trims and accepts a valid name, rejects a blank name and a 121-character name; `changePasswordSchema` accepts a valid case, requires the current password, enforces 8 characters, puts the mismatch error on … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/schemas.ts` : zod schemas for the account forms. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/account/useAccount.ts` : TanStack mutations for the current account. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/admin`

- `apps/web/src/features/admin/DeleteUserDialog.tsx` : destructive confirmation for deleting an account. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/DisableUserDialog.tsx` : disable confirmation (sign-out everywhere + login blocked). · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/UserFormDialog.tsx` : unified create / edit account dialog. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/UsersTable.test.tsx` : delete guards (protected super-admin and self as `aria-disabled="true"`, button not natively disabled and therefore focusable, click has no effect); delete allowed on a normal account (`onDelete(normalUser)`); symmetric … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/UsersTable.tsx` : table of the account fleet: search, sort, badges, per-row actions. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/UsersTableSkeleton.tsx` : loading placeholder that mirrors the real table structure (identical headers, identical responsive columns). · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/schemas.ts` : zod schemas for the account form, differentiated by mode on the password rule. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/admin/useUsers.ts` : TanStack hooks for the account fleet. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/assemble`

- `apps/web/src/features/assemble/AssemblyManagePanel.test.tsx` : empty render without an applied assembly; "Remove" posts a reduced `MergePlan` (order, interfaces and transform of the removed part dropped) to `runMerge` and displays the report (`Mesh OK.`); "Undo assembly" opens an … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/AssemblyManagePanel.tsx` : "Disassemble" surface inserted into the `AssemblyWorkspace` toolbar. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/AssemblyMergeDialog.tsx` : three-step merge dialog (`'connections' | 'confirm' | 'run'`) opened by the workspace's orange "Merge" CTA. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/AssemblyViewer.tsx` : three.js canvas of the Assemble tab. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/AssemblyWorkspace.test.tsx` : Merge CTA disabled with a single part; non-destructive note ("backed up… Visualize tab", "cyclicAMI"); coupling then merge **without** a transform (`transforms: []`, `coupling: 'nonConformal'`); a `transforms` entry adde … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/AssemblyWorkspace.tsx` : full-height container of the Assemble tab (named export loaded with `lazy` by `ProjectDetailPage`). · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/MergeRunReport.tsx` : shared report of "what the merge pipeline did", used as a step of the merge dialog and inline in the Disassemble panel. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/PartsRail.tsx` : left pane. The project mesh library presented as an assembly roster: base selector (if a case mesh exists), ordered list, imports, patch splitting and renaming. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/PlacementPanel.tsx` : right pane. Coupling of the active part to the base (base patch picked on the canvas + mating patch of the part), then a collapsed "Reposition this part" section (6 DOF) reserved for misaligned parts. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/placement.test.ts` : the client/server **parity proof**. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/placement.ts` : placement math critical for parity (spec `ASSEMBLY_SPEC.md` sections 2d/2e cited in a comment). · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/assemble/useAssembly.ts` : TanStack Query hooks for per-source preview for the Assemble tab and the Visualize viewer. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)

## `apps/web/src/features/auth`

- `apps/web/src/features/auth/AuthProvider.tsx` : owner of the session state and provider of `AuthContext`. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/auth/auth-context.ts` : Component-free module: type `AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'`, interface `AuthContextValue` (`user`, `status`, `login`, `logout`, `setUser`) and … · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/chamber`

- `apps/web/src/features/chamber/ChamberBuildWarnings.test.tsx` : nothing is rendered for a clean build; errors appear in a "Build errors" block; errors and warnings coexist in two blocks; each warning becomes a `listitem` under "Build warnings". · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberBuildWarnings.tsx` : notices panel between the preview and the parameter table. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberExportButtons.test.tsx` : the three exports disabled without a hash then enabled; download via object URL (`getChamberExport(HASH, 'step')`, `revokeObjectURL('blob:mock')`); recovery after failure; `onDownloaded` called only on success; plain STE … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberExportButtons.tsx` : downloads of the current build as STL, STEP or OpenFOAM triSurface zip. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberInputsForm.test.tsx` : "hollow" fields visible only for `variant: 'hollow'`; rounded hints (`Blank = auto ≈ 2778 mm`, `Blank = 2 × width ≈ 8889 mm`); submission of the defaults with `undefined` overrides; typed override → number, cleared → … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberInputsForm.tsx` : presentational form for the chamber inputs. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberOutputsTable.test.tsx` : prompt when `outputs === null`; collapsed "Dimension reference" legend (`aria-expanded`, image shown/hidden); one row per output with status and relation labels (`= LEB + LEOW`, `= LF1 + LF2`); Min edit → … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberOutputsTable.tsx` : table of the twelve computed parameters (mm) with Min / Max / Exact constraints editable inline. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberSavesMenu.test.tsx` : dropdown disabled without saves; loading → `onLoad(save)`; creation; overwrite when keeping the name of the loaded save (`updateChamberSave('save-mine', { snapshot })`); inline refusal to overwrite a colleague's name ("b … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberSavesMenu.tsx` : saved-build controls in the Chamber page header: load, Save (create or overwrite by name), Rename / Duplicate / Delete menu. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/ChamberViewer.tsx` : 3D preview of a build (colored per OpenFOAM patch), reusing `MeshScene` and `PatchTable` from Visualize. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/SendToMeshingDialog.test.tsx` : default "new" mode (name `chamber-<first 8 characters of the hash>`, engine `snappy`), closing and navigation to `/meshing/sess-new`; `cfmesh` engine; existing mode without a selection sends nothing; existing body; copyF … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/SendToMeshingDialog.tsx` : transfers the build (by `hash`) to a meshing session, in three modes: new session (name + engine), existing session, copy of a session's setup with the geometry injected. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/chamberForm.test.ts` : valid defaults; cone length required in hollow only; range guards (`footAngleDeg` 0..180, `partScale` ]0,5], `vaneAngleDeg` 45..55, `outletRatio` 0.35..0.50); overrides optional but positive; `chamberInputToFormValues` r … · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/chamberForm.ts` : form contract of the chamber inputs, separated from the component for fast-refresh. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/useChamber.ts` : TanStack Query hooks of Chamber Creation. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)
- `apps/web/src/features/chamber/useChamberSaves.ts` : saved-build hooks. A single shared list (small: names + snapshots); each mutation invalidates it. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)

## `apps/web/src/features/chamber/assets`

- `apps/web/src/features/chamber/assets/chamber-dimensions.png` : PNG 1319 × 511 (≈ 390 KB): annotated CAD drawings (plan view B Kammer, B1, BF1/BF2, LF1/LF2, LT; section H Kammer, LEB, LEOW, HLE, LE Ø), imported by `ChamberOutputsTable` for the "Dimension reference" legend. · [web-features-assemble-chamber](codemap/web-features-assemble-chamber.md)

## `apps/web/src/features/dashboard`

- `apps/web/src/features/dashboard/DashboardCharts.tsx` : SVG chart primitives; colors arrive as CSS variables from `dashboardColors.ts`. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/dashboard/dashboardColors.ts` : dashboard palette expressed only in tokens (`var(--color-*)` or brand Tailwind classes). · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/dashboard/useDashboard.ts` : Exports `dashboardQueryKey = ['dashboard']` and `useDashboardQuery()`: `getDashboard` (`GET /dashboard`), `refetchInterval` 3000 ms (`POLL_MS`), `refetchIntervalInBackground: false`. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/export`

- `apps/web/src/features/export/ExportTab.tsx` : body of the Export tab: single action, step report, case profile, validation, downloads and CFD-Post loading memo. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/export/useExport.ts` : TanStack hooks for the CGNS export and a download helper. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/files`

- `apps/web/src/features/files/FileTreeEditor.tsx` : two-pane editor (tree on the left, CodeMirror editor or "easy" form on the right) with autosave, creation, deletion, and moving by drag and drop or menu. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/files/FolderImportDialog.tsx` : after a folder is selected, let the user tick the immediate children to import. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/files/folderImport.test.ts` : `groupPickedFolder` (null if empty, grouping by immediate child, folders before files then alphabetical order, fallback to the name without prefix) and `uploadPath` (root stripped by default, kept on request, bare name u … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/files/folderImport.ts` : pure logic for grouping a folder selection. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/meshing`

- `apps/web/src/features/meshing/CfMeshConfigForm.perPatch.test.tsx` : the tri-state semantics of per-patch layers in `CfMeshConfigForm` (unchecked: `noLayerPatches`; checked without Customize: nothing, mirror of the global block; Customize: a `perPatch` entry), the read-only display of "li … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/CfMeshConfigForm.tsx` : form for the cfMesh (`cartesianMesh`) parameters of a session. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/MeshResultViewer.tsx` : 3D preview of a session's result mesh. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/SendToProjectDialog.test.tsx` : 9 tests: visible projects listed, `Case mesh` default with its warning, case body + navigation to `/projects/:id?view=visualize`, "Choose a project." without a pick, library target (name prefilled with the session name … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/SendToProjectDialog.tsx` : dialog of the meshing session page that sends the session's polyMesh into a project (WS-F). · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/SnappyConfigForm.tsx` : form for the snappyHexMesh parameters of a session. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/StlViewer.tsx` : client-side three.js preview of a session's uploaded STLs, without server rendering (works without OpenFOAM). · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/meshing/useMeshing.ts` : all TanStack Query hooks of the Meshing feature. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)

## `apps/web/src/features/projects`

- `apps/web/src/features/projects/BoundaryConditionDialog.test.tsx` : the BC wizard end to end. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/BoundaryConditionDialog.tsx` : guided "What is this mesh?" overlay that writes inlet / outlet / wall boundary conditions into the case's `0/` fields from the DIVE turbine presets. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseFileEditor.tsx` : `CodeMirror` wrapper (`@uiw/react-codemirror`) to edit a case file in advanced mode. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseFileForm.test.tsx` : `CaseFileForm` in easy mode. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseFileForm.tsx` : "easy mode" editor for an OpenFOAM file. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseFilesSection.test.tsx` : empty state ("No case files yet", Import folder / Import .zip buttons); imported tree with sizes (`2.0 KB`, `512 B`) and toolbar (Verify case, Download, Reset, TopoSet); reset after `alertdialog` confirmation; Verify ope … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseFilesSection.tsx` : "Case files" card of the project detail page: import, inspection, verification, download and reset of the OpenFOAM case, plus hub for opening the overlays. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/CaseSummary.tsx` : read-only summary of the settings entered in the case dictionaries (Summary tab of `CaseFilesSection`). · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/ConvertToFoamFlow.test.tsx` : "Continue" locked without a CGNS file; listing an existing CGNS unlocks it; full flow sources → template choice → confirmation → report, with a call to … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/ConvertToFoamFlow.tsx` : guided "Convert a CGNS mesh" dialog (CGNS to `constant/polyMesh`), opened from `CaseFilesSection` (empty state or toolbar). · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/ImportReport.tsx` : per-step report of a mesh file conversion (`.cgns` / `.msh` to polyMesh), shared between the case import, the merge library and the meshing session. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/MergeMeshesFlow.test.tsx` : "Continue" locked without a mesh; a half-filled interface blocks ("Finish or remove the incomplete interface"); full flow sources → interfaces → confirmation → report with plan … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/MergeMeshesFlow.tsx` : guided "Merge meshes" dialog: combines several polyMesh sources from the project library into a single `constant/polyMesh`, with coupled patch pairs (non-conformal by default, or conformal stitch). · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamFieldCatalog.ts` : curated data for easy mode: for each recognized OpenFOAM file (by `FoamFile.object`, optionally restricted by `class`), the list of editable fields and, for enumerated ones, the exact OpenFOAM tokens. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamForm.test.ts` : `matchFoamFileDef` (match by `object`, match of a class-restricted `0/` field with `noSlip` in `boundaryFieldTypes`, `undefined` for arbitrary text and for `polyMesh/boundary`) and `foamEasyModeAvailable` (true for recog … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamForm.ts` : Helpers that connect the parsed FOAM model to the catalog, separated from `CaseFileForm.tsx` for Fast Refresh compatibility and so that the edit panel can know whether to offer easy mode without importing the form. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamModel.test.ts` : reading top-level values, the `FoamFile` header, nested patch types and vectors (`uniform (0 0 0)`); `childrenAt` to list patches; `null` on a missing or non-leaf path; surgical `setFoamValue` (banner and other entries u … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamModel.ts` : positional parser for OpenFOAM dictionaries. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/foamSummary.ts` : tolerant parser for the read-only summary (`CaseSummary`). · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/schemas.test.ts` : `createProjectSchema` accepts a normal title, rejects a blank title (trim) and a title longer than `PROJECT_TITLE_MAX_LENGTH`. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/schemas.ts` : Zod schema for the project creation form. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useBoundaryConditions.ts` : Hook for the BC overlay. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useCaseFiles.ts` : TanStack Query hooks for the tree and the content of the OpenFOAM case files. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useConversion.ts` : hooks for a project's CGNS sources and for the CGNS to OpenFOAM conversion. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useMeshes.fromMeshing.test.tsx` : `useImportMeshFromMeshing`: case target removes the case `manifest`/`glb`/`edges`, sets `files` from `result.entries`, invalidates `meshes`, `assembly`, `mergePlan`, `runnable`, `mesh/backup`; library target sets … · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useMeshes.ts` : hooks for the project's mesh library, the merge pipeline and the applied assembly. · [web-features-projects](codemap/web-features-projects.md)
- `apps/web/src/features/projects/useProjects.ts` : CRUD hooks for projects and collaborators. · [web-features-projects](codemap/web-features-projects.md)

## `apps/web/src/features/solver`

- `apps/web/src/features/solver/RadioCardGroup.tsx` : accessible group of "radio cards" (real radios hidden as `sr-only` inside a `fieldset`/`legend`, native keyboard navigation). · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/ResidualChart.tsx` : hand-made SVG chart of solver residuals, logarithmic Y axis, one line per field, no chart library (bundle discipline). · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/RunHistory.tsx` : list of a project's runs (most recent first, order provided by the API): status badge, solver, creation date, duration and exit code once finished. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/RunLog.tsx` : focusable streaming log area (`role="log"`, `tabIndex=0`) that automatically follows the end as long as the user has not scrolled up (24 px threshold). · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/RunStatusBadge.tsx` : Component `RunStatusBadge({ status, className = '' })`: pill (border + tinted background + icon + label) read from `runStatusMeta[status]`, icon spinning if `spin`. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverBrowserDialog.tsx` : "Choose a solver" overlay: the whole solver library (`SOLVER_LIBRARY`) grouped by physics family (`SOLVER_CATEGORIES`), full-text search, setup level badge. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverConfigPanel.tsx` : configuration and launch panel for a runnable case. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverFilesStep.tsx` : step 3 of the wizard, in a 90% overlay: the app's file editor (`FileTreeEditor`, Easy + Advanced, autosave) restricted to `system/`, `0/`, `constant/` (without `constant/polyMesh`), plus `Add from template file` ( … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverSetupWizard.tsx` : three-step solver setup: 1 solver choice (card for the current solver + `Browse all solvers`), 2 turbulence model choice (`TurbulencePicker`, summary, option to align boundaryFields), 3 generation then file editing ( … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverTab.test.tsx` : the full wizard journey (`simpleFoam` + `kOmegaSST` defaults, scaffold then `syncBoundaries`, opening "Edit case files"), choosing `pimpleFoam` via the browser and `realizableKE` at step 2, the runnable panel (config … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/SolverTab.tsx` : content of a project's Solver tab: launch an OpenFOAM run and follow its convergence live. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/TopoSetDialog.tsx` : project tool (button in the "Case files" bar) that writes `system/topoSetDict`, read by `topoSet` to create cellSets / cellZones (e.g. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/TurbulenceCalculator.tsx` : project tool that estimates RANS initialization values (k, epsilon, omega) from U, Dh, nu and intensity I, with per-value copy and "Write to case", which splices `internalField uniform <value>` into `0/k` and into … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/TurbulencePicker.tsx` : Component `TurbulencePicker({ value, onChange, disabled = false, name = 'turbulence' })`: one `RadioCardGroup` per approach in `TURBULENCE_APPROACHES` (Laminar/DNS, RANS, LES/DES), fed by `TURBULENCE_MODELS` filtered by … · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/runStatusMeta.ts` : shared presentation of a `RunStatus` (label, lucide icon, spin, badge classes), used by the badge and the banner. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)
- `apps/web/src/features/solver/useRuns.ts` : TanStack Query hooks for the Solver tab. · [web-features-meshing-solver](codemap/web-features-meshing-solver.md)

## `apps/web/src/features/templates`

- `apps/web/src/features/templates/ApplyTemplateFlow.tsx` : three-step wizard opened after a case verification: choice, template selection, conflict resolution. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/templates/TemplateFilePicker.tsx` : "Add from template file" dialog: pick a template, then files to copy into the case (they overwrite files at the same path). · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/templates/TemplateFormDialog.tsx` : create / edit a template's metadata (name, tags, description); on create, choice of starting point: empty set or a single file entered inline. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/templates/schemas.test.ts` : `parseTagInput` (commas and line breaks, trim, empties removed, empty or `undefined` input); `templateFormSchema` requires a path for `kind: 'file'` and accepts an empty set without a path. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/templates/schemas.ts` : template form schema. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/templates/useTemplates.ts` : all TanStack hooks for templates and their application to a project. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/terminal`

- `apps/web/src/features/terminal/ProjectTerminalButton.tsx` : project header action that opens a terminal in a large dialog. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/terminal/TerminalView.tsx` : xterm.js terminal connected to the project shell over WebSocket. · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/features/visualize`

- `apps/web/src/features/visualize/AutoPatchDialog.tsx` : run `autoPatch <featureAngle> -overwrite` on the current target. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/EditPatchesDialog.tsx` : batch editing of the names and types of all patches, saved in a single request. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/MeshViewer.tsx` : viewer body: left panel (patch table, actions, backup) and three.js scene on the right, with all states (building, empty, error with retry, no WebGL). · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/PatchTable.test.tsx` : one row per patch with a formatted face count (`65,000`); click = `onSelect(name)`, re-click on the selected row = `onSelect(null)`; `aria-selected` true/false; no combobox and no `rename`/`show all` button (read-only ta … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/PatchTable.tsx` : read-only Name / Type / nFaces table, linked to the 3D selection. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/VisualizePanel.test.tsx` : default target = case (patch `caseInlet`, `getMeshManifest('p1')`, backup bar present); switching the target to source `src1` (`getMeshSourceManifest('p1', 'src1')`); backup bar hidden for a source; `Edit names` on a sou … · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/VisualizePanel.tsx` : tab body: owns the target and the mesh selector, renders `MeshViewer` remounted per target. · [web-features-platform](codemap/web-features-platform.md)
- `apps/web/src/features/visualize/useMesh.ts` : TanStack hooks for the case mesh for the viewer (the source hooks live elsewhere). · [web-features-platform](codemap/web-features-platform.md)

## `apps/web/src/lib`

- `apps/web/src/lib/utils.ts` : Exports `cn(...inputs: ClassValue[]): string` = `twMerge(clsx(inputs))`: class merging with Tailwind conflict resolution. · [web-core](codemap/web-core.md)

## `apps/web/src/lib/api`

- `apps/web/src/lib/api/auth.ts` : authentication endpoints. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/boundary.ts` : applies a boundary conditions preset to a project's `0/` fields. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/chamber.ts` : Chamber Creation endpoints (`/chamber/*`), builds shared by the team and indexed by parameter hash. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/chamberSaves.ts` : named, shared saves of the exact `POST /chamber/build` body. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/client.ts` : central `fetch` wrapper. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/config.ts` : Public server flags. Exports `ServerConfig` (`terminalEnabled: boolean`) and `getServerConfig()` (`GET /config`, no auth). · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/conversion.ts` : a project's CGNS sources and CGNS to OpenFOAM conversion (`/projects/:id/cgns`). · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/dashboard.ts` : Exports `getDashboard(): Promise<DashboardData>` (`GET /dashboard`, server metrics + the user's runs). · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/meshes.ts` : a project's multi-mesh library and merge pipeline (`/projects/:id/meshes`). · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/meshing.ts` : standalone Meshing sessions STL to snappyHexMesh/cfMesh to polyMesh (`/meshing/*`), shared by the team. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/projects.ts` : the largest module: projects, OpenFOAM case files, 3D viewer, CGNS export, template application, solver. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/templates.ts` : shared file templates (`/templates`); file responses reuse the case file types. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/types.ts` : typed contract of the `/api/v1` API consumed by the whole front end. · [web-core](codemap/web-core.md)
- `apps/web/src/lib/api/users.ts` : Account management (super-admin). · [web-core](codemap/web-core.md)

## `apps/web/src/pages`

- `apps/web/src/pages/AccountPage.tsx` : settings of the current account (route `/account`). · [web-core](codemap/web-core.md)
- `apps/web/src/pages/AdminPage.tsx` : account back office (`/admin`, `SUPER_ADMIN`). · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ChamberPage.tsx` : Chamber Creation tool (`/chamber`): input form, live computation of the 12 outputs, CadQuery generation, 3D preview, exports, send to Meshing, saves. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/HomePage.test.tsx` : rendering with data (greeting "Welcome back, Ada", CPU 42, solver `simpleFoam`, recent project, donut `role="img"` "4 total runs") and empty states ("no solver running", "no projects yet"). · [web-core](codemap/web-core.md)
- `apps/web/src/pages/HomePage.tsx` : `/` dashboard pinned to the viewport from `lg` up: KPI strip (CPU, memory, active solvers, total runs), panel of running solvers (can be stopped), outcomes donut, grid of recent projects. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/LoginPage.tsx` : `/login` sign-in screen: `bg-blueprint` background, `rounded-lg shadow-md` `max-w-[400px]` card, `BrandLockup`, email and password fields, full-width CTA. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/MeshingPage.tsx` : list and creation of meshing sessions (`/meshing`). · [web-core](codemap/web-core.md)
- `apps/web/src/pages/MeshingSessionPage.tsx` : session detail (`/meshing/:id`): surface management, engine configuration, background execution with live log, report, resulting mesh, download, deletion. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ProjectDetailPage.test.tsx` : disabling/enabling of the Visualize and Solver tabs depending on whether a polyMesh exists; opening a tab replaces the Detail body; `?view=visualize` opens Visualize at mount, an unknown `?view=` falls back to Detail. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ProjectDetailPage.tsx` : project detail (`/projects/:id`): header with terminal button and gear menu, then Detail / Visualize / Assemble / Solver / Export tabs. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ProjectEditPage.test.tsx` : file list and initially empty editor; content loaded on selection; debounced autosave (no Save button) calling `saveCaseFileContent('p1', 'system/controlDict', ...)`. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ProjectEditPage.tsx` : case file editor (`/projects/:id/edit`): thin wrapper that binds the project's file hooks to the shared `FileTreeEditor`. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/ProjectsPage.tsx` : creation and list of projects (`/projects`). · [web-core](codemap/web-core.md)
- `apps/web/src/pages/TemplateEditPage.tsx` : editing of a template's files (`/templates/:id/edit`), read-only if the user is neither the author nor a super-admin. · [web-core](codemap/web-core.md)
- `apps/web/src/pages/TemplatesPage.tsx` : list of shared templates (`/templates`) with search and tag filters. · [web-core](codemap/web-core.md)

## `apps/web/src/styles`

- `apps/web/src/styles/index.css` : global stylesheet: imports `tokens.css` then the three Tailwind layers. · [web-core](codemap/web-core.md)
- `apps/web/src/styles/tokens.css` : single source of design tokens (CSS variables on `:root`, light theme only). · [web-core](codemap/web-core.md)

## `apps/web/src/test`

- `apps/web/src/test/setup.ts` : global Vitest setup. · [web-core](codemap/web-core.md)

## `brain`

- `brain/README.md` : Brain: DIVE Turbinen project knowledge base : Shared memory of the agents (Claude Code, Codex…) and the developers.
- `brain/STATUS.md` : Current project state : Snapshot to read at the start of a session.
- `brain/decisions.md` : Decision log : Structural decisions, with their date and their reason.
- `brain/known-issues.md` : Known issues and debt : Living register of known bugs, environment limits and open threads.

## `brain/architecture`

- `brain/architecture/api-routes.md` : REST and WebSocket API routes : Sources: `apps/api/src/app.ts`, `apps/api/src/middleware/`, `apps/api/src/modules/*/*.routes.ts`, associated controllers and schemas, `apps/api/src/modules/projects/terminal.gateway.ts` · …
- `brain/architecture/configuration.md` : Configuration (environment variables) : Sources: `apps/api/src/config/env.ts`, `apps/api/.env.example`, `apps/api/vitest.config.ts`, `apps/web/.env.example`, `apps/web/src/lib/api/client.ts` …
- `brain/architecture/data-model.md` : Data model : Sources: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`, `apps/api/prisma/seed.ts`, services `auth`, `users`, `projects`, `templates`, `chamber-saves`, `dashboard`, `audit`, `meshing` …
- `brain/architecture/frontend.md` : Frontend architecture (`apps/web`) : Audience: AI agents modifying the DIVE Turbinen frontend.
- `brain/architecture/overview.md` : Architecture: overview : One-page system view.
- `brain/architecture/storage-layout.md` : Architecture: disk storage tree (`STORAGE_DIR`) : Sources: `apps/api/src/lib/*Storage.ts`, `fileTreeStorage.ts`, `commandRunner.ts`, `streamRunner.ts`, `openfoamCommand.ts`, `terminalSession.ts`, and the calling services …

## `brain/assets`

- `brain/assets/chamber-parameter-map.html` : standalone interactive mind map of the Chamber Creation parameters and their relations (deliverable of 2026-08-04, v2 model: without Gen Dim v3 or the recent geometric options). · [root-shared-mcp](codemap/root-shared-mcp.md)

## `brain/changelog`

- `brain/changelog/2026-06.md` : Changelog : juin 2026
- `brain/changelog/2026-07.md` : Changelog : juillet 2026 : Correctifs des bugs relevés dans `BUG_AUDIT.md`, branche `fix/bugs-v1.0.1` (partie de `main`/v1.0.0).
- `brain/changelog/2026-08.md` : Changelog : août 2026
- `brain/changelog/2026-09.md` : Changelog : septembre 2026
- `brain/changelog/README.md` : Changelog: rules : Log of EVERY change to the repository (code, scripts, config, structural docs).

## `brain/codemap`

- `brain/codemap/README.md` : Codemap: index : File-by-file description of ALL the git-tracked code (role, exports, dependencies, pitfalls).
- `brain/codemap/_FORMAT.md` : Codemap sheet format : Common template of every sheet in `brain/codemap/`.
- `brain/codemap/api-core.md` : Codemap: API core and cross-cutting modules : Scope: `apps/api/{package.json,tsconfig.json,vitest.config.ts,.env.example}`, `apps/api/prisma/`, `apps/api/src/{app.ts,server.ts}`, `apps/api/src/{config,middleware,types}/` …
- `brain/codemap/api-lib.md` : Codemap: API lib (cross-cutting helpers) : Scope: `apps/api/src/lib/` · Updated: 2026-09-28
- `brain/codemap/api-projects.md` : Codemap: API module projects : Scope: `apps/api/src/modules/projects/` · Updated: 2026-09-28
- `brain/codemap/api-scripts.md` : Codemap: API: Python scripts, assets, geometry tests, fixtures and reference documents : Scope: `apps/api/scripts/`, `apps/api/tests/fixtures/`, `documents/` · Updated: 2026-09-28
- `brain/codemap/api-tests.md` : Codemap: API tests (vitest + supertest) : Scope: `apps/api/tests/` (excluding `apps/api/tests/fixtures/`), `apps/api/vitest.config.ts` · Updated: 2026-09-28
- `brain/codemap/build-index.py` : generates `brain/INDEX.md` (one line per repository file) from the `**Role**` sections of the codemap sheets and the intro line of Markdown documents; `--check` exits with an error if a file is not documented. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `brain/codemap/root-shared-mcp.md` : Codemap: Root, shared contract and MCP server : Scope: `.github/workflows/ci.yml`, `apps/mcp/`, `packages/shared/`, root files (`.editorconfig`, `.gitattributes`, `.gitignore`, `.mcp.json`, `.nvmrc`, `.prettierrc.json` …
- `brain/codemap/web-core.md` : Codemap: web-core : Scope: `apps/web/` excluding `apps/web/src/features/` (configs, `public/`, `src/app`, `src/components`, `src/lib`, `src/pages`, `src/styles`, `src/test`, `src/main.tsx`, `src/App.tsx` …
- `brain/codemap/web-features-assemble-chamber.md` : Codemap: web features: assemble + chamber : Scope: `apps/web/src/features/assemble/`, `apps/web/src/features/chamber/` · Updated: 2026-09-28
- `brain/codemap/web-features-meshing-solver.md` : Codemap: Web: meshing + solver features : Scope: `apps/web/src/features/meshing/`, `apps/web/src/features/solver/` · Updated: 2026-09-28
- `brain/codemap/web-features-platform.md` : Codemap: web features (platform) : Scope: `apps/web/src/features/{account,admin,auth,dashboard,export,files,templates,terminal,visualize}/` · Updated: 2026-09-28
- `brain/codemap/web-features-projects.md` : Codemap: web / features / projects : Scope: `apps/web/src/features/projects/` · Updated: 2026-09-28

## `brain/conventions`

- `brain/conventions/code-style.md` : Code style and patterns : Patterns actually used in the code (surveyed across the whole repository on 2026-09-28).
- `brain/conventions/frontend.md` : Frontend and design conventions : Mandatory rules for creating or changing any UI (JSX, CSS, Tailwind).
- `brain/conventions/testing.md` : Testing conventions : Operational guide for an agent that adds, modifies or runs tests in the DIVE Turbinen monorepo.
- `brain/conventions/vocabulary.md` : Vocabulary and naming rules : Glossary of the domain (CFD, OpenFOAM, turbines) and of the application's concepts, plus the naming rules validated by the user.
- `brain/conventions/workflow.md` : Workflow : How an agent carries a task end to end in this repository.

## `brain/design`

- `brain/design/design-system.md` : Design system · DIVE Turbinen (visual + component contract) : Single source of truth for the look & feel of the app.
- `brain/design/product.md` : Product : Product positioning (formerly `PRODUCT.md` at the repo root, moved 2026-09-28).

## `brain/features`

- `brain/features/README.md` : Features: index : One sheet per feature, end to end (UI → API → services → tools → storage).
- `brain/features/_FORMAT.md` : Feature sheet format : One sheet per feature, seen end to end (user → UI → API → services → external tools → storage).
- `brain/features/admin-and-audit.md` : Feature · Account back office and audit log
- `brain/features/auth-and-accounts.md` : Feature · Authentication and self-service account
- `brain/features/boundary-conditions.md` : Feature · Boundary conditions (DIVE presets per object type)
- `brain/features/case-files.md` : Feature · Case files (OpenFOAM case files)
- `brain/features/chamber-creation.md` : Feature · Chamber Creation
- `brain/features/dashboard.md` : Feature · Dashboard (Home "command center")
- `brain/features/export-cfdpost.md` : Feature · CFD-Post export (OpenFOAM to CGNS)
- `brain/features/mcp-server.md` : Feature · MCP server (`apps/mcp`)
- `brain/features/merge-and-assembly.md` : Feature · Merge and multi-part assembly
- `brain/features/mesh-library-and-conversion.md` : Feature · Mesh library, conversion and 3D viewer
- `brain/features/meshing.md` : Feature · Meshing (snappyHexMesh / cfMesh)
- `brain/features/projects.md` : Feature · Projects (creation, list, detail, collaborators)
- `brain/features/solver-and-runs.md` : Feature · Solver and runs
- `brain/features/templates.md` : Feature · Templates (reusable case file sets)
- `brain/features/terminal.md` : Feature · Project terminal (WebSocket shell)

## `brain/operations`

- `brain/operations/installation.md` : Task sheet — Install, run and update DIVE Turbinen (WSL / Ubuntu, root user) : Copy the commands line by line into your WSL or Ubuntu terminal, in order.

## `brain/plans`

- `brain/plans/2026-08-03-guide-vane-throat.md` : Guide-vane throat Implementation Plan
- `brain/plans/2026-08-06-outlet-x1-ratio.md` : Guide-vane outlet — X1-driven diameter + configurable ratio — Implementation Plan
- `brain/plans/2026-08-10-hub-shroud-x1-adaptation.md` : Hub & Shroud X1-Driven Parametric Reshaping — Implementation Plan
- `brain/plans/2026-08-11-chamber-to-meshing-transfer.md` : Chamber → Meshing Transfer + Session Copy Implementation Plan
- `brain/plans/2026-08-11-chamfer-disable-toggle.md` : Chamber Creation — Chamfer Disable Toggle Implementation Plan
- `brain/plans/2026-08-11-per-patch-feature-edges.md` : Per-Patch Feature-Edge Extraction Implementation Plan
- `brain/plans/2026-08-11-per-patch-layers.md` : Per-Patch Boundary Layers Implementation Plan
- `brain/plans/2026-08-11-per-patch-toggles.md` : Per-Patch Override Toggles Implementation Plan
- `brain/plans/2026-08-11-stepped-last-cylinder-through-top.md` : Stepped Last Cylinder Through Box Top — Implementation Plan
- `brain/plans/2026-08-13-guide-vane-step-export.md` : Guide-Vane STEP Export Implementation Plan
- `brain/plans/2026-08-17-cfmesh-per-patch-refinement-and-layers.md` : cfMesh Per-Patch Local Refinement + Tri-State Inflation Layers Implementation Plan : Note: verify `cta-hover` is a defined token in this repo's Tailwind config; if not, reuse the same hover class the form's other accent …
- `brain/plans/2026-09-02-generator-dimensions.md` : Empirical Generator Dimensions (Gen Dim v3) Implementation Plan

## `brain/playbooks`

- `brain/playbooks/README.md` : Playbooks: index : Step-by-step recipes for the routine changes of this codebase.
- `brain/playbooks/add-api-endpoint.md` : Playbook: Add an API endpoint : When to use: a new REST route in an existing module, or a brand new module under `apps/api/src/modules/` · Related: `brain/architecture/api-routes.md`, `brain/conventions/code-style.md` §3 …
- `brain/playbooks/add-chamber-input-or-parameter.md` : Playbook: Add a chamber input, option or derived parameter : When to use: a new field on the Chamber Creation form (empirical input, geometry option or flag, manual override of a derived dimension), a new derived output …
- `brain/playbooks/add-env-var.md` : Playbook: Add an environment variable : When to use: a new setting for the API (binary path, timeout, limit, feature flag), the web bundle (`VITE_*`) or the MCP server · Related: `brain/architecture/configuration.md` …
- `brain/playbooks/add-prisma-migration.md` : Playbook: Add a Prisma migration : When to use: any change to `apps/api/prisma/schema.prisma` (new model, new column, new index, relation change) · Related: `brain/architecture/data-model.md`, `brain/codemap/api-core.md` …
- `brain/playbooks/add-solver-or-turbulence-model.md` : Playbook: Add a solver or a turbulence model : When to use: offer a new ESI OpenFOAM v2406 solver binary in the Solver tab, change how a solver is scaffolded, or add a turbulence model to the setup wizard · Related …
- `brain/playbooks/add-web-page-or-tab.md` : Playbook: Add a web page, a navigation entry or a project-detail tab : When to use: a new route under the authenticated shell, a sidebar destination, or a new tab on `/projects/:id` · Related …
- `brain/playbooks/change-chamber-geometry.md` : Playbook: Change the chamber geometry (`buildChamber.py`) : When to use: any edit to `apps/api/scripts/buildChamber.py`, its constants or its assets (`apps/api/scripts/assets/`), or `mirrorStep.py`: shapes, patch classif …
- `brain/playbooks/deploy-and-update.md` : Playbook: Deploy and update the production server : When to use: shipping a new version of `main` to the Debian 12 server (app in `/home/app`, service `dive-api`, nginx), or rolling one back · Related …
- `brain/playbooks/integrate-external-tool.md` : Playbook: Integrate an external tool (OpenFOAM utility or bundled Python script) : When to use: the API must run an OpenFOAM utility, ParaView `pvbatch`, or a Python script from `apps/api/scripts/` · Related …

## `brain/specs`

- `brain/specs/2026-08-03-guide-vane-throat-design.md` : Guide-vane throat — design
- `brain/specs/2026-08-06-outlet-x1-ratio-design.md` : Guide-vane outlet — X1-driven diameter + configurable inner/outer ratio — design
- `brain/specs/2026-08-10-hub-shroud-x1-adaptation-design.md` : Guide-vane hub & shroud — X1-driven parametric reshaping — design
- `brain/specs/2026-08-11-chamber-to-meshing-transfer-design.md` : Chamber → Meshing transfer + session copy — design
- `brain/specs/2026-08-11-chamfer-disable-toggle-design.md` : Chamber Creation — chamfer disable toggle — design
- `brain/specs/2026-08-11-per-patch-feature-edges-design.md` : Per-Patch Feature-Edge Extraction — Design Spec
- `brain/specs/2026-08-11-per-patch-layers-design.md` : Per-Patch Boundary Layers — Design Spec
- `brain/specs/2026-08-11-per-patch-toggles-design.md` : Per-Patch Override Toggles — Design Spec
- `brain/specs/2026-08-11-stepped-last-cylinder-through-top-design.md` : Stepped chamber — last cylinder extends through the box top — design
- `brain/specs/2026-08-13-guide-vane-step-export-design.md` : Guide-Vane STEP Export — Design
- `brain/specs/2026-08-17-cfmesh-per-patch-refinement-and-layers-design.md` : cfMesh Per-Patch Local Refinement + Tri-State Inflation Layers — Design Spec
- `brain/specs/2026-08-31-chamber-fullwidth-and-saved-builds-design.md` : Chamber Creation: full-width layout + saved builds — design
- `brain/specs/2026-08-31-part-fit-refusals-design.md` : Part-fit refusals: width overflow error + hollow height refusal — design
- `brain/specs/2026-08-31-vane-te-rounding-design.md` : Guide-vane trailing-edge rounding — design
- `brain/specs/2026-09-01-chamber-cache-integrity-design.md` : Chamber build-cache integrity: atomic writes + per-hash lock — design
- `brain/specs/2026-09-01-chamber-input-floors-design.md` : Chamber input floors + distributor fit bound — design
- `brain/specs/2026-09-01-chamber-minor-polish-design.md` : Chamber minor polish: saves robustness, a11y, export nits — design
- `brain/specs/2026-09-01-chamber-ux-consistency-design.md` : Chamber UX consistency: fallback warning, stale state, snap visibility, min>max — design
- `brain/specs/2026-09-01-deferred-vane-step-design.md` : Deferred guide-vane STEP export — design
- `brain/specs/2026-09-01-empirical-50mm-rounding-design.md` : 50 mm rounding of empirical chamber dimensions — design
- `brain/specs/2026-09-01-mirrored-step-download-design.md` : Mirrored STEP download ("Change rotational direction") — design
- `brain/specs/2026-09-02-chamber-vocabulary-design.md` : Chamber vocabulary sweep (display copy only) — design
- `brain/specs/2026-09-02-generator-dimensions-design.md` : Empirical generator dimensions (Gen Dim v3) — design
- `brain/specs/2026-09-02-physical-input-names-design.md` : Physical names for X1–X4 (display only) — design
- `brain/specs/2026-09-02-simplify-generator-design.md` : "Simplify Generator" option (hollow variant) — design
- `brain/specs/2026-09-29-cone-chamfer-design.md` : Cone chamfer (With cone) — design : Area: shared, backend, python (`apps/api/scripts/buildChamber.py`), frontend, tests
- `brain/specs/2026-09-29-guide-vane-count-design.md` : Guide vane count (16 or 18) — design : Area: shared, backend, python (`apps/api/scripts/buildChamber.py`), frontend, tests
- `brain/specs/2026-09-29-meshing-to-project-design.md` : Meshing session → project mesh transfer (WS-F) — design
- `brain/specs/2026-09-29-optimisation-loop-design.md` : Chamber optimisation loop (WS-H) — design
- `brain/specs/2026-09-29-semi-spiral-casing-design.md` : Semi-spiral casing option (Chamber Creation) — design
- `brain/specs/2026-09-29-vane-pocket-runner-case-design.md` : Guide-vane pocket robust to Runner case Ø close to or below LE Ø : Area: python (`apps/api/scripts/buildChamber.py`), shared + API (early refusal), tests

## `documents`

- `documents/Gen Dim v3 Only Calculator (standalone).xlsx` : Workbook (not opened here) described as the "source of record" of the Gen Dim v3 empirical model of the generator dimensions (hollow variant): auto X4 = 0.9·9.81·X2·X3, frame code R by range rules, length code L, Ø by ca … · [api-scripts](codemap/api-scripts.md)
- `documents/dynamicMeshDict.forcedRotation` : OpenFOAM.org v12 template: `solidBodyMotionFvMesh`, `cellZone innerAMI`, `rotatingMotion` origin (0.1 .025 0), z axis, ω 2.14 rad/s. · [api-scripts](codemap/api-scripts.md)
- `documents/dynamicMeshDict.notforced` : ESI v2412 template: `dynamicMotionSolverFvMesh` + `sixDoFRigidBodyMotion` on the `kaplan` patch (mass, inertia, rotation only around y, `sphericalAngularDamper` damper, Newmark solver). · [api-scripts](codemap/api-scripts.md)

## `documents/Semi-spiral-creation`

- `documents/Semi-spiral-creation/SEMI_SPIRAL_TOOL_SPEC.md` : Approved specification of a tool (not yet implemented in the app): 7 inputs (`Q`, `c_flow`, `H_ch`, `D_LE`, `clearance`, `max_width`, `phi_start`) to a JSON geometric object (6 spiral segments + 3 nose segments) in a "mi … · [api-scripts](codemap/api-scripts.md)
- `documents/Semi-spiral-creation/reference_semi_spiral.py` : Reference implementation: `design_semi_spiral(Q, c_flow, H_ch, D_LE, clearance, max_width, phi_start, seed=5)` returns a dict compliant with §7; helpers `derived`, `to_frame`, `ray_distances`. · [api-scripts](codemap/api-scripts.md)

## `documents/calculator`

- `documents/calculator/turbulence_cfd_notes.md` : Notes (FR/EN) on k, ε, ω: Re, I, k = 1.5·(U·I)², L = 0.07·D_h, ω and ε. · [api-scripts](codemap/api-scripts.md)

## `documents/old`

- `documents/old/1_turbine_fullMachine_BCs_1.txt` : Full turbine BC template (simpleFoam + MRF, kOmegaSST): total pressure at the inlet, static pressure at the outlet (single anchor), MRF walls. · [api-scripts](codemap/api-scripts.md)
- `documents/old/2_pipe_BCs_1.txt` : Pipe BC template: variant A imposed flow rate, variant B imposed pressure. · [api-scripts](codemap/api-scripts.md)
- `documents/old/3_draftTube_csvInlet_BCs_1.txt` : Draft tube template: `timeVaryingMappedFixedValue` inlet fed by `csv_to_boundaryData.py`, `fixedMeanValue` outlet. · [api-scripts](codemap/api-scripts.md)
- `documents/old/4_turbineChamber_BCs.txt` : Chamber template (spiral + stay vanes + guide vanes, no rotation): imposed Q or imposed pressure variant, patches `inlet/outlet/casing/stayVanes/guideVanes`. · [api-scripts](codemap/api-scripts.md)
- `documents/old/csv_to_boundaryData.py` : Identical copy of `apps/api/scripts/csv_to_boundaryData.py`. · [api-scripts](codemap/api-scripts.md)

## `packages/shared`

- `packages/shared/AGENTS.md` : Zone rules: `packages/shared` (`@dive/shared` contract) : Loaded automatically when working in `packages/shared/`.
- `packages/shared/CLAUDE.md` : Claude Code zone rules: `packages/shared` : Imports the zone rules below (shared with Codex and other agents through `packages/shared/AGENTS.md`).
- `packages/shared/package.json` : Package `@dive/shared` v0.1.0, dual build: CJS (`dist/cjs`, with `.d.ts` declarations) and ESM (`dist/esm`). · [root-shared-mcp](codemap/root-shared-mcp.md)
- `packages/shared/tsconfig.esm.json` : Extends the base; `module: ES2022`, `moduleResolution: node`, `declaration: false`, `outDir: dist/esm`, `rootDir: src`. · [root-shared-mcp](codemap/root-shared-mcp.md)
- `packages/shared/tsconfig.json` : Extends the base; `module: CommonJS`, `moduleResolution: node`, `declaration: true`, `outDir: dist/cjs`, `rootDir: src`. · [root-shared-mcp](codemap/root-shared-mcp.md)

## `packages/shared/src`

- `packages/shared/src/index.ts` : shared API/web contract. · [root-shared-mcp](codemap/root-shared-mcp.md)
