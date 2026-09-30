# Configuration (environment variables)

> Sources: `apps/api/src/config/env.ts`, `apps/api/.env.example`, `apps/api/vitest.config.ts`, `apps/web/.env.example`, `apps/web/src/lib/api/client.ts`, `apps/web/src/features/terminal/TerminalView.tsx`, `apps/mcp/.env.example`, `apps/mcp/src/config.ts`, `.github/workflows/ci.yml` · Updated: 2026-09-28

## Principles
- **API**: `src/config/env.ts` loads `apps/api/.env` (`dotenv/config`, which never overwrites an already defined variable), validates 71 variables with zod and exports a frozen `env` object. Any missing or malformed variable makes the import fail with the list of issues. Numbers are coerced (`z.coerce.number()`), booleans are the strings `'true' | 'false'`.
- **Production** (`NODE_ENV=production`): `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be at least 32 characters long, differ from each other and not equal the placeholders (`dev-access-secret-change-me`, `dev-refresh-secret-change-me`, `ChangeMe!2026`); `SEED_ADMIN_PASSWORD` must not equal `ChangeMe!2026`.
- **Empty script paths**: an empty `*_SCRIPT` variable designates the script shipped in `apps/api/scripts/`, resolved relative to the module (independent of the current directory).
- **Missing binaries** (Windows machine): each pipeline step reports a clean "not found" instead of crashing the request.
- **Web**: only `VITE_*` variables are exposed, and they are frozen into the bundle at build time.
- **MCP**: `apps/mcp/.env` loaded by `src/config.ts` (path resolved from the file).

"Example" column: value from `apps/api/.env.example`; "absent" means the variable does not appear there.

## API: server, security and authentication

| Variable | `env.ts` default | Example | Role | Constraints / notes | Read by |
|----------|-----------------|---------|------|---------------------|--------|
| `NODE_ENV` | `development` | `development` | Execution mode. | `development`, `test` or `production`. In production: `Secure` refresh cookie, secret checks. `rateLimit.ts` reads `process.env.NODE_ENV` directly (limit 1000 in `test`). | `auth.cookies`, `rateLimit` |
| `PORT` | `4000` | `4000` | HTTP listening port (and terminal WebSocket). | Positive integer. | `server.ts` |
| `CORS_ORIGIN` | `http://localhost:5173` | same | Single allowed origin (CORS with credentials); also the origin required for the terminal WebSocket upgrade. | Valid URL, a single origin. | `app.ts`, `terminal.gateway` |
| `TRUST_PROXY` | `0` | `0` | Number of trusted proxies (`app.set('trust proxy')`). | Integer ≥ 0; set `1` behind a reverse proxy, otherwise the login rate limit sees the proxy IP. | `app.ts` |
| `JWT_ACCESS_SECRET` | required | `dev-access-secret-change-me` | Access token signing secret. | Production: ≥ 32 characters, different from the refresh one, not a placeholder. | `lib/jwt` |
| `JWT_REFRESH_SECRET` | required | `dev-refresh-secret-change-me` | Refresh token secret. | Same. | `lib/jwt` |
| `ACCESS_TOKEN_TTL` | `15m` | `15m` | Access token lifetime (jsonwebtoken `expiresIn` format). | Non-empty string. The MCP and the web app assume 15 minutes (re-login / refresh on 401). | `lib/jwt` |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | `7` | Refresh token and cookie lifetime, in days. | Positive integer. | `lib/jwt`, `auth.cookies` |

## API: database and seed

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `DATABASE_URL` | required | `file:./dev.db` | Prisma SQLite URL, relative to the `prisma/` folder. | Non-empty. Read by Prisma (`schema.prisma`), not via `env.X`. Tests: `file:./test.db`. | Prisma |
| `SEED_ADMIN_EMAIL` | required | `admin@dive-turbinen.de` | Email of the protected super-admin. | Valid email. **Required even to start the server**, not only for the seed. | `prisma/seed.ts` |
| `SEED_ADMIN_PASSWORD` | required | `ChangeMe!2026` | Super-admin password, reapplied on every seed. | Production: not the placeholder. | `prisma/seed.ts` |
| `SEED_ADMIN_NAME` | required | `Super Admin` | Super-admin display name. | Non-empty. | `prisma/seed.ts` |

