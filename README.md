# DIVE Turbinen

Internal web platform for **DIVE Turbinen GmbH & Co. KG** to prepare, run and post-process OpenFOAM CFD cases from the browser. It covers the full per-project CFD workflow: mesh import & CGNS→Foam conversion, a 3D mesh viewer, multi-mesh merge and multi-part assembly, OpenFOAM solver runs with live residual charts, and export to CFD-Post — on top of JWT authentication and a super-admin back office.

The heavy OpenFOAM / ParaView / Python toolchain runs on the **Linux host where the API is deployed**. On a Windows dev box those tools are absent and each CFD action reports a clean "not found" per step instead of crashing — so you can develop the whole UI/API without a solver installed.

> **Deploy target:** Debian 12 (bookworm) with **ESI OpenFOAM.com v2406** (`/usr/lib/openfoam/openfoam2406`).

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Prerequisites — two tiers](#2-prerequisites--two-tiers)
3. [Run it in development](#3-run-it-in-development)
4. [Environment configuration](#4-environment-configuration)
5. [Full deployment tutorial (Debian)](#5-full-deployment-tutorial-debian)
6. [The CFD toolchain — what each feature needs](#6-the-cfd-toolchain--what-each-feature-needs)
7. [Command reference](#7-command-reference)
8. [Authentication model](#8-authentication-model)
9. [REST API](#9-rest-api)
10. [Known issues](#10-known-issues)

---

## 1. Architecture

An npm-workspaces monorepo (no pnpm/yarn):

```
app/
├── apps/
│   ├── api/   @dive/api    — Express + TypeScript REST API (JWT auth, Prisma/SQLite, WebSocket terminal).
│   └── web/   @dive/web    — React 18 + Vite + TypeScript SPA (Tailwind v3, Radix, three.js, CodeMirror).
├── packages/
│   └── shared/ @dive/shared — shared API contract (roles, validation constants, error codes). Dual CJS+ESM.
├── apps/api/scripts/       — bundled Python helpers (CGNS/VTK/mesh extraction; see §6).
├── apps/api/prisma/        — schema.prisma (SQLite) + seed.
└── .github/workflows/ci.yml — lint / typecheck / test / build on push & PR.
```

`@dive/shared` is built **before** the apps (the root `dev` / `build` / `typecheck` / `test` scripts all run `build:shared` first), so the API and web share one source of truth for roles, password rules and error codes.

**Runtime topology in production:** the web app is a static bundle (`vite build`), the API is a long-lived Node process (`:4000`), and a reverse proxy (nginx) serves the static files and forwards `/api/*` (including the WebSocket upgrade) to the API. The API itself does **not** serve the web bundle.

---

## 2. Prerequisites — two tiers

There are two independent tiers. **Tier A** is all you need to work on the UI and API. **Tier B** is only needed on the host that actually meshes and solves (the deploy box, or a Linux dev box where you want the real CFD actions to work).

### Tier A — the application (any OS)

| Requirement | Version | Notes |
| --- | --- | --- |
| **Node.js** | `>= 20` (developed on **24**, see `.nvmrc`) | `nvm install` picks it up. |
| **npm** | `>= 11` | Workspaces. Do **not** use pnpm/yarn. |

That's it — `npm install` pulls every JS/TS dependency (Express, Prisma, React, Vite, three.js, …). The database in dev is a local SQLite file, created by `npm run db:migrate`. No external DB server is required.

> **Optional (terminal feature):** `node-pty` is an *optional* dependency. It needs a C/C++ toolchain to build its native module (`build-essential` + `python3` on Linux, or the Windows Build Tools). If it is absent the API falls back to a piped shell, and the Terminal feature is off by default anyway (`TERMINAL_ENABLED=false`).

### Tier B — the CFD toolchain (Linux deploy host only)

These are **system packages**, not npm packages. Every binary is configurable in `apps/api/.env` and every one is optional in the sense that a missing tool degrades to a clean per-step error — but a feature does nothing useful until its tool is present.

| Component | Provides | Used by |
| --- | --- | --- |
| **ESI OpenFOAM.com v2406** | `simpleFoam`, `pimpleFoam`, `checkMesh`, `blockMesh`, `snappyHexMesh`, `surfaceFeatureExtract`, `cartesianMesh` (cfMesh), `surfaceFeatureEdges`, `mergeMeshes`, `stitchMesh`, `createNonConformalCouples`, `vtkUnstructuredToFoam`, `fluent3DMeshToFoam`, `autoPatch`, `decomposePar`, `reconstructPar`, `reconstructParMesh`, `foamDictionary`, `postProcess`, and its bundled **OpenMPI** (`mpirun`) | solver, meshing, merge/assemble, conversion, export |
| **Python 3** + pip wheels: `numpy`, `vtk`, `pyvista`, `trimesh`, `h5py` | CGNS→VTK read, 3D-viewer patch extraction, CSV→boundaryData, transient CGNS time-series merge | mesh viewer, CGNS import, draft-tube inlet, export |
| **ParaView** (`pvbatch`) | the **only** tool that can *write* CGNS (core VTK has a reader but no writer) | Export → CFD-Post |
| **Xvfb** | a virtual X display so headless `pvbatch` doesn't segfault on missing GL | Export (headless servers) |

> **Critical rule:** the plain `python3` wheels and ParaView's own bundled Python must stay separate. A pip-installed `vtk` in the system site-packages **shadows ParaView's VTK** and makes `paraview.simple` segfault on import. Keep the `vtk`/`pyvista` wheels in a venv, or set `PVBATCH_PYTHONPATH` so ParaView's `vtkmodules` win (see §4). Conversely, never run the CGNS→VTK script under `pvpython` — it must run under the plain `python3` that has the `vtk` wheel.

---

## 3. Run it in development

From the repo root:

```bash
# 1. Install every workspace dependency (once)
npm install

# 2. Create the API env from the template, then edit secrets/paths
cp apps/api/.env.example apps/api/.env
#    (the committed example already has working local defaults — see §4)

# 3. Create the SQLite database + schema, then seed the permanent super-admin
npm run db:migrate
npm run db:seed

# 4. Run the API (:4000) and the web app (:5173) together
npm run dev
```

Open **http://localhost:5173** and sign in.

**Default super-admin (development):** seeded from `apps/api/.env`.

- **Email:** `admin@dive-turbinen.de`
- **Password:** `ChangeMe!2026`

> The super-admin is permanent — it cannot be deleted, downgraded, or disabled from the back office. **Change `SEED_ADMIN_PASSWORD` and both JWT secrets before seeding anywhere non-local** (the env validator refuses to boot in `production` with placeholder or short secrets).

On a Windows/macOS dev box the CFD tools are absent: you can drive the entire UI, and any solver/mesh/export action returns a per-step "not found" report rather than crashing. To exercise the real toolchain, develop on a Linux box with Tier B installed (§5).

---

## 4. Environment configuration

The API loads `apps/api/.env`, validates it with zod at boot, and **fails fast with a readable list** if anything required is missing or malformed. The full, commented catalogue of every variable lives in **`apps/api/.env.example`** — copy it and edit. Below are the ones that matter most.

### Must set before any non-local deploy

| Variable | Why |
| --- | --- |
| `NODE_ENV=production` | Enables the strict secret checks below. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Random, **≥ 32 chars**, and **different from each other**. Boot fails otherwise in production. Generate with `openssl rand -base64 48`. |
| `DATABASE_URL` | SQLite path, e.g. `file:/var/lib/dive/prod.db` (absolute, on persistent storage). |
| `CORS_ORIGIN` | The exact origin the browser uses, e.g. `https://dive.example.de`. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | The first super-admin. Password must not be a placeholder. |
| `STORAGE_DIR` | Absolute path for per-project case/mesh/run storage, e.g. `/var/lib/dive/storage` (needs lots of disk; see §5). |
| `TRUST_PROXY=1` | **Set this when behind nginx** so the login rate-limiter keys on the real client IP instead of the proxy's. |

### CFD toolchain paths (Linux host)

Defaults assume the tools are on `PATH` once the OpenFOAM environment is sourced. The single most important one:

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENFOAM_BASHRC` | *(empty)* | **Set this** to `/usr/lib/openfoam/openfoam2406/etc/bashrc`. Every OpenFOAM tool then runs inside `bash -c 'source <bashrc> && exec "$@"'` (arguments passed as real argv — injection-safe), which also puts the bundled `mpirun` on PATH for parallel runs. |
| `CGNS_PYTHON_BIN` | `python3` | Plain interpreter with the `vtk` wheel. **Never** `pvpython`. |
| `MESH_PYTHON_BIN` | `python3` (Linux) | Interpreter with `pyvista`/`trimesh`/`numpy`/`h5py`. Point at your venv's python. |
| `PVBATCH_BIN` | `pvbatch` | ParaView batch (Export only). |
| `PVBATCH_XVFB` | `true` | Runs `xvfb-run -a pvbatch …` for headless GL. Set `false` only for an OSMesa/offscreen ParaView build. |
| `PVBATCH_PYTHONPATH` | *(empty)* | Prepend ParaView's own `vtkmodules` dir here if a system-wide pip `vtk` shadows it (segfault fix). |
| `SOLVER_TOTAL_CORES` | `0` | Global core budget across all projects for parallel runs (`0` = machine logical cores). |
| `DECOMPOSE_METHOD` | `scotch` | Needs the scotch library in the OpenFOAM build; switch to `hierarchical`/`simple` if absent. |
| `TERMINAL_ENABLED` | `false` | Per-project shell over WebSocket. Only enable on a trusted single-tenant host — it is a real shell as the API's OS user. |

Meshing/merge/export step timeouts, MPI flags, solver runtime cap, upload size, etc. all have sensible defaults documented inline in `.env.example`.

---

## 5. Full deployment tutorial (Debian)

Target: a fresh **Debian 12 (bookworm)** server. Run as a sudo-capable user. Adjust paths to taste.

### 5.1 Node.js ≥ 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

### 5.2 ESI OpenFOAM.com v2406 (+ bundled OpenMPI, cfMesh)

```bash
curl https://dl.openfoam.com/add-debian-repo.sh | sudo bash
sudo apt-get install -y openfoam2406-default
# Verify the environment and a few tools:
source /usr/lib/openfoam/openfoam2406/etc/bashrc
which simpleFoam checkMesh snappyHexMesh cartesianMesh mergeMeshes mpirun
```

cfMesh (`cartesianMesh`, `surfaceFeatureEdges`) and OpenMPI (`mpirun`) ship inside this package — no separate install. Note the bashrc path: it goes into `OPENFOAM_BASHRC`.

### 5.3 Python toolchain (isolated venv — recommended)

Keeping the pip wheels in a venv prevents them from shadowing ParaView's VTK.

```bash
sudo apt-get install -y python3 python3-venv python3-pip
python3 -m venv /opt/dive-venv
/opt/dive-venv/bin/pip install --upgrade pip
/opt/dive-venv/bin/pip install numpy vtk pyvista trimesh h5py
```

Then point the API at it: `CGNS_PYTHON_BIN=/opt/dive-venv/bin/python3` and `MESH_PYTHON_BIN=/opt/dive-venv/bin/python3`.

### 5.4 ParaView + Xvfb (Export only)

```bash
sudo apt-get install -y paraview xvfb
which pvbatch
```

If `pvbatch`'s Python collides with the pip `vtk` wheel (a `PyVTKObject` SIGSEGV on `import paraview.simple`), set `PVBATCH_PYTHONPATH` to ParaView's own `vtkmodules` directory. With the venv approach above the collision usually doesn't arise because the wheels aren't in the system site-packages.

### 5.5 Get the code and build

```bash
sudo git clone git@github.com:Bapteds/dive-gui.git /opt/dive && cd /opt/dive
git checkout main

npm ci                    # clean, lockfile-exact install of all workspaces
```

Configure the API:

```bash
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — at minimum set the "Must set" block from §4:
#   NODE_ENV=production
#   JWT_ACCESS_SECRET / JWT_REFRESH_SECRET   (openssl rand -base64 48, different)
#   DATABASE_URL=file:/var/lib/dive/prod.db
#   STORAGE_DIR=/var/lib/dive/storage
#   CORS_ORIGIN=https://dive.example.de
#   TRUST_PROXY=1
#   OPENFOAM_BASHRC=/usr/lib/openfoam/openfoam2406/etc/bashrc
#   CGNS_PYTHON_BIN=/opt/dive-venv/bin/python3
#   MESH_PYTHON_BIN=/opt/dive-venv/bin/python3
#   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME

sudo mkdir -p /var/lib/dive/storage && sudo chown -R "$USER" /var/lib/dive
```

Build (this also regenerates the Prisma client **on the host**, so the Linux query engine is correct):

```bash
npm run build            # build:shared → api (tsc) → web (vite build)
```

> **Prisma on Debian:** `schema.prisma` emits `["native", "debian-openssl-3.0.x"]` (Debian 12). For Debian 11 (bullseye) add `debian-openssl-1.1.x` and re-generate. Building on the host (as above) always produces the right engine — never ship a Windows-generated client.

Create the database and the first admin:

```bash
npm run db:migrate -w @dive/api   # prisma migrate deploy is also run by `npm start`
npm run db:seed -w @dive/api
```

### 5.6 Run the API as a service

`apps/api`'s `start` script runs `prisma migrate deploy` then `node dist/server.js`. Example systemd unit (`/etc/systemd/system/dive-api.service`):

```ini
[Unit]
Description=DIVE Turbinen API
After=network.target

[Service]
Type=simple
User=dive
WorkingDirectory=/opt/dive/apps/api
# Source the OpenFOAM env so mpirun and the solver binaries are on PATH:
ExecStart=/bin/bash -lc 'source /usr/lib/openfoam/openfoam2406/etc/bashrc && npm start'
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now dive-api
sudo journalctl -u dive-api -f     # watch it boot; env errors print here
```

### 5.7 Serve the web bundle + reverse-proxy the API (nginx)

`npm run build` produced the static SPA in `apps/web/dist`. Example nginx site:

```nginx
server {
    listen 443 ssl;
    server_name dive.example.de;
    # ssl_certificate / ssl_certificate_key ...

    root /opt/dive/apps/web/dist;
    index index.html;

    # SPA routing: fall back to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API + WebSocket terminal
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;         # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;                        # long solver polls / terminal
    }
}
```

Because nginx terminates TLS in front of the API, set `TRUST_PROXY=1` (done in §5.5) so the rate limiter sees real client IPs. The refresh cookie is `Secure` in production, so the site **must** be served over HTTPS or logins won't persist.

Build the web with the API origin baked in if it differs from the site origin (`VITE_API_URL`); with the same-origin nginx layout above the default relative `/api/v1` works.

### 5.8 Verify

```bash
curl -k https://dive.example.de/api/v1/health   # or open the site and log in
```

Then run one CFD action end-to-end (e.g. import a small CGNS mesh and Convert) and confirm each step reports success in the UI — that proves the OpenFOAM + Python paths in `.env` are correct.

---

## 6. The CFD toolchain — what each feature needs

Every action degrades to a clean per-step "not found" if its tool is missing, so you can roll out tiers incrementally.

| Feature (project tab) | External tools |
| --- | --- |
| **Case files** | none (pure file editing) |
| **Mesh → Convert CGNS→Foam** | `CGNS_PYTHON_BIN` + `vtk` wheel → `vtkUnstructuredToFoam` → `checkMesh` |
| **Mesh → Import Fluent/Gmsh `.msh`** | `fluent3DMeshToFoam` (or `gmshToFoam`) |
| **Mesh → auto-patch** | `autoPatch` |
| **Visualize (3D viewer)** | `MESH_PYTHON_BIN` + `pyvista`/`trimesh`/`numpy` (`extractPatches.py`) |
| **Meshing page (snappyHexMesh)** | `blockMesh`, `surfaceFeatureExtract`, `snappyHexMesh` (+ `decomposePar`/`reconstructParMesh`/`mpirun` for parallel) |
| **Meshing page (cfMesh)** | `surfaceFeatureEdges`, `cartesianMesh` (OpenMP, `OMP_NUM_THREADS`) |
| **Merge meshes** | `mergeMeshes`, `stitchMesh`, `checkMesh` |
| **Assemble (non-conformal couple)** | `mergeMeshes` + `createNonConformalCouples` (see note below) |
| **Draft-tube inlet from CSV** | `MESH_PYTHON_BIN` (`csv_to_boundaryData.py`, pure Python) |
| **Solver** | the case's `application` (e.g. `simpleFoam`/`pimpleFoam`); parallel path adds `decomposePar` + `mpirun` + `reconstructPar` |
| **Export → CFD-Post** | `pvbatch` (+ `xvfb`), `foamDictionary`, `postProcess`, and `MESH_PYTHON_BIN` + `h5py` for the transient time-series merge |
| **Terminal** | a login shell (opt-in; `node-pty` for a real PTY, else piped fallback) |

> **Coupling note (ESI v2406):** the app's merge/stitch path is written for ESI positional CLI. `createNonConformalCouples` originated on OpenFOAM.org v12; on v2406 verify the utility and its patch-argument order on the box before relying on the Assemble coupling in production (see `BUG_AUDIT.md`).

---

## 7. Command reference

Run from the repo root:

| Command | Description |
| --- | --- |
| `npm run dev` | Run API (`:4000`) and web (`:5173`) together. |
| `npm run dev:api` / `npm run dev:web` | Run a single app. |
| `npm run build` | Build shared → API (`tsc`) → web (`vite build`). |
| `npm run test` | All tests (API supertest + web Testing Library). |
| `npm run typecheck` | Type-check every workspace, no emit. |
| `npm run lint` / `npm run format` | ESLint / Prettier over the repo. |
| `npm run db:migrate` | Apply Prisma migrations (dev: creates `apps/api/prisma/dev.db`). |
| `npm run db:seed` | Idempotently create the super-admin. |
| `npm run db:reset` | Drop and recreate the database (**destructive**). |
| `npm start -w @dive/api` | Production API start (`prisma migrate deploy` + `node dist/server.js`). |

---

## 8. Authentication model

- **Access token** (JWT, ~15 min) returned by login, sent as `Authorization: Bearer <token>`, kept **in memory** on the client only (never `localStorage`).
- **Refresh token** (JWT, ~7 days) in an `httpOnly`, `SameSite=Lax`, path-scoped (`/api/v1/auth`) cookie — `Secure` in production (HTTPS required). The web client transparently refreshes once on a `401`.
- **Logout** bumps a per-user `tokenVersion`, revoking all outstanding refresh tokens.
- Passwords hashed with **argon2id**. Login returns one message for both unknown email and wrong password (no user enumeration).
- **Disabled accounts** (`isActive=false`) can't log in or refresh and lose access immediately. The protected super-admin can never be disabled, deleted, or downgraded.
- `requireAuth` re-reads role and `isActive` from the DB per request, so role changes and disables take effect immediately despite a still-valid JWT.
- Security-relevant admin/auth actions are recorded in an append-only **audit log**.

---

## 9. REST API

Prefix `/api/v1`. Errors use a normalized envelope `{ error: { code, message } }`.

| Method | Route | Access |
| --- | --- | --- |
| `POST` | `/auth/login` | public (rate-limited) |
| `POST` | `/auth/refresh` | refresh cookie |
| `POST` | `/auth/logout`, `GET /auth/me`, `PATCH /auth/me`, `POST /auth/change-password` | authenticated |
| `GET/POST` | `/projects`, `/projects/:id` (GET/DELETE), `/projects/:id/collaborators` | authenticated (visibility-scoped) |
| `GET/POST/PATCH/DELETE` | project sub-resources: files, meshes, boundary, conversion, runs, export, terminal | project owner/collaborator |
| `GET/POST` | `/templates`, `/templates/:id` | authenticated (author/admin to edit) |
| `GET/POST` | `/users`, `/users/:id` | **super-admin only** |
| `GET` | `/audit-logs` | **super-admin only** (read-only) |

Projects are visibility-scoped: a user sees only projects they own or collaborate on; a super-admin sees all. A project the viewer may not see returns `404` (no existence leak). Only the owner or a super-admin can delete a project or manage its collaborators.

---

## 10. Known issues

A full read-only bug audit of the codebase lives in **`BUG_AUDIT.md`** (4 CRITICAL / 10 HIGH / 24 MEDIUM / 21 LOW, ranked, each with a file:line and a concrete failure scenario). **Read it before a production rollout** — several findings ship silent data corruption or can take down the API. None are fixed yet. Highlights:

- **CGNS export scrambles time-step order** once a case has ≥10 written times (this branch's flagship feature).
- **Deleting a user** cascade-deletes their projects and orphans multi-GB storage on disk.
- **An unhandled solver-log stream error** can crash the whole API mid-run.
- **Logout doesn't clear the client cache**, so the next user on a shared machine sees the previous user's data.
