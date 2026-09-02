# Handover — Chamber Creation: exports, fit refusals, 50 mm grid, review hardening

> Branch: `feat/chamber-ui-feedback`. Latest work is **committed AND pushed** (`158dc25`),
> **27 commits ahead of `main`**.
> This branch's earlier PR (#2, "surface builder warnings in the UI + LEOW no-effect badge")
> was **merged 2026-08-31**; everything below landed on the same branch AFTER that merge, so the
> next integration step is a **fresh PR**: `gh` is now authenticated on this machine
> (`hristovdimitrov222`), so `gh pr create --base main` works — or use
> https://github.com/Bapteds/dive-gui/compare/main...feat/chamber-ui-feedback?expand=1
> Supersedes the 2026-08-13 handover (guide-vane STEP export) — key parts of it are now WRONG;
> see §2. The full per-feature French changelog is at the bottom of `PLAN.md`; each feature has a
> spec under `docs/superpowers/specs/` (eight new ones dated 2026-08-31…2026-09-01).

---

## 0. Access & toolchain (READ FIRST if new to this repo)

The toolchain lives in **WSL**, outside this folder:

- `npm`/`node` are **WSL-only** — Git Bash / PowerShell on Windows fail with "npx: command not found".
- CadQuery Python is a **WSL venv**: `/home/hristo/cadquery-env/bin/python`
  (the API reads it via `CHAMBER_PYTHON_BIN`; the mesh viewer uses `MESH_PYTHON_BIN` →
  `/home/hristo/mesh-viz-env`, a separate venv with pyvista/trimesh).
- Invoke via `wsl bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/... && ..."`.
  WSL prints harmless `Failed to translate 'H:\bin'` lines on every call — ignore them.
- `gh` CLI is installed **and authenticated** (keyring, account `hristovdimitrov222`).

```bash
# REAL geometry test suite (CadQuery in WSL; ~6 min, builds fixtures once per session)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  /home/hristo/cadquery-env/bin/python -m pytest tests/test_build_chamber.py -q'

# Build ONE chamber by hand (params JSON -> outDir; add --step for the vane STEP)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && \
  CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py <params.json> <outDir> [--step]'

# Chamber TS gates (FAKE builder — never runs CadQuery)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api && \
  npx vitest run tests/chamber.test.ts tests/chamberModel.test.ts tests/chamberSaves.test.ts'
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/web && \
  npx vitest run src/features/chamber'

# Typecheck (rebuild shared FIRST whenever packages/shared changed)
wsl bash -lc 'cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && \
  npx tsc -p apps/api/tsconfig.json --noEmit && npx tsc -p apps/web/tsconfig.json --noEmit'
```

- After **any** `buildChamber.py` change, **purge the build cache**
  (`rm -rf apps/api/storage/chamber/*`): builds are hashed on params, not code. This matters MORE
  now — a deferred vane STEP (`--step` re-run, see §3) executes the CURRENT script inside an OLD
  build's directory (known, accepted; flagged in the review as a possible future cache-key change).
- The 50 mm grid snapping (§4) changed every param hash once: pre-existing cached builds simply
  rebuilt on first use. The old handover's "reference hashes" are gone — don't look for them.
- `CHAMBER_DEBUG_DUMP=1` dumps `core.stl`, `casing.stl`, `F.stl`, `meta.json`… into
  `<outDir>/_debug/` — the main geometry diagnostic. `CHAMBER_STEP_DEBUG=1` logs the vane-STEP gate.
- **Full API vitest on WSL is slow (~8 min) and `conversion.test.ts` / `meshes.test.ts` fail on
  THIS box for pre-existing environment reasons (OpenFOAM tooling), unrelated to chamber** —
  verified by stash-and-rerun. Run targeted suites.
- **Scratch discipline**: one-off scripts go in the session scratchpad or `_diag_*` names; stage
  explicit file lists. (Recent commits used `git add -A` on a clean tree after review — prefer
  explicit paths when the tree has scratch.)