## API: storage and uploads

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `STORAGE_DIR` | `./storage` | `./storage` | Root of all disk storage (projects, templates, meshing, chamber), relative to the API working directory. | Tests: `./test-storage`. Ignored by git. | `lib/fileTreeStorage` |
| `MAX_UPLOAD_MB` | `1024` | `1024` | Max size of a multipart file. | Files are buffered in memory. Exceeded: 413 `PAYLOAD_TOO_LARGE`. | `files.controller` (`parseCaseUpload`), `boundary.controller` |
| `MAX_UPLOAD_TOTAL_MB` | `2048` | absent | Cap on the full multipart body, checked on `Content-Length` before buffering. | 413 `PAYLOAD_TOO_LARGE`. A chunked upload without `Content-Length` is bounded only by multer. | `files.controller` |
| `MAX_ARCHIVE_UNCOMPRESSED_MB` | `2048` | absent | Maximum total uncompressed size of a zip (zip bomb protection). | Checked on the archive's declared sizes. | `lib/fileTreeStorage` |

## API: common OpenFOAM environment

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `OPENFOAM_BASHRC` | `''` | `''` | Path to an OpenFOAM `etc/bashrc`; if set, the tools run in `bash -c 'source <bashrc> && exec "$@"'`. | Empty if the tools are already on the PATH. Examples: `/usr/lib/openfoam/openfoam2406/etc/bashrc` (ESI). Also passed to the terminal shell, without automatic sourcing. | `lib/openfoamCommand`, `terminal.gateway` |
| `CHECK_MESH_BIN` | `checkMesh` | `checkMesh` | Mesh quality check. | | conversion, import, snappy, cfMesh, merge, export |
| `CONVERSION_STEP_TIMEOUT_MS` | `600000` | `600000` | Timeout per conversion step and for several one-off OpenFOAM commands. | Positive integer. | conversion, `lib/meshImport`, mesh, meshes, export |

## API: CGNS / mesh file import and auto-patch

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `CGNS_PYTHON_BIN` | `python3` | `python3` | Interpreter of the CGNS to VTK script. | Must be a Python with the `vtk` wheel, **not** `pvpython` (VTK conflict, segfault). | conversion, `lib/meshImport` |
| `CGNS_TO_VTK_SCRIPT` | `''` | `''` | Path to `CgnsToVtk.py`. | Empty: shipped script. Tests: stub `./tests/fixtures/CgnsToVtk.py`. | conversion, `lib/meshImport` |
| `VTK_TO_FOAM_BIN` | `vtkUnstructuredToFoam` | same | VTK to `constant/polyMesh`. | | conversion, `lib/meshImport` |
| `FLUENT_TO_FOAM_BIN` | `fluent3DMeshToFoam` | same | Import of a Fluent/Ansys `.msh`. | Replace with `gmshToFoam` for a Gmsh mesh. | `lib/meshImport` |
| `FLUENT_TO_FOAM_SCALE` | `''` | `''` | Adds `-scale <f>` (e.g. `0.001` for mm to m). | Empty: no scaling. | `lib/meshImport` |
| `AUTO_PATCH_BIN` | `autoPatch` | `autoPatch` | Splits the external boundary into patches by angle. | | mesh, meshes |

## API: 3D visualization and draft tube BC

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `MESH_PYTHON_BIN` | `python` (Windows) / `python3` | `python3` | Interpreter of `extractPatches.py` (PyVista/trimesh), of the export's CGNS reread and of `csv_to_boundaryData.py`. | Platform-dependent default. | mesh, meshes, meshing, export, `lib/boundaryData` |
| `EXTRACT_PATCHES_SCRIPT` | `''` | `''` | Patch extractor (GLB + manifest + edges). | Tests: stub. Missing: 500 `SCRIPT_MISSING`. | mesh, meshes, meshing |
| `MESH_BUILD_TIMEOUT_MS` | `600000` | `600000` | Timeout of a render extraction. | | mesh, meshes, meshing |
| `CSV_TO_BOUNDARY_DATA_SCRIPT` | `''` | `''` | CSV to `constant/boundaryData` conversion (draft tube inlet profile). | Pure Python, runs under `MESH_PYTHON_BIN`. | `lib/boundaryData` |
| `CSV_TO_BOUNDARY_TIMEOUT_MS` | `600000` | `600000` | Timeout of this conversion. | | `lib/boundaryData` |

