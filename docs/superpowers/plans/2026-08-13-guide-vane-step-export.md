# Guide-Vane STEP Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `chamber.step` for guide-vane builds contain the true fluid geometry (blades + hub + shroud carved) as editable BREP, with an always-safe fallback and a UI signal when the fallback fires.

**Architecture:** An additive, isolated change to the guide-vane branch of `buildChamber.py` that builds a *parallel* OCC solid used only to write STEP; a one-time committed offline bake of a clean blade airfoil from the user's SolidWorks STEP; and a small `stepHasVanes` flag persisted per build and surfaced in the web export panel. The mesh pipeline (GLB/STL/edges/manifest/triSurface/classification and `fluid_F`) is unchanged and remains the meshing/viewer source of truth.

**Tech Stack:** Python (CadQuery / OCP / trimesh / numpy) for the builder and bake; Node/Express + TypeScript for the service/response; React + Vite + TypeScript for the UI; Vitest for API tests.

## Global Constraints

- **Do not alter the mesh pipeline.** `fluid_F`, `chamber.glb`, `chamber.stl`, `edges.bin`, `manifest.json`, `trisurface.zip`, and patch classification must stay byte-identical for existing builds. The OCC solid is built solely to write `chamber.step`.
- **Never fail the build over STEP.** Any OCC/reconstruction/gate failure falls back to today's vane-less STEP (`cq.exporters.export(result, …step)`) + a `WARN` to stderr, and sets `stepHasVanes:false`. Success/failure contract of `main()` is unchanged (`OK:`/exit 0 on success, `KO:`/exit 1 only on real build failure).
- **Editable BREP only** — the vane surfaces in STEP must be analytic/NURBS (no faceted mesh-in-STEP shell).
- **Guide-vane builds only.** Non-guide-vane and legacy (non-analytic) builds keep today's STEP behaviour untouched; `stepHasVanes` is `null` (not applicable) for them.
- **Nothing committed to git without explicit user request** (repo standing rule). Log each code change at the bottom of `PLAN.md` in French, matching the existing style.
- Builder runs in the WSL CadQuery env: `CHAMBER_PYTHON_BIN=/home/hristo/cadquery-env/bin/python`. Invoke via `wsl.exe -e bash 2>/dev/null -c '…'`.
- **Task 1 outcomes (decided empirically, now fixed for Task 3):**
  - **`VOL_TOL = 0.005`** (0.5 %). Faithful reconstruction matched `fluid_F` to 0.006 % (stepped) / 0.0005 % (hollow); 0.5 % is ~80× that margin and still catches gross failures (a missing shroud ≈ 2.8 %, a zero-volume revolve ≈ 2.9 %), backed by the valid-single-solid check.
  - **Boolean strategy: union-then-cut** (`result.cut(hub ∪ shroud ∪ blades)`), ~44–77 s per build — clean single valid solid for both variants.
  - **Revolve axis: on `Workplane("XZ")`, revolve the `(r,z)` profile about `(0,0,0)→(0,1,0)` (local Y = global Z), then `translate((cx,cy,0))`.** `(0,0,1)` is degenerate (zero volume) — this was the sole cause of the initial failures.
  - Both variants (stepped + hollow) produce a valid single solid matching `fluid_F` to <0.01 %.

## File Structure

- `apps/api/scripts/buildChamber.py` — MODIFY (guide-vane branch): build the OCC distributor, cut from `result`, volume-gate, write STEP from `occ_fluid` or fall back; write `build-meta.json`. New helpers kept local to the file.
- `apps/api/scripts/bakeVaneBladeProfile.py` — CREATE: one-time offline script; reads the SolidWorks blade STEP, isolates + aligns the blade, writes `assets/guideVanes_blade_profile.json`.
- `apps/api/scripts/assets/guideVanes_blade_profile.json` — CREATE (generated, committed): the clean airfoil section in asset frame + z-span + provenance.
- `apps/api/src/lib/chamberStorage.ts` — MODIFY: `build-meta.json` path + `readChamberBuildMeta(hash)`.
- `apps/api/src/modules/chamber/chamber.service.ts` — MODIFY: `ChamberBuildResult.stepHasVanes`; read meta after build/cache-hit.
- `packages/shared/src/index.ts` — MODIFY: add `stepHasVanes` to the build result/response type.
- `apps/web/src/lib/api/types.ts` — MODIFY: `ChamberBuildResponse.stepHasVanes`.
- `apps/web/src/pages/ChamberPage.tsx` — MODIFY: keep `stepHasVanes` from the build result; pass to the export panel.
- `apps/web/src/features/chamber/ChamberExportButtons.tsx` — MODIFY: show a note on the STEP button when `stepHasVanes === false`.
- `apps/api/tests/chamber.test.ts` — MODIFY: fake builder writes `build-meta.json`; assert the flag flows through.

