# Decision log

> Structural decisions, with their date and their reason. **Before challenging one of these choices, re-read the reason and discuss it with the user.**
> Add a row (and a `Decision` entry in the changelog) for every new decision made with the user. A reversed decision is not deleted: mark it ~~struck through~~ with the date and the decision that replaces it.
> Sources: initial plan (`PLAN.md` §1 and §9, migrated on 2026-09-28), changelog, specs.

## Foundations

| Date | Decision | Reason |
|---|---|---|
| 2026-06-19 | Node + TypeScript backend with **Express** (NestJS ruled out) | Lightweight and explicit for a foundation; to revisit if the scope grows. |
| 2026-06-19 | **SQLite through Prisma** | Zero server to install; trivial Postgres migration later. `role` stored as a `String` (no native SQLite enum), enum enforced by zod. |
| 2026-06-19 | **JWT access (15 min) + refresh (7 d) in an httpOnly cookie**; access token in memory only | Security (no `localStorage`) with a persistent session. |
| 2026-06-19 | Roles **`SUPER_ADMIN` / `USER`**; seeded super-admin **indestructible** (no deletion, demotion or deactivation) | No accidental lockout of the platform. |
| 2026-06-19 | **No public sign-up**; accounts created by the super-admin; no password reset by email | Internal tool; no mail server. |
| 2026-06-19 | **npm workspaces** (neither pnpm nor yarn) | Simplicity. |
| 2026-06-19 | Primary CTA in **`--color-cta` `#A85F00`** (darkened brand orange), not `#EE7F00` | `#EE7F00` under white text = 2.74:1 (fails AA); `#A85F00` = 4.88:1. |
| 2026-06-19 | **Self-hosted** Inter (`@fontsource/inter`), code-split by route | Performance (no more blocking Google Fonts request), smaller initial bundle. |
| 2026-06-22 | Shared contract **`@dive/shared`** (roles, lengths, error codes, then catalogs) | A single source of truth API ↔ web. |

## Storage and execution

| Date | Decision | Reason |
|---|---|---|
| 2026-06-22 | Case files on the **per-project filesystem** under `STORAGE_DIR`, anti-traversal and anti-zip-slip | The app runs on Linux with the OpenFOAM tools; no files in the database. |
| 2026-06-24 | 3D viewer: **one-shot Python script → cached GLB + manifest** | Neither a Trame server nor polyMesh parsing in JS. |
| 2026-06-24 | Run tracking by **client polling** (SSE deferred) | Reuses the existing auth and refresh. |
| 2026-06-30 | Mesh library stored under a **readable slug**; the merge rewrites `case/constant/polyMesh` | Business names; no downstream change. |
| 2026-07-01 | **Target ESI OpenFOAM v2406** (openfoam.com), not openfoam.org v12 | Production server; positional CLI; coupling by `cyclicAMI` retyping because `createNonConformalCouples` only exists in .org. |
| 2026-07-01 | Rigid transforms computed **server-side in TS with the `Matrix4.compose` formula** (three.js) | Preview and result bit-identical (parity fixtures shared web/API). |
| 2026-07-01 | **Non-destructive** assembly, replayed from the original (restore-first) | Remove a part or undo everything without stacking merges. |
| 2026-07-02 | **Shared solver catalog** as the single source; classic ESI binaries, never `foamRun`; levels `full` / `base` | Make every solver guided, honestly. |
| 2026-07-03 | Central mapping **turbulence model → `0/` fields + wall functions** | Remove over-generation, set wall functions automatically. |
| 2026-07-03 | **Global core budget** (409 refusal rather than a queue); `--use-hwthread-cpus --oversubscribe` | Avoid oversubscription; OpenMPI counts physical cores. |
| 2026-07-03 | Project terminal **disabled by default** (`TERMINAL_ENABLED=false`) | The app's only shell surface; full, unconfined shell. |
| 2026-07-06 | BC contract: `p0 = 9.81·H`, **single pressure anchor at the outlet**; boundaries synced in `merge` mode | Validated with the user; preserves existing BCs. |
| 2026-07-08 | cfMesh: **internal STL merge** (no more `surfaceAdd`), cores mapped to `OMP_NUM_THREADS` | `surfaceAdd` broken on the ESI build; cfMesh is OpenMP, not MPI. |
| 2026-07-10 | **In-process** lock (`runExclusive`) to start a run | The runs subsystem is already single-process; implies **a single API instance**. |

## Templates, export