## API: multi-mesh assembly (merge)

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `MERGE_MESHES_BIN` | `mergeMeshes` | same | Combines the sources into a master mesh. | | meshes |
| `STITCH_MESH_BIN` | `stitchMesh` | same | Conformal merge of a patch pair. | | meshes |
| `SPLIT_MESH_REGIONS_BIN` | `splitMeshRegions` | same | One cellZone per part (`-makeCellZones -overwrite`). | | meshes |
| `MERGE_STEP_TIMEOUT_MS` | `600000` | `600000` | Timeout per merge step. | | meshes |
| `STITCH_TOL` | `''` | `''` | stitchMesh `-tol` tolerance. | **Never read**: ESI has no `-tol` option (comment in `meshes.service`). | none |
| `NCC_COUPLE_BIN` | `createNonConformalCouples` | same | OpenFOAM.org v12 non-conformal coupling utility. | **Never read**: the current coupling retypes patches as cyclicAMI through text editing. `env.ts` and `.env.example` comments are obsolete. | none |

## API: meshing sessions (snappyHexMesh and cfMesh)

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `BLOCK_MESH_BIN` | `blockMesh` | absent | Background mesh. | | `lib/snappyPipeline` |
| `SURFACE_FEATURE_BIN` | `surfaceFeatureExtract` | absent | Sharp edge extraction (`surfaceFeatureExtractDict`). | Switching to `surfaceFeatures` also requires changing the generated dictionary. | `lib/snappyPipeline` |
| `SNAPPY_HEX_MESH_BIN` | `snappyHexMesh` | absent | snappy mesher. | | `lib/snappyPipeline` |
| `SNAPPY_STEP_TIMEOUT_MS` | `1800000` | absent | Timeout per snappy step (30 min). | | `lib/snappyPipeline` |
| `DECOMPOSE_PAR_BIN` | `decomposePar` | same | Decomposition for parallel snappy. | | `lib/snappyPipeline` |
| `RECONSTRUCT_PAR_MESH_BIN` | `reconstructParMesh` | same | Mesh reconstruction after parallel snappy. | | `lib/snappyPipeline` |
| `CARTESIAN_MESH_BIN` | `cartesianMesh` | same | cfMesh mesher (OpenMP, cores passed as `OMP_NUM_THREADS`). | | `lib/cfMeshPipeline` |
| `SURFACE_FEATURE_EDGES_BIN` | `surfaceFeatureEdges` | same | Edge extraction to FMS for cfMesh. | | `lib/cfMeshPipeline` |
| `CFMESH_STEP_TIMEOUT_MS` | `1800000` | `1800000` | Timeout per cfMesh step. | | `lib/cfMeshPipeline` |

snappy parallelism reuses `MPI_BIN`, `MPI_RUN_FLAGS`, `DECOMPOSE_METHOD` and `SOLVER_TOTAL_CORES` (runs section). The meshing log is read with the `SOLVER_LOG_MAX_BYTES` cap and stopping uses `RUN_STOP_GRACE_MS`.

## API: chamber generation

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `CHAMBER_PYTHON_BIN` | `python` (Windows) / `python3` | absent | Interpreter of `buildChamber.py` and `mirrorStep.py` (CadQuery + trimesh). | Must be a venv separate from the `MESH_PYTHON_BIN` one. Missing: 502 `CHAMBER_BUILD_FAILED`. | chamber |
| `BUILD_CHAMBER_SCRIPT` | `''` | absent | Builder path. | Missing on disk: 500 `SCRIPT_MISSING`. | chamber |
| `MIRROR_STEP_SCRIPT` | `''` | absent | Path of the mirrored STEP generator. | | chamber |
| `CHAMBER_BUILD_TIMEOUT_MS` | `600000` | absent | Timeout of a build, a STEP generation or a mirror. | | chamber |
| `LIDKIT_PYTHON_BIN` | `''` (= the `CHAMBER_PYTHON_BIN` value) | `""` | Interpreter of the vendored lid iteration kit (`scripts/lidkit/*.py`: numpy + scipy + shapely, matplotlib optional for figures). | since 2026-09-30 | free surface |
| `LIDKIT_TIMEOUT_MS` | `900000` | `900000` | Timeout of one kit step of a free-surface job (lid export `postProcess`, surface, fit, figure). | since 2026-09-30 | free surface |
| `OPTIM_PYTHON_BIN` | `''` (= the `MESH_PYTHON_BIN` value) | `""` | Interpreter of `scripts/optimiseSuggest.py` (needs `optuna` ≥ 3.0). | Missing optuna: the study fails with the script's `KO:` message. Since 2026-09-30 (WS-H). | optimisation |
| `OPTIMISE_SUGGEST_SCRIPT` | `''` (bundled script) | `""` | Path of the suggestion script. | Since 2026-09-30 (WS-H). | optimisation |
| `OPTIM_SUGGEST_TIMEOUT_MS` | `60000` | `60000` | Timeout of one design suggestion. | Since 2026-09-30 (WS-H). | optimisation |
| `CHAMBER_SPIRAL_TIMEOUT_MS` | `300000` | `300000` | Timeout of one semi-spiral casing optimisation (`designSemiSpiral.py`, 30 to 90 s, same interpreter as the builder); a timeout is a 502 `CHAMBER_BUILD_FAILED` naming the variable. | since 2026-09-29 | chamber |