- PowerShell 5.1 gotcha: a here-string commit message containing **double quotes** gets mangled
  into pathspecs (`error: pathspec 'take' …`) and the commit silently doesn't happen while a
  bundled `git push` still runs — keep quotes out of commit messages and check `git log` after.

---

## 1. State of the branch in one paragraph

Chamber Creation now: computes the twelve parameters with **empirical values snapped to a 50 mm
grid** (user-entered values pass through verbatim, identities propagate them); refuses impossible
builds up front (negative/zero dims, inverted Min>Max, part/feet/distributor poking out of the box,
axis inside a chamfer corner, hollow stack overflow — all with actionable messages in a red panel +
toast); builds ~3× faster for guide-vane configs because the expensive vane STEP is **generated on
demand at first download**, with a "Change rotational direction" menu item that serves a
**z-y-mirrored STEP** (also on demand); has **team-shared named saves** (load/save/rename/
duplicate/delete); and the build cache is **crash-safe and race-free** (atomic artifact writes, GLB
promoted last as the completion marker, per-hash in-process lock).

## 2. Corrections to the OLD handover (2026-08-13) — read if you knew the old state

- **"Hollow guide-vane STEP falls back vane-less" is FIXED.** The tangent trailing-edge rounding
  (`VANE_TE_ROUND_*`, spec 2026-08-31-vane-te-rounding) removed the self-overlapping OCC boolean at
  the blunt TE corners; **both variants now pass the round-trip volume gate** and ship editable
  BREP vanes (`test_step_export_vane_policy` asserts it). The old §4 fuzzy-boolean/overcut ideas
  are moot.
- **"stepHasVanes is written but not consumed" is obsolete.** It is now wired end-to-end:
  `readChamberBuildMeta` (chamberStorage) → `ChamberBuildResult.stepHasVanes` (service/controller)
  → web `ChamberBuildResponse` → gates the STEP menu (`offerMirror`).
- **The vane STEP is no longer produced at build time** — see §3. A plain vane build writes NO
  `chamber.step` and NO `build-meta.json`; `--step` produces both.
- Still true from the old handover: STL patch normals point outward (flip raised, deprioritized,
  **still not done**); `bakeVaneBladeProfile.py` + the committed airfoil asset are unchanged.

## 3. Feature summary (details: PLAN.md changelog + specs, newest last)

1. **Vane TE tangent rounding** — shapely `buffer(-r).buffer(+r)` on the 2D blade loops
   (r = 0.00585 × PCA chord); meshes AND STEP both benefit; builds got FASTER (~93-105 s → 77-79 s
   at the time). Spec `2026-08-31-vane-te-rounding-design.md`.
2. **Full-width chamber page + team-shared saved builds** (`ChamberSave` Prisma model, unique name,
   author-or-super-admin mutations, load/save/rename/duplicate/delete menu in the page header) +
   collapsible dimension-reference drawing under the Parameters table + every error/warning in BOTH
   the notices panel and a toast. Spec `2026-08-31-chamber-fullwidth-and-saved-builds-design.md`.
3. **Deferred + mirrored STEP** — measured: the vane carve+gate is 23-28 s ≈ 2/3 of a vane build.
   `buildChamber.py --step` produces the vane STEP + `build-meta.json`; the API generates it on the
   first `GET /export/step` (per-hash lock, then cached); `mirrorStep.py` mirrors it on the z-y
   plane for `GET /export/stepMirrored` ("Change rotational direction", vane builds only, 409 for
   the fallback). OCC gotcha discovered: **BRepGProp reports +0.1% phantom volume on mirrored
   (indirect) parametrizations** — the geometry is exact (identical watertight tessellations), so
   the geometry test compares tessellated volume/bounds/centroid, never BREP mass properties.
   Specs `2026-09-01-mirrored-step-download-design.md`, `2026-09-01-deferred-vane-step-design.md`.
