# AGENTS.md · DIVE Turbinen

> Instructions for every AI agent (Claude Code, Codex, Cursor…) working in this repository.
> Loaded at every session, so it stays short. **Details live in `brain/`** (index: `brain/README.md`).
> Zone rules load on demand: `apps/web/AGENTS.md`, `apps/api/AGENTS.md`, `apps/api/scripts/AGENTS.md`, `packages/shared/AGENTS.md`.

## 1. The project

Internal web platform of **DIVE Turbinen GmbH & Co. KG** (German hydro-turbine manufacturer) to prepare, run and post-process **OpenFOAM CFD** cases from the browser. It covers:
- mesh import and conversion, and a 3D viewer;
- merge and multi-part assembly;
- boundary conditions;
- solver runs with live residuals;
- CFD-Post export;
- a parametric **chamber geometry** generator (CadQuery);
- snappyHexMesh / cfMesh meshing.

JWT auth and a super-admin back office sit on top.

| Workspace | Stack |
|---|---|
| `apps/api` (`@dive/api`) | Express + TypeScript, Prisma/SQLite, JWT, WebSocket terminal, drives OpenFOAM/Python tools |
| `apps/api/scripts` | Python: VTK/pyvista/trimesh (meshes), pvbatch (CGNS export), CadQuery (`buildChamber.py`) |
| `apps/web` (`@dive/web`) | React 18 + Vite + TS, Tailwind v3 on tokens, Radix/shadcn, TanStack Query, three.js, CodeMirror |
| `packages/shared` (`@dive/shared`) | API ↔ web contract (types, zod, error codes, catalogs, chamber model) |
| `apps/mcp` (`@dive/mcp`) | MCP server exposing the REST API as tools |

Production: Ubuntu 24.04 (Proxmox VM; the docs long said Debian 12), **ESI OpenFOAM v2406** used by the API (openfoam.com, not .org; v2606 also installed), nginx + systemd, app in `/home/app`.

## 2. Session protocol (mandatory)

**At the start**
1. Read `brain/STATUS.md` (current state, pitfalls, pending questions) and the top of `brain/changelog/<current YYYY-MM>.md`.
2. Locate the area with `brain/features/README.md` (by feature) or `brain/INDEX.md` (every file, one line each), then the matching `brain/codemap/*.md` section, **before** opening code. Read only what you need.
3. For a routine change, follow the matching recipe in `brain/playbooks/`.

**At the end of ANY change** (without being asked, in the same change):
1. **Changelog**: add an entry at the top of `brain/changelog/YYYY-MM.md` (format: `brain/changelog/README.md`). No code change is finished without its entry.
2. **Codemap + index**: update the `brain/codemap/*.md` section when a file is created, deleted, renamed or an export changes role, then run `python brain/codemap/build-index.py` (never edit `brain/INDEX.md` by hand).
3. **Features / architecture**: update the `brain/features/*.md` sheet and `brain/architecture/*.md` when behavior, an endpoint, the data model, an env var or the storage layout changes.
4. **State**: rewrite `brain/STATUS.md` if the state changed; update `brain/known-issues.md` (bug fixed or found) and `brain/decisions.md` (decision taken with the user).

Full matrix: `brain/README.md` §3.

## 3. Golden rules

1. **Do not implement what was not asked.** Open threads in `STATUS.md` / `known-issues.md` are proposals, not tasks.
2. **Non-trivial feature**: brainstorm (one question at a time), then a spec in `brain/specs/YYYY-MM-DD-<topic>-design.md`, then test-first, then implementation. Details: `brain/conventions/workflow.md`.
3. **Geometry**: any change to `apps/api/scripts/buildChamber.py` ⇒ purge `apps/api/storage/chamber/*` (cache keyed on parameters, not code).
4. **Shared contract**: changing `packages/shared` ⇒ `npm run build:shared` before typecheck and tests.
5. **Visible renames are display-only**: internal keys (`x1`..`x4`, `variant: 'stepped'|'hollow'`), saves and cache never change. "outlet" is the flow outlet, **never** the middle cylinder. See `brain/conventions/vocabulary.md`.
6. **Security**: no committed secrets; external commands as argv (`execFile`/`spawn`), never an interpolated shell; paths confined through the storage helpers; invisible project ⇒ 404.
7. **UI**: before any JSX/CSS, follow `apps/web/AGENTS.md` and `brain/conventions/frontend.md` (skill sequence + `brain/design/design-system.md`). Tokens only, light theme, WCAG AA.
8. **Honesty**: anything depending on OpenFOAM, ParaView, CadQuery or `/proc` that could not run is marked "to validate on the Debian server"; tests not run are reported as such.
9. **Git**: never commit on `main` (create `feat/…` or `fix/…`); Conventional Commits in English with a scope (`feat(chamber): …`); commit and push only when asked.
10. **Language**: code, comments, commits, UI strings and the brain are in **English**. Changelog entries written before 2026-09-28 stay in French (history). Talk to the user in the language they use.

## 4. Commands

| Action | Command (repo root) |
|---|---|
| Install | `npm install` |
| Dev (API :4000 + web :5173) | `npm run dev` |
| Full typecheck | `npm run typecheck` |
| All tests | `npm test` (rebuilds shared) |
| Targeted API test | `npm run build:shared && cd apps/api && npx vitest run tests/<file>.test.ts` |
| Targeted web test | `cd apps/web && npx vitest run src/features/<area>` |
| Geometry tests (CadQuery needed) | `pytest apps/api/scripts/tests -q` with the CadQuery interpreter |
| Lint / format | `npm run lint` / `npm run format` |
| Database | `npm run db:migrate`, `npm run db:seed`, `npm run db:reset` (destructive) |
| Build | `npm run build` |
| Regenerate / check the file index | `python brain/codemap/build-index.py` / `--check` |

Isolation details and suites known to fail locally: `brain/conventions/testing.md`. Environments (native Windows, WSL, server): `brain/STATUS.md` §3.

## 5. Where to find what

| Need | File |
|---|---|
| Current state, pitfalls, pending questions | `brain/STATUS.md` |
| History | `brain/changelog/` |
| **Every file of the repo, one line each** | `brain/INDEX.md` (generated) |
| Detail of each code file (role, exports, pitfalls) | `brain/codemap/` |
| Features, end to end | `brain/features/` |
| Step-by-step recipes (endpoint, migration, env var, page/tab, solver, chamber, deploy…) | `brain/playbooks/` |
| Architecture, routes, DB, storage, config, frontend | `brain/architecture/` |
| Workflow, code style, tests, UI, vocabulary | `brain/conventions/` |
| Known bugs, debt, open threads | `brain/known-issues.md` |
| Decisions and their reasons | `brain/decisions.md` |
| Visual contract / product positioning | `brain/design/design-system.md`, `brain/design/product.md` |
| Install and deployment | `brain/operations/installation.md`, `README.md` |
| Approved specs and plans | `brain/specs/`, `brain/plans/` |
| Domain reference material | `documents/` |

## 6. Design in brief

Blue `#004A99` (brand), orange `#EE7F00` (rare accent, never under small text), grey `#BCBDBF` (neutral). Primary CTA: `--color-cta` `#A85F00` (darkened orange, AA), **one per zone**. Light theme only, tokens from `apps/web/src/styles/tokens.css` exclusively, `lucide-react`, the logo diamond as a discreet motif. Banned: purple gradients, glassmorphism, huge shadows, emoji icons, bubble radii. Details: `apps/web/AGENTS.md`, `brain/conventions/frontend.md`, `brain/design/design-system.md`.