## API: CFD-Post export (OpenFOAM to CGNS)

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `PVBATCH_BIN` | `pvbatch` | same | ParaView in batch mode (the only one able to write CGNS). | | export |
| `PVBATCH_XVFB` | `true` | `true` | Runs `xvfb-run -a pvbatch` (virtual display). | `true`/`false`; `true` requires `apt install xvfb`; `false` uses `--force-offscreen-rendering`. | export |
| `PVBATCH_PYTHONPATH` | `''` | `''` | Prepended to pvbatch's `PYTHONPATH` so that ParaView's VTK wins over a pip wheel. | Empty: `PYTHONPATH` unchanged. | export |
| `FOAM_TO_CGNS_SCRIPT` | `''` | `''` | Conversion script `FoamToCgns.py`. | | export |
| `CGNS_INSPECT_SCRIPT` | `''` | `''` | Reread script `CgnsInspect.py`. | | export |
| `EXPORT_ALL_TIMES` | `true` | `true` | Exports the whole time series (zipped) or only the last time. | `true`/`false`. | export |
| `FOAM_DICTIONARY_BIN` | `foamDictionary` | same | Documented for the inspect step. | **Never read** via `env`. | none |
| `POST_PROCESS_BIN` | `postProcess` | same | Documented for validation reference values. | **Never read** via `env`. | none |

## API: solver runs and MPI

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `SOLVER_BIN` | `simpleFoam` | same | Fallback solver; the run normally reads `application` in `controlDict`. | | runs |
| `SOLVER_MAX_RUNTIME_MS` | `21600000` | same | Maximum duration of a run (6 h), the process is killed beyond it. | | runs |
| `SOLVER_MAX_CONCURRENT_RUNS` | `1` | `1` | Simultaneous runs per project. | Beyond: 409 `RUN_IN_PROGRESS`. | runs |
| `SOLVER_LOG_MAX_BYTES` | `33554432` | same | Cap on `solver.log` (32 MB); also the read cap of the meshing log. | | runs, meshing |
| `RUN_STOP_GRACE_MS` | `30000` | `30000` | Delay between the graceful stop (`stopAt writeNow`) and SIGTERM/SIGKILL. | Tests: `50`. Reused when stopping meshing runs. | runs, meshing |
| `MPI_BIN` | `mpirun` | same | MPI launcher. | | runs, `lib/snappyPipeline` |
| `MPI_RUN_FLAGS` | `--allow-run-as-root --use-hwthread-cpus --oversubscribe` | same | Options placed before `-np N`. | OpenMPI-specific. | runs, `lib/snappyPipeline` |
| `DECOMPOSE_METHOD` | `scotch` | same | `decomposeParDict` method. | `hierarchical` or `simple` if scotch is missing (coefficients generated). | runs, `lib/snappyPipeline` |
| `SOLVER_TOTAL_CORES` | `0` | `0` | Global core budget, across all projects (0 = number of logical cores). | Exceeded: 409 `NOT_ENOUGH_CORES`. Also the cap offered by the Meshing page. Tests: `8`. | `lib/cores`, files |
| `SOLVER_DECOMPOSE_TIMEOUT_MS` | `1800000` | absent | Timeout of `decomposePar` / `reconstructPar` for a parallel run. | | runs |
| `POSTPROCESS_TIMEOUT_MS` | `1800000` | `1800000` | Timeout of the on-demand vortex metrics (`postProcess -func diveVortexMetrics -latestTime`, compiles the coded function object on first use). | Beyond: 502 `POSTPROCESS_FAILED`. Added 2026-09-30 (WS-G). | criteria |

## API: project terminal