| Date | Decision | Reason |
|---|---|---|
| 2026-06-22 | Templates **shared by everyone**; conflicts settled file by file (default "keep") | User choice. |
| 2026-06-25 | CFD-Post export: pivot to EnSight then **back to single-file transient CGNS** (pvbatch) | CFD-Post does not read the EnSight produced. |

## Chamber Creation

| Date | Decision | Reason |
|---|---|---|
| 2026-07-30 | Empirical model **only in `@dive/shared`**; the Python builder receives the FINAL values | Zero drift between the coefficients. |
| 2026-07-30 | Build cache **keyed by parameter hash** | No staleness management. Consequence: manual purge after a code change (see 2026-08-05). |
| 2026-07-31 | `P2 = P11 + P12` as a hard identity | New Excel workbook. |
| 2026-08-03 | Renames (German labels, then physical names) **limited to display**; internal keys unchanged | The builder, the saves and the cache read the keys. |
| 2026-08-03 | `@dive/shared` resolved **from source** through a Vite alias in dev | The pre-bundle served stale labels. |
| 2026-08-04 | All structural relations **ON by default**; master switch = hard override | User choice. |
| 2026-08-05 | The vanes **penetrate the shroud** (overlap 0.01 × band, larger than the cell size) | Seals the junction for snappyHexMesh and cfMesh. |
| 2026-08-05 | **Any geometry change requires purging `apps/api/storage/chamber/*`** | The hash ignores the builder code. |
| 2026-08-06 | Removal of non-wetted zones by **manifold boolean** (and not "mesh seals them") | Deterministic and verifiable in the app. |
| 2026-08-11 | Chamfer, feet and vanes = **pure geometric flags outside the model** | Avoids moving the axis through LT. |
| 2026-08-11 | Chamber → Meshing transfer **without `domain.stl`** | cfMesh already merges the STLs; otherwise duplicate triangles. |
| 2026-08-13 | A perfect STEP is no longer needed: tasks 4 to 6 of the STEP plan abandoned | User decision. |
| 2026-08-31 | **Real geometry tests in CI** (dedicated pytest job, goldens tied to the pinned OCC) | CadQuery installs in CI; CI is authoritative. |
| 2026-08-31 | **Refuse rather than shrink** (including hollow, fit of the feet and of the chamfer) | Never silently wrong geometry. |
| 2026-09-01 | Rounding to **50 mm for empirical estimates only** | Entered values propagate as is. |
| 2026-09-01 | STEP of builds with vanes **generated on demand** | The sculpting costs about 2/3 of the build. |
| 2026-09-02 | **`accent-strong`** token (`#8F4F00`) for small orange text | AA compliance. |
| 2026-09-02 | **Gen Dim v3 workbook = source of truth** of the generator model; fixed ratios removed | A single source of truth (`documents/Gen Dim v3 Only Calculator (standalone).xlsx`). |
| 2026-09-02 | **"outlet" = flow exit**, never the middle cylinder | Vocabulary correction by the user. |
| 2026-09-04 | Blade skin assigned by an **exact geometric test** (and not a nearest-centroid vote) | Two successive failed density tunings. |
| 2026-09-28 | A chamber too small for its parts stays a **refusal**; no automatic enlargement of the model's chamber dimensions | User decision (an enlargement was merged then removed the same day). Confirms "refuse rather than shrink" in the other direction too. |
| 2026-09-28 | **Generator height editable in both designs**: blank = through the chamber top, a value = closed flat-topped cylinder | User request. |

## Project organization

| Date | Decision | Reason |
|---|---|---|
| 2026-09-28 | All project documentation lives in `brain/`; only `README.md` (GitHub convention), `AGENTS.md` and `CLAUDE.md` remain at the root. `DESIGN.md` → `brain/design/design-system.md`, `PRODUCT.md` → `brain/design/product.md`, `INSTALLATION.md` → `brain/operations/installation.md` (code comments updated) | User request: a single, tidy place. The design skills receive the paths explicitly. |
| 2026-09-28 | `brain/INDEX.md` **generated** from the codemap sheets (`build-index.py`), checked by the `Stop` hook | A flat list of all files with no double entry and no drift. |
| 2026-09-28 | Agent documentation reorganized into **`brain/`**; `AGENTS.md` = single source (imported by `CLAUDE.md`); monthly changelog kept by the agent, safety net through the `Stop` hook | Minimal loaded context, knowledge on demand, automatic traceability. |
| 2026-09-28 | The brain is written in **English** (changelog entries before 2026-09-28 stay in French) | The co-developer, author of almost all commits, must be able to read and maintain it. |
