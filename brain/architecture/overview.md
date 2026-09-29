# Architecture: overview

> One-page system view. Details: `api-routes.md` (endpoints), `data-model.md` (DB), `storage-layout.md` (disk), `configuration.md` (env), `frontend.md` (SPA).
> Updated: 2026-09-28.

## 1. Monorepo

npm workspaces (no pnpm/yarn), Node ≥ 20 (dev on 24, `.nvmrc`).

```
dive-gui/
├── packages/shared/   @dive/shared : shared contract (types, zod, error codes, catalogs,
│                      chamber model). Dual CJS + ESM build, built BEFORE the apps.
├── apps/api/          @dive/api    : Express + TS (CommonJS), Prisma/SQLite, JWT, WebSocket terminal.
│   ├── src/modules/   one folder per domain (routes → controller → service, zod schemas)
│   ├── src/lib/       disk storage, command execution, OpenFOAM dict generators
│   ├── scripts/       Python: buildChamber.py (CadQuery), CGNS/VTK, patch extraction, export
│   ├── prisma/        schema.prisma (SQLite) + migrations + super-admin seed
│   └── tests/         vitest + supertest (injected command runners, isolated SQLite)
├── apps/web/          @dive/web    : React 18 + Vite + TS, Tailwind v3 (tokens), Radix/shadcn,
│                      TanStack Query, react-router, three.js, CodeMirror, xterm
├── apps/mcp/          @dive/mcp    : MCP server (stdio) wrapping the REST API
├── documents/         reference business materials (Gen Dim v3, semi-spiral, BC profiles)
└── brain/             agents' knowledge base (this folder)
```

## 2. Runtime topology

```
Browser ──HTTPS──► nginx ─┬─ /            → apps/web/dist (static SPA, index.html fallback)
                          └─ /api/* (+WS) → Node API :4000 (systemd dive-api)
                                              ├─ SQLite (Prisma)            DATABASE_URL
                                              ├─ STORAGE_DIR (cases, meshes, runs, caches)
                                              └─ child processes (argv, never an interpolated shell)
                                                  ├─ OpenFOAM ESI v2406 (via OPENFOAM_BASHRC)
                                                  ├─ Python: CGNS_PYTHON_BIN, MESH_PYTHON_BIN,
                                                  │          CHAMBER_PYTHON_BIN (CadQuery)
                                                  └─ ParaView pvbatch (+ xvfb-run) for the export
```

- In dev: `npm run dev` starts the API (:4000) and Vite (:5173); the web app calls `VITE_API_URL`, which is **required** (no default: the client throws if it is unset; the terminal WebSocket needs an absolute URL), e.g. `http://localhost:4000/api/v1` in `apps/web/.env`.
- The API does not serve the web bundle.
- **A single API instance**: the locks (`runExclusive`, per-hash chamber lock, active meshing runs) and the process handles are in memory.

## 3. API request lifecycle

1. `app.ts`: helmet, CORS (`CORS_ORIGIN`), `trust proxy` (`TRUST_PROXY`), `express.json({ limit: '16kb' })` (see M9), cookies, routers mounted under `/api/v1`.
2. Module router: `requireAuth` (JWT access token in `Authorization: Bearer`, rereads role + `isActive` from the DB), `requireRole('SUPER_ADMIN')` if needed, `validate({ body, params, query })` (zod, 422).
3. Thin controller → service: project visibility (`assertProjectVisible`, 404 otherwise), business logic, Prisma, FS, processes.
4. Errors: `AppError(status, code, message)` → `errorHandler` → `{ error: { code, message } }`.

## 4. Authentication

- Login → JWT access token (~15 min, kept **in memory** on the client) + JWT refresh token (~7 d) in an `httpOnly`, `SameSite=Lax` cookie, path `/api/v1/auth`, `Secure` in prod.
- The web client refreshes once on 401 (single-flight); logout = `tokenVersion` bump (revocation) + `queryClient.clear()`.
- argon2id passwords; rate limit on login; append-only audit log of sensitive actions.
- Roles `SUPER_ADMIN` / `USER`; seeded super-admin `isProtected` (indestructible).

## 5. CFD actions: execution model

- **Synchronous with a step report** (conversion, merge, autoPatch, BC, export): the service chains the tools; each step produces `success | failed | skipped` (export adds `warning`) + truncated output; the API answers `success: false` instead of throwing. The UI shows the stepper.
- **Asynchronous with polling** (solver runs, meshing runs): the process is launched in the background (`streamRunner`), the log is written to disk, the UI polls status + log (≈ 1.2 s) until a terminal status; stop = SIGTERM (mpirun relays it).
- **Chamber build**: `buildChamber.py` (CadQuery) produces GLB/STL/STEP + `warnings`; result cached by parameter hash (atomic write, per-hash lock).
- **Missing tool**: each step cleanly answers "not found" (development possible without OpenFOAM).
- **Tests**: injectable runners (`setCommandRunner`, `setStreamRunner`; the chamber builder is faked through `setCommandRunner` too); no real external tool in the API tests.

## 6. Frontend in short

`main.tsx` → providers (QueryClient, Auth, Toaster, Tooltip) → router (lazy routes, `RequireAuth` / `RequireRole` guards) → `AppShell` (header + sidebar) → pages → features. Data via TanStack Query (hierarchical keys `['projects', id, …]`), typed API client in `lib/api/`. Detail: `frontend.md`.

## 7. Deployment

Target: Debian 12 (the live server is actually Ubuntu 24.04 with v2406 and v2606 installed, see `brain/STATUS.md` §3), ESI OpenFOAM v2406 (`/usr/lib/openfoam/openfoam2406`), Python venv `/opt/dive-venv`, ParaView + Xvfb, app in `/home/app` (root), systemd service `dive-api` (`prisma migrate deploy` then `node dist/server.js`), nginx TLS in front. GitHub Actions CI: `verify` job (lint, typecheck, tests, build) + `geometry` job (real CadQuery pytest). Step by step: `brain/operations/installation.md`.