---

### Task 1: Spike — prove the OCC distributor cut + volume gate (throwaway)

**Goal:** De-risk the OCC boolean and blade placement on real builds *before* building the feature. Decide `VOL_TOL` and the boolean strategy. **This task produces knowledge + committed decisions in this plan, not shipped code** — its scratch code is deleted at the end.

**Files:**
- Scratch only: a temporary env-gated block in `apps/api/scripts/buildChamber.py` (removed in the last step) and a scratch runner under the scratchpad dir.

**Interfaces:**
- Consumes: the in-scope guide-vane data in `main()` — `result` (OCC), `_core_prof`, `_cas_prof` (analytic `(r,z)` profiles), the placed blade meshes `vane_patches["guide_vanes"]`, `_prisms`, `fluid_F`, `target_x`, `target_y`, `z_mid_base`, `z_mid_top`, `d_last`.
- Produces: two numbers recorded in this plan — chosen `VOL_TOL` and the boolean strategy — plus a go/no-go on feasibility.

- [ ] **Step 1: Add a temporary env-gated OCC block** in the guide-vane branch of `main()`, just after `fluid_F` is computed (~[buildChamber.py:1428](../../../apps/api/scripts/buildChamber.py)), guarded by `if os.environ.get("CHAMBER_STEP_OCC_SPIKE"):`. In it:
  - Revolve `_core_prof` and `_cas_prof` about the axis with CadQuery:
    ```python
    def _occ_revolve(prof_rz, cx, cy):
        # prof_rz: list of (r, z); build the profile wire on XZ and revolve about Z, then translate to (cx,cy)
        pts = [(float(r), float(z)) for r, z in prof_rz]
        wp = cq.Workplane("XZ").polyline(pts).close()
        solid = wp.revolve(360.0, (0, 0, 0), (0, 1, 0))  # verify axis/pt in spike
        return solid.translate((cx, cy, 0))
    ```
    (The exact revolve axis args are confirmed by the volume check below — try `(0,0,0),(0,0,1)` vs `(0,0,0),(0,1,0)`; keep the one whose revolved hub radius matches `_core`'s.)
  - Build blades two ways to compare, both extruding straight across `[z_duct_bottom, z_mid_top + 2*FLOOR_OVERCUT]`:
    - (a) from the existing faceted `_prisms` footprints (guaranteed to match `fluid_F`), and
    - (b) from the placed STL blade section (`_vane_prisms`-style) — used only to confirm the placement transform, since Task 2 will swap in the clean airfoil at the same placement.
  - `occ_distributor = core.union(casing)` then union each blade; `occ_fluid = result.cut(occ_distributor)`. Also try the sequential-cut variant.
  - Print `occ_fluid.val().Volume()` vs `fluid_F.volume` (both m³), the relative error, `occ_fluid.val().isValid()`, and the solid count; export `occ_fluid` to `<out>/_spike/occ_fluid.step`.

- [ ] **Step 2: Run the spike on 2–3 representative cached builds** (stepped+vanes, hollow+vanes, and one with a non-default `dMiddle`). For each, generate its params by driving `POST /chamber/build` inputs through `resolveGeometryParams` (or reuse a cached `params.json`) and run:
  ```bash
  wsl.exe -e bash 2>/dev/null -c 'CHAMBER_STEP_OCC_SPIKE=1 /home/hristo/cadquery-env/bin/python /mnt/c/.../buildChamber.py <params.json> <outDir>'
  ```
  Record the relative volume error and whether `occ_fluid` is a single valid solid, for both boolean strategies.

- [ ] **Step 3: Eyeball the STEP** — open `_spike/occ_fluid.step` in FreeCAD; confirm the vanes/hub/shroud are present and faces are analytic/NURBS (not triangles).

- [ ] **Step 4: Record decisions in this plan.** Set `VOL_TOL` to comfortably cover the observed error (e.g. if errors are ≤0.3 %, set `VOL_TOL = 0.01`). Choose union-then-cut unless it proved fragile, in which case sequential. If the boolean cannot be made to produce a valid solid on any representative build, **stop and escalate to the user** — the feature is not viable as specified.

- [ ] **Step 5: Delete all spike code** from `buildChamber.py` and remove the scratch runner. Confirm `git diff apps/api/scripts/buildChamber.py` is empty.

---

### Task 2: Offline bake of the clean blade airfoil

**Files:**
- Create: `apps/api/scripts/bakeVaneBladeProfile.py`
- Create (generated): `apps/api/scripts/assets/guideVanes_blade_profile.json`
- Reference: `apps/api/scripts/assets/guideVanes.json` (`pivotRadius`, `height`, `bladeBottomZ`), `apps/api/scripts/assets/guideVanes_blade.stl` (alignment target)

**Interfaces:**
- Consumes: the user's blade STEP at `C:\Users\Hristo.Dimitrov\Desktop\Empirical Relation\guide vanes\GuideVanes50Deg.STEP` (contains the blade as shell 1 + hub/shroud as shell 0; blade shell matches the STL at `r∈[0.700,1.034] m`, height `0.557 m`, azimuth span `15.9°`, differing from the asset frame by a Z-rotation + `+0.425 m` Z-shift, radius identical).
- Produces: `assets/guideVanes_blade_profile.json` = `{ "sectionZAsset": <float>, "airfoil": [[x,y],…] (asset metres, closed loop), "zSpanAsset": [zmin,zmax], "provenance": "...", "maxDevM": <float> }` consumed by Task 3.

- [ ] **Step 1: Write the bake script.** `bakeVaneBladeProfile.py <stepPath> <bladeStl> <outJson>`:
  - Load the STEP (`cadquery.importers.importStep`); tessellate each shell; identify the **blade shell** as the one whose radius range, height, and azimuth span match the STL blade (NOT by index). Assert exactly one matches.
  - Load `guideVanes_blade.stl` (trimesh). Compute the alignment mapping the STEP blade onto the asset blade as `(Δθ about Z, Δz)` — a 2-parameter fit (radius is already identical): `Δz = stl.z.min() − step.z.min()`; `Δθ` = minimize point-set distance over θ (coarse grid then refine). Apply it to the STEP blade points/faces.
  - **Assert** the aligned STEP blade overlays the STL within tolerance: nearest-point max deviation `maxDevM ≤ 2e-3` m. If not, exit non-zero with the deviation (fail loudly — the STEP is not the STL's source).
  - Section the aligned blade shell at mid-height (`sectionZAsset = (zmin+zmax)/2`) to a clean 2D airfoil loop; densify only if a segment exceeds ~2 mm; store as ordered `[x,y]` in asset metres. Record `zSpanAsset`.
  - Write the JSON with a `provenance` string (source filename + date + `maxDevM`).

- [ ] **Step 2: Run the bake** in the CadQuery env and confirm the assertion passes:
  ```bash
  wsl.exe -e bash 2>/dev/null -c '/home/hristo/cadquery-env/bin/python /mnt/c/.../bakeVaneBladeProfile.py "/mnt/c/Users/Hristo.Dimitrov/Desktop/Empirical Relation/guide vanes/GuideVanes50Deg.STEP" /mnt/c/.../assets/guideVanes_blade.stl /mnt/c/.../assets/guideVanes_blade_profile.json'
  ```
  Expected: prints `maxDevM` below 2 mm and writes the JSON.

- [ ] **Step 3: Sanity-check the JSON** — the airfoil loop is closed, lies at the pivot radius (~0.867 m from axis), and has a plausible chord. Commit the JSON as a generated asset (only when the user asks to commit).

---

### Task 3: OCC distributor + STEP in the builder

**Files:**
- Modify: `apps/api/scripts/buildChamber.py` (guide-vane branch of `main()`, ~[1315-1612](../../../apps/api/scripts/buildChamber.py)); add local helpers near the other vane helpers.

**Interfaces:**
- Consumes: `guideVanes_blade_profile.json` (Task 2); the in-scope `result`, `_core_prof`, `_cas_prof`, blade placement params (`s`, `pivotRadius`, `theta0`, `vane_pitch`, `bladeAngleStepDeg`, `target_x/y`, `z_mid_base`, `z_mid_top`, `z_duct_bottom`), `fluid_F`; `VOL_TOL` + boolean strategy from Task 1.
- Produces: `exports/chamber.step` (vane-carved BREP or vane-less fallback) and `build-meta.json` = `{"stepHasVanes": true|false}` in the build dir.

- [ ] **Step 1: Load the baked airfoil** once (module-level, like `_load_vane_meta`): `_load_vane_blade_profile()` returns the airfoil points + `sectionZAsset` + `zSpanAsset`, or `None` if the asset is absent (→ fallback).

- [ ] **Step 2: Add `_occ_distributor(...)`** building the OCC solid: revolve `_core_prof` (hub core) and `_cas_prof` (shroud casing) about `(target_x, target_y)` (axis args as confirmed in Task 1); for each of the `bladeCount` blades, place the clean airfoil by the same XY transform chain the mesh path uses (scale `s` about the asset origin → translate to `(cx,cy)` → pitch `vane_pitch` about the spindle → ring-rotate `k·bladeAngleStepDeg` about the axis), then `extrude` across `[z_duct_bottom, z_mid_top + 2*FLOOR_OVERCUT]`. Union (or sequential-cut, per Task 1). Reproduce the mesh path's overlaps so no faces are exactly coincident.

- [ ] **Step 3: Add `_occ_fluid_or_none(result, distributor, fluid_F, vol_tol)`** — perform `result.cut(distributor)`, then accept only if the outcome is a single valid closed solid AND `abs(vol − fluid_F.volume)/fluid_F.volume ≤ vol_tol`; else return `None`. Wrap in try/except; return `None` on any exception.

- [ ] **Step 4: Wire it into the export block** ([buildChamber.py:1590-1598](../../../apps/api/scripts/buildChamber.py)). Replace the guide-vane STEP write with:
  ```python
  step_has_vanes = False
  if guide_vanes:
      occ_fluid = None
      profile = _load_vane_blade_profile()
      if profile is not None:
          try:
              dist = _occ_distributor(cq, result, _core_prof, _cas_prof, profile, <placement args>)
              occ_fluid = _occ_fluid_or_none(result, dist, fluid_F, VOL_TOL)
          except Exception as exc:  # noqa: BLE001
              sys.stderr.write("WARN: OCC vane STEP reconstruction failed: %s\n" % exc)
      if occ_fluid is not None:
          cq.exporters.export(occ_fluid, os.path.join(exports_dir, "chamber.step"))
          step_has_vanes = True
      else:
          sys.stderr.write("WARN: STEP falls back to the vane-less solid (no vanes carved)\n")
          cq.exporters.export(result, os.path.join(exports_dir, "chamber.step"))
  else:
      cq.exporters.export(result, os.path.join(exports_dir, "chamber.step"))
  ```
  (The non-guide-vane path is exactly today's behaviour.)

- [ ] **Step 5: Write `build-meta.json`** in the export block, **only for guide-vane builds**: `{"stepHasVanes": step_has_vanes}`. Non-vane builds write no meta file.

- [ ] **Step 6: Verify geometry** (Python, real CadQuery — the TS suite cannot). Build the same 2–3 representative guide-vane chambers used in Task 1 via the real builder and assert: STEP volume matches `fluid_F` within `VOL_TOL`, `build-meta.json` has `stepHasVanes:true`, and the STEP opens in FreeCAD with smooth NURBS blades. Confirm a stepped (non-vane) build's STEP + all other artifacts are byte-identical to before (hash a pre/post build dir).

---

### Task 4: Persist + expose `stepHasVanes` through the API

**Files:**
- Modify: `apps/api/src/lib/chamberStorage.ts`
- Modify: `apps/api/src/modules/chamber/chamber.service.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `build-meta.json` (Task 3).
- Produces: `ChamberBuildResult.stepHasVanes: boolean | null` returned by `buildChamber()` (and thus the `POST /chamber/build` response), on both fresh builds and cache hits.

- [ ] **Step 1: Storage — meta path + reader.** In `chamberStorage.ts` add `BUILD_META_NAME = 'build-meta.json'`, include `buildMeta` in `ChamberPaths`, and add:
  ```ts
  /** Read the per-build meta ({ stepHasVanes }), or null when absent (non-vane builds). */
  export async function readChamberBuildMeta(hash: string): Promise<{ stepHasVanes: boolean } | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(chamberPaths(hash).buildMeta, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'stepHasVanes' in parsed &&
        typeof (parsed as Record<string, unknown>).stepHasVanes === 'boolean'
      ) {
        return { stepHasVanes: (parsed as { stepHasVanes: boolean }).stepHasVanes };
      }
      return null;
    } catch {
      return null;
    }
  }
  ```

- [ ] **Step 2: Shared type.** In `packages/shared/src/index.ts`, add `stepHasVanes: boolean | null` to the chamber build result type (mirrored by the web type in Task 5). Document: `true`/`false` for guide-vane builds (false = STEP omitted vanes via fallback); `null` = not a guide-vane build.

- [ ] **Step 3: Service.** In `chamber.service.ts`, add `stepHasVanes: boolean | null` to `ChamberBuildResult`. After the build/cache-hit resolves, `const meta = await readChamberBuildMeta(hash);` and return `{ hash, outputs, stepHasVanes: meta?.stepHasVanes ?? null }`. (Works on cache hits because it reads the persisted meta, not the build run.)

- [ ] **Step 4: Typecheck** `packages/shared` + `apps/api` clean.

---

### Task 5: Surface the fallback in the web UI

**Files:**
- Modify: `apps/web/src/lib/api/types.ts`
- Modify: `apps/web/src/pages/ChamberPage.tsx`
- Modify: `apps/web/src/features/chamber/ChamberExportButtons.tsx`

**Interfaces:**
- Consumes: `ChamberBuildResponse.stepHasVanes` from `POST /chamber/build`.
- Produces: a note on the STEP download when `stepHasVanes === false`.

- [ ] **Step 1: Web type.** Add `stepHasVanes: boolean | null;` to `ChamberBuildResponse` in `types.ts`.

- [ ] **Step 2: Page state.** In `ChamberPage.tsx`, add `const [stepHasVanes, setStepHasVanes] = useState<boolean | null>(null);`, set it in the build `onSuccess` (`setStepHasVanes(res.stepHasVanes)`), reset to `null` alongside `setHash`, and pass `stepHasVanes={stepHasVanes}` to `<ChamberExportButtons>`.

- [ ] **Step 3: Export panel.** In `ChamberExportButtons.tsx`, accept `stepHasVanes: boolean | null`. When `stepHasVanes === false`, render a small note beneath the buttons (tokens only, brand orange accent), e.g. *“STEP omits the guide vanes for this build (CAD fallback).”* Do not disable the button. No note when `null`/`true`.

- [ ] **Step 4: Verify in the app.** Run the web app; a guide-vane build whose meta says `false` shows the note; a normal build shows nothing. (Use `superpowers:run` / the browser preview.) Typecheck + eslint `apps/web` clean.

---

### Task 6: Tests, regression, and changelog

**Files:**
- Modify: `apps/api/tests/chamber.test.ts`
- Modify: `PLAN.md` (French changelog entries)

**Interfaces:**
- Consumes: the fake builder harness already in `chamber.test.ts` (it writes the artifacts the real builder would).

- [ ] **Step 1: Fake builder writes meta.** Extend the test's fake builder so that when the params contain `guideVanes: true` it also writes `build-meta.json` (`{ stepHasVanes: true }` by default; a dedicated case writes `false`). Keep non-vane builds writing no meta file.

- [ ] **Step 2: Flag-flow tests.** Add cases asserting: a guide-vane build returns `stepHasVanes: true`; a fallback case returns `false`; a non-vane build returns `stepHasVanes: null`; and the flag is returned on a **cache hit** (second identical `POST /build` without re-running the builder).

- [ ] **Step 3: Run the API suite** (`fileParallelism:false`, `testTimeout:20000`): `pnpm --filter @dive/api test` — all green, including the existing chamber/mesh/meshing suites (regression).

- [ ] **Step 4: Full gate.** Typecheck (shared+api+web) + eslint clean across the repo.

- [ ] **Step 5: Log in `PLAN.md`.** Append French changelog entries (matching the existing style) for: the OCC guide-vane STEP export + volume gate + fallback, the offline blade-profile bake asset, and the `stepHasVanes` UI signal. Mark as *Non commité en attente de revue app*.

---

## Notes on verification split

- **Geometry correctness** (volume match, valid BREP, smooth vanes) is verified **only** by the Python checks in Tasks 1, 2, and 3 run in the WSL CadQuery env — the Vitest suite uses a fake builder and cannot exercise real geometry.
- **Flag plumbing** (service → response → shared type → UI, incl. cache-hit) is covered by the Vitest suite (Task 6) and the manual app check (Task 5).
- **No-regression** for the mesh pipeline is enforced by the byte-identical checks (Task 3 Step 6) plus the existing suites (Task 6 Step 3).
