# DIVE Turbinen

Internal web platform for **DIVE Turbinen GmbH & Co. KG** to parameterize and pilot openFOAM solver runs on a remote server. This repository is the **foundation phase**: authentication, a super-admin back office to manage accounts, and an (intentionally empty) home shell ready to receive the future solver-control workspace. The remote solver server is not part of this phase.

## Monorepo layout

npm-workspaces monorepo:

```
app/
├── apps/
│   ├── api/   @dive/api    — Express + TypeScript REST API (JWT auth, Prisma/SQLite). CommonJS.
│   └── web/   @dive/web    — React 18 + Vite + TypeScript SPA (Tailwind v3, Radix primitives, lucide-react).
├── packages/
│   └── shared/ @dive/shared — shared API contract (roles, validation constants, error codes). Dual CJS+ESM.
├── .github/workflows/ci.yml — CI: lint, typecheck, test, build on push/PR
├── CLAUDE.md  / AGENTS.md   — frontend design charter & operating rules
├── PRODUCT.md / DESIGN.md   — product strategy & the visual + component contract
└── PLAN.md                  — implementation plan and code-change journal
```

> `@dive/shared` is built before the apps (the root `dev` / `build` / `typecheck` / `test` scripts run `build:shared` first), so both sides share one source of truth for roles, the password length, and error codes.

## Requirements

- Node.js `>= 20` (developed on Node 24 - see `.nvmrc`)
- npm `>= 11` (workspaces). Do not use pnpm/yarn.

## Quick start

From the repo root:

```bash
# 1. Install every workspace dependency (once)
npm install

# 2. The API env is pre-created for local dev (apps/api/.env). For a fresh clone:
#    cp apps/api/.env.example apps/api/.env

# 3. Create the SQLite database + schema, then seed the permanent super-admin
npm run db:migrate
npm run db:seed

# 4. Run the API (:4000) and the web app (:5173) together
npm run dev
```

Then open `http://localhost:5173` and sign in.

### Default super-admin (development)

Seeded from `apps/api/.env`:

- **Email:** `admin@dive-turbinen.de`
- **Password:** `ChangeMe!2026`

> Change `SEED_ADMIN_PASSWORD` (and the JWT secrets) before seeding in any non-local environment. The super-admin account is permanent: it cannot be deleted or downgraded from the back office.

## Commands

Run from the repo root:

| Command | Description |
| --- | --- |
| `npm run dev` | Run API and web together (api `:4000`, web `:5173`). |
| `npm run dev:api` / `npm run dev:web` | Run a single app. |
| `npm run build` | Build the API (`tsc`) then the web app (`vite build`). |
| `npm run test` | Run all tests (API supertest + web React Testing Library). |
| `npm run typecheck` | Type-check both workspaces, no emit. |
| `npm run lint` / `npm run format` | ESLint / Prettier over the repo. |
| `npm run db:migrate` | Apply Prisma migrations (creates `apps/api/prisma/dev.db`). |
| `npm run db:seed` | Idempotently create the super-admin. |
| `npm run db:reset` | Drop and recreate the database (destructive). |

## Authentication model

- **Access token** (JWT, ~15 min) returned in the login response and sent as `Authorization: Bearer <token>`; kept in memory on the client only (never `localStorage`).
- **Refresh token** (JWT, ~7 days) stored in an `httpOnly`, `SameSite=Lax`, path-scoped (`/api/v1/auth`) cookie, so the session survives reloads. The web client transparently refreshes the access token once on a `401`.
- **Logout** increments a per-user `tokenVersion`, which revokes all outstanding refresh tokens.
- Passwords are hashed with **argon2id**. Login returns the same message for unknown email and wrong password (no user enumeration).
- **Disabled accounts** (`isActive = false`) cannot log in (`403 ACCOUNT_DISABLED`, returned only after the password check so it does not leak which emails exist) and lose access immediately: `requireAuth` and `/auth/refresh` reject them, and disabling bumps `tokenVersion` to revoke live sessions. The protected super-admin can never be disabled.
- Successful logins stamp `lastLoginAt`. Security-relevant admin and auth actions are recorded in an append-only **audit log**.

## REST API (prefix `/api/v1`)

| Method | Route | Access |
| --- | --- | --- |
| `POST` | `/auth/login` | public (rate-limited) |
| `POST` | `/auth/refresh` | refresh cookie |
| `POST` | `/auth/logout` | authenticated |
| `GET` | `/auth/me` | authenticated |
| `PATCH` | `/auth/me`, `POST /auth/change-password` | authenticated (self-service) |
| `GET/POST` | `/projects`, `/projects/:id` (GET/DELETE), `/projects/:id/collaborators` (POST/DELETE) | authenticated |
| `GET/POST` | `/users`, `/users/:id` (GET/PATCH/DELETE) | **super-admin only** |
| `GET` | `/audit-logs` | **super-admin only** (read-only) |

`PATCH /users/:id` also accepts `isActive` to disable / re-enable an account.

**Projects** are visibility-scoped: a user sees the projects they own or collaborate on, and a super-admin sees every project. Collaborators are added by email; only the owner (or a super-admin) can delete a project or manage its collaborators. A project the viewer may not see returns `404` (no existence leak).