4. **50 mm grid** — `computeChamberOutputs` snaps empirical estimates (fits, refine fits, and
   dLast's `= f(HLE)` formula, which is `empirical: true`) to `CHAMBER_GRID_MM` BEFORE the clamp;
   user-driven values (Exact, bitten Min/Max) pass verbatim and true identities propagate them
   unrounded (`ChamberOutput.userDriven`). Auto Length inherits. OPEN question the user never
   answered: a sum with ONE user term (Exact LEB + estimated LEOW) propagates unsnapped — accepted
   for now. Spec `2026-09-01-empirical-50mm-rounding-design.md`.
5. **Guide vanes default ON** in the form (web default only; API default stays false; saves store
   explicit values).
6. **Review + 4 hardening batches** (a 3-agent review, findings verified; batches have specs):
   - **Cache integrity** (`…-chamber-cache-integrity-design.md`): every builder artifact written
     tmp+rename with **chamber.glb promoted LAST** (its presence = build complete → a killed build
     leaves no GLB and self-heals by rebuilding); `withChamberLock` per-hash promise-chain mutex
     around build/step/mirror (state re-checked under the lock); mkstemp in mirrorStep.py.
     **The lock is in-process only** — multi-instance deployments would need more.
   - **Input floors + distributor fit** (`…-chamber-input-floors-design.md`): fits CAN go negative
     on legal inputs (H Kammer ≈ −3442 mm at x1=700/x2=1.8/x3=23, relations off) → 422 pre-build +
     live "! ≤ 0 mm" flag in the table; all dimensions bounded to (0, `CHAMBER_DIMENSION_MAX_MM`
     = 100 000] at API schema + form + constraint cells; builder guards (distFromEnd range, chamfer
     setbacks, axis-inside-corner); the radial fit check re-runs with the EXACT distributor mesh
     reach (blade tips ≈ 1.25 × ring radius — a big dMiddle used to carve through the wall).
   - **UX consistency** (`…-chamber-ux-consistency-design.md`): `--step` warnings merged deduped
     into warnings.json + silent cache-hit re-POST after STEP downloads refreshes panel/menu;
     loading a save clears ALL last-build state; failed Generate clears stale warnings; amber
     "inputs changed since this build" note in the Export card; grid explained in the table header;
     Min>Max refuses (422 + client-side pre-check).
   - **Minor polish** (`…-chamber-minor-polish-design.md`): saves P2025 → 404 / deleteMany;
     `--color-accent-strong: #8f4f00` token for small orange text (AA on white 6.4:1, on tint
     5.5:1) swapped into statuses/Low pill/warnings heading; CV error visible in the pill;
     sr-only badge explanations; STEP toast once per build+kind; `Cache-Control: immutable` on
     exports. **Deliberately declined**: 409→404 for unknown hashes, disk eviction, builder-version
     cache key, and the saves owner-cascade (Project/Template cascade identically — a product
     decision, not a chamber bug).

## 4. Verification state (2026-09-02)

- Geometry suite: **22/22** (~6 min; includes TE rounding, mirror-in-place, deferred-STEP policy,
  all refusal paths, no-tmp-leftovers).
- API: chamber 30, chamberModel 33, chamberSaves 8 — all green; concurrency tests prove the
  per-hash lock (2 parallel builds/downloads → 1 tool run).
- Web chamber suite: **64/64**; typecheck API+web clean.
- NOT verified on this box: `conversion.test.ts` / `meshes.test.ts` (pre-existing WSL environment
  failures, unrelated — see §0); in-browser/responsive pass of the full-width layout (dev server is
  user-managed).

## 5. Repo conventions (unchanged unless noted)

- `CLAUDE.md` frontend skill sequence applies to **UI (JSX/CSS) only**, not the Python builder.
  NOTE: those skills are not installed in recent sessions — the rules were applied manually
  (tokens only, AA, one orange CTA per zone).
- Log every code change as a **French** note at the bottom of `PLAN.md` (house rule from CLAUDE.md).
- Superpowers workflow: brainstorm → spec in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
  (committed before implementing) → implement test-first.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. On THIS branch the
  user asked for continuous commit+push per feature — keep doing that here, but don't carry the
  habit to other branches unasked.
- No secrets in commits: `apps/api/.env` (CHAMBER_PYTHON_BIN / MESH_PYTHON_BIN / OPENFOAM_BASHRC,
  and now optionally `MIRROR_STEP_SCRIPT`) is gitignored.