| Variable | Default | Example | Role | Constraints / notes | Read by |
|----------|--------|---------|------|---------------------|--------|
| `TERMINAL_ENABLED` | `false` | `false` | Enables the WebSocket shell `/api/v1/projects/:id/terminal` and the web Terminal button (via `GET /api/v1/config`). | `true`/`false`. Runs a real shell as the API's OS user: reserve for a trusted single-tenant server; every project collaborator has access to it. | `app.ts`, `terminal.gateway` |
| `TERMINAL_SHELL` | `''` | `''` | Shell launched. | Empty: `bash -i` (Linux/macOS) or `powershell.exe` (Windows). | `lib/terminalSession` |
| `TERMINAL_IDLE_TIMEOUT_MS` | `900000` | same | Inactivity before closing (15 min). | | `terminal.gateway` |
| `TERMINAL_MAX_SESSIONS` | `20` | `20` | Simultaneous sessions across the whole server. | Beyond: upgrade refused with 503. | `terminal.gateway` |

## Web (`apps/web/.env.example`)

| Variable | Default | Role | Constraints / notes | Read by |
|----------|--------|------|---------------------|--------|
| `VITE_API_URL` | none (example: `http://localhost:4000/api/v1`) | API base, `/api/v1` prefix included; also used to build the terminal WebSocket URL. | Required: the client throws an explicit error on the first request if it is missing. Frozen at build time (CI sets `http://localhost:4000/api/v1`; the real value is set per deployment). | `src/lib/api/client.ts`, `src/features/terminal/TerminalView.tsx` |

The Vite dev port (5173) is set in `vite.config.ts`, not by a variable; it must match `CORS_ORIGIN` on the API side.

## MCP server (`apps/mcp/.env.example`)

| Variable | Default | Role | Constraints / notes | Read by |
|----------|--------|------|---------------------|--------|
| `DIVE_API_URL` | required (example: `http://192.168.5.51/api/v1`) | API base, `/api/v1` included; trailing slash removed. | `http://localhost:4000/api/v1` in local dev. | `src/config.ts` |
| `DIVE_MCP_EMAIL` | required | Service account email. | Dedicated account; `SUPER_ADMIN` only if `list_users` is needed. | `src/config.ts` |
| `DIVE_MCP_PASSWORD` | required | Service account password. | Never commit `.env`. | `src/config.ts` |
| `DIVE_MCP_TIMEOUT_MS` | `60000` | Timeout per HTTP request. | Positive integer; increase for long conversions (merge, export, conversion are synchronous on the API side). | `src/config.ts` |

## Test overrides (`apps/api/vitest.config.ts`)
`NODE_ENV=test`, `DATABASE_URL=file:./test.db`, `JWT_ACCESS_SECRET=test-access-secret`, `JWT_REFRESH_SECRET=test-refresh-secret`, `ACCESS_TOKEN_TTL=15m`, `REFRESH_TOKEN_TTL_DAYS=7`, `CORS_ORIGIN=http://localhost:5173`, `STORAGE_DIR=./test-storage`, `CGNS_TO_VTK_SCRIPT=./tests/fixtures/CgnsToVtk.py`, `EXTRACT_PATCHES_SCRIPT=./tests/fixtures/extractPatches.py`, `RUN_STOP_GRACE_MS=50`, `SOLVER_TOTAL_CORES=8`, `SEED_ADMIN_EMAIL=admin@dive-turbinen.test`, `SEED_ADMIN_PASSWORD=TestAdminPassw0rd!`, `SEED_ADMIN_NAME=Test Super Admin`.

## Known gaps between `env.ts` and `.env.example`
- Present in the schema but absent from the example: `MAX_UPLOAD_TOTAL_MB`, `MAX_ARCHIVE_UNCOMPRESSED_MB`, `BLOCK_MESH_BIN`, `SURFACE_FEATURE_BIN`, `SNAPPY_HEX_MESH_BIN`, `SNAPPY_STEP_TIMEOUT_MS`, `CHAMBER_PYTHON_BIN`, `BUILD_CHAMBER_SCRIPT`, `MIRROR_STEP_SCRIPT`, `CHAMBER_BUILD_TIMEOUT_MS`, `SOLVER_DECOMPOSE_TIMEOUT_MS`.
- Declared but never read: `STITCH_TOL`, `NCC_COUPLE_BIN`, `FOAM_DICTIONARY_BIN`, `POST_PROCESS_BIN`.
- `MESH_PYTHON_BIN` is `python3` in the example, whereas the schema default on Windows is `python`.