Errors use a normalized envelope `{ error: { code, message } }`. Enforced business rules (covered by tests): the super-admin account cannot be deleted (`PROTECTED_ACCOUNT`), downgraded (`PROTECTED_ROLE`), or disabled (`PROTECTED_ACCOUNT`); you cannot delete (`SELF_DELETE_FORBIDDEN`) or disable (`SELF_DISABLE_FORBIDDEN`) your own account; a disabled account cannot log in (`ACCOUNT_DISABLED`); emails are unique (`EMAIL_TAKEN`); inputs are validated (`VALIDATION_ERROR`).

## Mesh conversion (CGNS → OpenFOAM) on Debian

A project's **Mesh conversion** card converts an uploaded `.cgns` mesh into the case's `constant/polyMesh` by running an external three-step toolchain on the server:

1. `python3 CgnsToVtk.py <cgns> <vtk>` (standalone VTK wheel) → legacy VTK
2. `vtkUnstructuredToFoam -case <case> <vtk>` (OpenFOAM) → `constant/polyMesh`
3. `checkMesh -case <case>` (OpenFOAM) → mesh report

The CGNS→VTK script ships with the API at `apps/api/scripts/CgnsToVtk.py`; the **binaries** (`python3` + the `vtk` wheel, the OpenFOAM utilities) are **not bundled** - install them on the deploy host and point the API at them. A missing/failed tool never crashes the API: each step is captured as a structured result and the convert endpoint returns `200` with a per-step report (the UI shows the logs).

> **Do not run step 1 with `pvpython`.** The script imports only the standalone `vtk` wheel, not `paraview.simple`. Under `pvpython` the pip VTK is loaded on top of ParaView's own bundled VTK in one process; the two builds mix, `SetFileName` silently no-ops ("File name not set") and the process segfaults. Use a plain `python3` that has `pip install vtk`.

**Debian install (example):**

```bash
sudo apt-get install -y python3-pip
pip3 install vtk                        # the standalone VTK wheel (provides vtkmodules)
# Install OpenFOAM per opencfd/openfoam.org instructions for your distro.
```

**Configure (`apps/api/.env`)** - every command is overridable; defaults assume Linux PATH:

| Variable | Default | Notes |
| --- | --- | --- |
| `CGNS_PYTHON_BIN` | `python3` | Plain Python interpreter with the `vtk` wheel installed (`pip install vtk`). **Not** `pvpython` — see the warning above. |
| `CGNS_TO_VTK_SCRIPT` | `apps/api/scripts/CgnsToVtk.py` | Bundled with the API (resolved relative to the module, cwd-independent). Set only to override. |
| `VTK_TO_FOAM_BIN` | `vtkUnstructuredToFoam` | OpenFOAM utility (on PATH once the env is sourced). |
| `CHECK_MESH_BIN` | `checkMesh` | OpenFOAM utility. |
| `OPENFOAM_BASHRC` | *(empty)* | When set, OpenFOAM tools run inside `bash -c 'source <bashrc> && exec "$@"'` (injection-safe). e.g. `/opt/openfoam12/etc/bashrc`. Leave empty if the tools are already on PATH. |
| `CONVERSION_STEP_TIMEOUT_MS` | `600000` | Per-step wall-clock timeout (10 min). |

Conversion is currently **synchronous** (one request runs the whole pipeline). Uploaded CGNS files live under `STORAGE_DIR/projects/<id>/cgns/`, separate from the case.

> **Prisma on Debian:** `schema.prisma` declares `binaryTargets = ["native", "debian-openssl-3.0.x"]`. Run `npm run prisma:generate -w @dive/api` **on the deploy host** (or a Debian build stage) so the Linux query engine is present; never ship a Windows-generated client. Use `debian-openssl-1.1.x` instead for Debian 11.

## App structure

**`apps/api/src`** - `config/` (validated env), `lib/` (prisma, jwt, password, AppError), `middleware/` (auth, role, validation, rate-limit, error handler), `modules/auth` + `modules/users` (routes/controller/service/schemas), `app.ts` (Express factory), `server.ts`. Tests in `apps/api/tests`.

**`apps/web/src`** - `styles/` (design tokens), `components/ui` (Radix-based primitives), `components/layout` (app shell), `components/common` + `components/brand`, `features/auth` (session), `features/admin` (user management), `lib/api` (typed client with auto-refresh), `app/` (router + guards), `pages/` (Login, Home, Admin).

## Testing

```bash
npm run test        # all
npm run test -w @dive/api   # API: auth + users business rules (supertest, isolated SQLite test.db)
npm run test -w @dive/web   # web: admin guard behavior (Vitest + Testing Library)
```

## Design & docs

The UI follows a strict brand/design system. Before changing any UI, read `CLAUDE.md` and `AGENTS.md` (charter, locked palette, mandatory skill sequence), then `DESIGN.md` (the visual + component contract). `PRODUCT.md` holds product strategy; `PLAN.md` holds the plan and a journal of code changes.

## What's next

The remote openFOAM solver server is out of scope for this phase. The architecture is ready to receive it as a new `apps/api/src/modules/solver` module plus a workspace under the authenticated app shell, without changing auth or the back office.
