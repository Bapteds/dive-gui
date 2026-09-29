# Semi-spiral casing option (Chamber Creation) — design

**Date:** 2026-09-29
**Status:** implemented (2026-09-29, WS-E). Handedness check: the spiral is mirrored (tool x → builder −X). Deviations noted in `brain/decisions.md` (plank back extension, ignored derived-row constraints, read-only Length row).
**Source material:** `documents/Semi-spiral-creation/SEMI_SPIRAL_TOOL_SPEC.md` (approved tool spec, 2026-09-22),
`documents/Semi-spiral-creation/reference_semi_spiral.py` (reference implementation).
**Related:** `brain/features/chamber-creation.md` (§3.6 to §3.9, §4.3, §5.1), `brain/playbooks/change-chamber-geometry.md`,
`brain/playbooks/add-chamber-input-or-parameter.md`, `brain/specs/2026-08-31-part-fit-refusals-design.md`.

## 1. Goal

Add a **Semi-spiral casing** checkbox to the Chamber Creation form, in both designs (Closed generator and With cone).
When it is checked:

- **The footprint changes.** Today it is the rectangle `B Kammer × Length` with two corner chamfers (`make_box`). It
  becomes the semi-spiral outline computed by the semi-spiral tool: 6 spiral lines plus the 3-line tongue/nose,
  extruded over **H Kammer**.
- **The builder adds a nose.** The nose (tongue) tip ends **200 mm** (not scaled) from the widest part of the machine,
  which is the runner case outer wall by default.
- **The builder adds a plank.** It is a straight slab running from the nose tip **tangent to the target circle**:
  - the target circle is the generator (Closed generator) or the cone (With cone);
  - it is **50 mm × Part scale** thick;
  - it runs from **LEB up to the ceiling**.
- **The nose and plank form a new `tongue` patch** (type `wall`).
- **Feet are not allowed with the spiral for now.** The form disables Feet and the API refuses Feet on.

Everything else is unchanged: the inner assembly, guide vanes, generator, cone, exports and the transfer to Meshing.

## 2. Verification of the reference tool

Run on 2026-09-29 on the Windows workstation, with the `C:/cqv` Python (numpy 2.5.3, scipy 1.18.1).

| Case | Width (spec) | Width (run) | Worst area error, limit = spec + 0.02 | Run | Deterministic (2 runs) | Wall clock |
|---|---|---|---|---|---|---|
| A (160°) | 6.05 | 6.05, not binding | 0.46 → ≤ 0.48 | **0.4613** at 237.5° | yes, byte-identical JSON | 47 s / 50 s (under load) |
| B (150°) | 6.15 binding | 6.15, binding | 0.57 → ≤ 0.59 | **0.5741** at 150° | yes | 70 s (under load) / 51 s |
| C (Ø2.92) | 6.90 binding | 6.90, binding | 0.63 → ≤ 0.65 | **0.6267** at 160° | yes | 88 s (under load) / 53 s |

All three cases pass tool spec §9.3. The findings below carry into the implementation:

1. **Vertices differ from the listed reference vertices.** This is the plateau effect the tool spec allows. The runs
   are deterministic on one scipy version, but not across versions. The builder therefore never re-optimises: it
   consumes frozen vertices (§8).
2. **Tool spec §9.2 is off by 4.6e-5 at 160°.** The correct V6 is (1.632246, −0.594089), not
   (1.632200, −0.594072). Our tests use the corrected value.
3. **Tool spec §9.4 is not reproduced.** With `max_width = 5.5` the reference returns a width-bound wall (5.50 m,
   worst error 1.23 m², 29 s) instead of raising. It only refuses when no valid wall exists. §10 sets the chamber
   policy for this case: build with a warning.
4. **Runtime:** 30 to 55 s per call on one idle core, and up to 90 s under contention. An infeasible case runs the
   optimiser twice.

**Conclusion: the optimisation runs in its own cached step, never inside the builder on every build (§8).**

## 3. Why a single builder phase (supersedes the 2026-09-22 brainstorm)

The 6-line spiral body is exactly a doubly chamfered box:
- L1 and L5 are the side walls;
- L3 is the chamfered end;
- L2 and L4 are the corner chamfers;
- the bottom opening V0 → V9 lies at one y and is the flat end.

The axis is the origin. Frame x maps to builder X and frame y to builder Y.

| Box output | From the spiral vertices |
|---|---|
| B Kammer (`width`) | `x4 − x_in` |
| Length | `y_top − foot_y` |
| B1 (`distFromSideChamfer1`) | `x4` |
| LT (`distFromEnd`) | `y_top` |
| LF1 / BF1 (chamfer 1, +X side) | `y_top − y4` / `x4 − x3` |
| LF2 / BF2 (chamfer 2, −X side) | `y_top − y1` / `x2 − x_in` |

Case A as run gives: B Kammer 6.05, Length 4.94, B1 2.00, LT 3.00, LF1 1.50, BF1 1.40, LF2 2.05 and BF2 2.00 m.

The previous two-phase plan (Exact overrides first, tongue later) is dropped, for four reasons:
- the nose and the plank cannot be expressed with box overrides;
- the overrides would need a 30 to 90 s optimisation to write eight Exact values into the user's table;
- five identities or refines would have to be switched off;
- the result would be fragile against later user edits.

The builder instead reuses `make_box` with the derived values above, then carves the nose and the plank. This keeps
the existing wall and chamfer fit checks and the inlet detection.

## 4. Inputs and mapping

The tool depends on `D_LE` and `clearance` only through `r_inner = D_LE/2 + clearance`. The chamber sets:

| Tool input | Chamber source |
|---|---|
| `Q` | Q_max (`x3`, m³/s) |
| `H_ch` | H Kammer Final (m) |
| `D_LE` | `2 × r_machine`, where `r_machine = max(dFirst, dMiddle, dLast) × Part scale / 2`. This is the widest part, the same `rmax` the builder uses. With the default ratios it is the runner case (`1.14703 × LE`). With vanes, WS-A refuses `dFirst < dLast − 5 mm`, so the runner case stays the widest part in practice. |
| `clearance` | 0.200 m, fixed, **not** scaled by Part scale |
| `max_width` | B Kammer Final (m). It is the width **limit**, driven by Exact / Max in the table. |
| `c_flow` | new form field **Casing flow velocity (m/s)** |
| `phi_start` | fixed 160° (not exposed) |

The nose tip radius is therefore `r_inner = r_machine + 0.2 m`.

New keys (permanent, internal):

| Key | Label | Type / range | Form default | API default | Visible |
|---|---|---|---|---|---|
| `semiSpiral` | Semi-spiral casing | bool | false | false | both designs; checkbox with a one-line description, Feet style |
| `spiralFlowVelocity` | Casing flow velocity (m/s) | 0.3 to 3 | 0.922 | 0.922 | only while `semiSpiral` is checked |

Old saves load `semiSpiral: false` and `spiralFlowVelocity: 0.922`, through `chamberInputToFormValues` fallbacks.

## 5. Geometry (builder)

The frame is the axis frame: frame x maps to X and frame y to Y. The z range is unchanged (`−H/2 … +H/2`, part
lowered by `FLOOR_OVERCUT`).

1. **Body.** Call `make_box(width, length, height, ch_big, ch_small, enabled=True)` with the §3 dimensions. The axis
   lands at `(target_x, target_y) = (W/2 − x4, L/2 − y_top)`, which is the existing formula. `chamferEnabled` is
   ignored (§6).
2. **Nose.** It is a prism over the full height (`−H/2 − FLOOR_OVERCUT … +H/2 + FLOOR_OVERCUT`), subtracted from the
   fluid.
   - Its polygon is V5 → V6 → V7 → V8, closed along the wall `X = x4` (in axis coordinates).
   - The tip V6 lies at `r_inner`, so it is 200 mm from the widest part.
   - V0.y = V9.y, so the inlet stays a single plane.
3. **Plank.** It is a solid slab subtracted from the fluid.
   - **Target circle:** radius `r_t = dLast × Part scale / 2`, centred on the axis. This is both the Closed-generator
     last cylinder and the cone outer wall.
   - **Line:** a straight segment from the nose tip `P = V6` to the tangent point `T` on the target circle. There are
     two tangents, at the angles `±acos(r_t / r_inner)` from OP. The builder takes the one whose direction
     `(T − P)` has the larger dot product with the L6 direction (V5 → V6), i.e. the tangent that continues the nose.
   - **Expected length:** 0.94 to 1.22 m (the three cases computed on 2026-09-29 give 1.029, 0.941 and 1.221 m).
   - **Footprint:** a rectangle `thickness = 0.05 × Part scale`, centred on the segment P → T. It is extended by
     `0.02 × Part scale` at both ends, into the nose and into the target part, so the boolean fuses (the same idea
     as `FOOT_PLANK_OVERLAP`).
   - **Height:** from `z_LEB = z_floor + h_first + h_middle` (scaled; this is the top of the distributor) up to
     `+H/2 + FLOOR_OVERCUT`, through the ceiling.
   - **Free edge above the part:** above the cone top (With cone) or above a typed Closed-generator height, the
     target circle is empty. The plank keeps the same footprint up to the ceiling and ends as a free edge in the
     fluid.
   - The plank starts at LEB, so it never touches the vanes. The nose tip keeps 200 mm from the widest part, so it
     clears the distributor.
4. **Assembly.** `fluid = body − part − nose − plank`, with no feet. Guide-vane builds keep their mesh pipeline, with
   `result` as the OCC fluid.
5. **Handedness.** In the mirrored frame the flow turns clockwise seen from +Z. This must match the swirl the
   guide-vane asset expects.
   - The implementation verifies it (§14, task 5).
   - If it is wrong, the builder mirrors the spiral (vertices X → −X, and the chamfer 1/2 roles swap), never the
     vanes.
   - "Change rotational direction" (mirrored STEP) mirrors everything together and keeps working.

## 6. Box parameters when the spiral is on

- **B Kammer:** the width limit of the spiral, with its normal statuses. The actual spiral width is shown with the
  spiral quality (§10).
- **Length, B1, LT, LF1, BF1, LF2, BF2:** read-only in the table. They show the spiral-derived values (§3) with the
  status **`from spiral`**; Min / Max / Exact editing is disabled on those rows.
  - The API exempts them from `nonPositiveChamberFinals` and from the Min > Max refusal.
  - The API answers with the derived values (in mm) in `outputs`, so the table can fill them in after Generate.
  - Before Generate, the rows show "from spiral" with no value.
- **Length override:** hidden and ignored.
- **Chamfer checkbox:** disabled and ignored. The spiral's L2/L4 are the corner cuts.
- **H Kammer, LEB, HLE, LE, generator, cone and vane inputs:** unchanged. H Kammer, Q_max, the parts' diameters,
  Part scale and B Kammer feed the spiral, so changing them re-optimises.

## 7. Inlet and patches

- **Inlet:** the spiral's bottom opening V0 → V9, the planar face at min Y (the full width `x4 − x_in` at `foot_y`).
  `classify()` detection is unchanged.
- **New patch `tongue`** (type `wall`) = every nose face plus every plank face.
  - **Emission order:** `inlet, outlet, cylinder_walls, walls, tongue` on the BREP path. On the vane path, `tongue`
    goes after `walls`.
  - **BREP path (`classify`):** a face is `tongue` when its tessellated centroid lies inside the XY footprint of the
    nose polygon or of the plank rectangle, within `PLANE_TOL`-scale tolerance. Horizontal ceiling and floor faces
    are excluded: only faces with `|nz| < 0.5` count, the same idea as `_blade_skin_mask`. This rule runs before the
    `pocket_radius` split.
  - **Vane path:** `tongue` is a voting source in `_label_by_nearest_source` (its OCC faces tessellated). The same
    exact footprint test then runs as a deterministic override, before the vane-skin override (the vane skin stays
    last).
  - **Everything downstream follows the patch name:** `PATCH_TYPES`, `manifest.json`, the GLB nodes,
    `trisurface.zip` (`tongue.stl`), the transfer to Meshing and the per-patch Meshing settings.
  - **No existing patch changes.** No build without the spiral ever emits `tongue`.

## 8. Where the optimisation runs: a separate cached step

- **New script** `apps/api/scripts/designSemiSpiral.py`. It ports the reference with numpy and scipy only (no
  CadQuery).
  - The area evaluator, the optimiser and the nose builder are separate functions.
  - Protocol: `python designSemiSpiral.py <in.json> <out.json>` prints `OK:` on success, or `KO:` with exit 1.
  - `WARN:` lines are passed through.
  - The interpreter is `CHAMBER_PYTHON_BIN`, which already ships scipy.
- **API service.** When `semiSpiral` is on, after `computeChamberOutputs` and the 422 checks:
  1. Compute the §4 inputs, in metres.
  2. `spiralHash` = SHA-1 of the sorted inputs plus an algorithm tag (`"ref-2026-09-22-seed5"`), truncated to 16 hex.
  3. Under `withChamberLock('spiral:' + spiralHash)`, read or produce
     `<STORAGE_DIR>/chamber-spiral/<spiralHash>/spiral.json`. The write is atomic (`.tmp` then rename).
  4. Put the result into `params.spiral`: the inputs, the ten vertices (m, axis frame) and the quality.
  5. Only then call `chamberHash(params)`, so the build key covers the actual geometry.
- **Builder.** It never optimises. It reads `P.get("spiral")`. When the value is missing, the box path is unchanged
  (old `params.json`). The `--step` pass re-feeds the same vertices.
- **Timeout:** `CHAMBER_SPIRAL_TIMEOUT_MS` (default 300,000 ms). A timeout gives 502 `CHAMBER_BUILD_FAILED` with a
  plain message.
- **Build response:** it carries `spiral: { widthMm, worstAreaErrorM2, atPhiDeg, widthBinding }`. The live table does
  not compute the spiral.
- **Cache purge:** the spiral cache is purged whenever `designSemiSpiral.py` or scipy changes. This is the same rule
  as the chamber cache (K29).

## 9. Hash keys

- **Added when the spiral is on:**
  - `semiSpiral: true`;
  - `spiral` (inputs + vertices).
- **Left out when the spiral is off:** `semiSpiral`, so existing builds keep their hashes.
- **Omitted when the spiral is on:**
  - `length`, `distFromSideChamfer1`, `distFromEnd`;
  - the four chamfer Finals;
  - `chamferEnabled`.
- **`spiralFlowVelocity`:** enters only through `spiral.inputs`.
- **Builder change:** the builder reads the box keys with `num()` today. Those reads move into the
  `spiral is None` branch.

## 10. Refusals and warnings

**API, 422 before any build:**
- `semiSpiral` with `feetEnabled` true: "The semi-spiral casing needs Feet off for now. Uncheck Feet, or uncheck
  Semi-spiral casing." The API default `feetEnabled` is `true`, so direct API callers must send `false`. The form
  unchecks and disables Feet while the spiral is checked.
- `spiralFlowVelocity` outside 0.3 to 3.

**Spiral step, 502 `CHAMBER_BUILD_FAILED` with the `KO:` text shown alone:**
- **degenerate spiral** (`r_inner ≥ R_cl(160°)`): "Q_max is too small for this H Kammer and runner case: the spiral
  would be narrower than the 200 mm gap around the turbine.";
- **no valid wall under B Kammer:** the message names the natural width as the lever ("Raise B Kammer to at
  least N mm").

**Warning (build delivered):** when the width limit binds, the build gets the warning "The semi-spiral casing is
limited by B Kammer (N mm): worst cross-section error X m² at Y°. Raise B Kammer to reduce it." It is persisted in
`warnings.json` like the others.

**Builder (`KO:`):**
- the part radius against the spiral walls and chamfer faces: the existing checks, run on the derived box;
- the tangent point missing because `r_t ≥ r_inner`: a guard, which cannot happen since `r_inner = rmax + 0.2`;
- the axis outside the polygon: a guard.

## 11. Tests

**Spiral module.** Plain Python, so it runs on Windows without CadQuery. The A/B/C cases are marked `slow`.
- Derived quantities (tool spec §9.1).
- Frame check with the **corrected** 160° value (§9.2).
- Cases A/B/C (§9.3): constraints, 0.05 m grid, width, and error ≤ spec + 0.02.
- Determinism: two runs give byte-identical JSON.
- Validation errors.
- `max_width = 5.5`: succeeds with `width_binding` and error ≈ 1.23 m².
- Golden vertices pinned to the tested scipy version.

**Geometry** (`test_build_chamber.py`, CadQuery). There are two new fixtures, each with **frozen vertices** in
`params.spiral`, so the geometry suite never optimises:
- **`stepped-spiral.json`:** a copy of `stepped-vanes` with `feetEnabled: false` and `semiSpiral: true`. Vertices were
  computed on 2026-09-29: r_machine 1.3886 m, width 4.40, error 0.431 m².
- **`hollow-vanes-spiral.json`:** a copy of `hollow-vanes`, same flags. r_machine 1.2210 m, width 4.75, error 0.300 m².

The assertions:
- exit 0, watertight STL, GOLDEN volumes;
- exact patch lists, including `tongue`;
- a single planar inlet at `foot_y`, of width `x4 − x_in`;
- the nose tip at r_machine + 200 mm (±1 mm);
- a section between LEB and the ceiling crosses the plank, and one in the vane band does not;
- plank thickness 50 mm × Part scale;
- the plank end touches the target circle;
- no `tongue` face is horizontal;
- Feet on + spiral is refused;
- an old `params.json` without `spiral` gives an unchanged volume.

**API** (`chamber.test.ts` and `chamberModel.test.ts`, with a fake spiral runner):
- the spiral step runs once per spiral hash (a vane-angle change reuses it) and runs under its lock;
- no `semiSpiral` gives the same hash as before;
- the box Finals do not re-key while the spiral is on;
- Feet on gives 422, and an out-of-range velocity gives 422;
- the box Finals are exempt from the refusals;
- the response carries the spiral quality and the derived values;
- the width-binding warning is persisted and replayed.

**Web:**
- the checkbox appears in both designs;
- checking it unchecks and disables Feet and Chamfer, hides Length, and shows Casing flow velocity;
- the derived rows are read-only with the `from spiral` status;
- the submitted body is correct;
- old saves load `semiSpiral: false`.

## 12. Out of scope

- **Legs / torque feet with the spiral.** They are not designed here, but nothing blocks them:
  - feet stay behind the refusal gate;
  - the fit checks run on the derived box plus the nose polygon, so a later foot-footprint check (point-in-polygon on
    the swung footprint) can plug in.
- The straight approach channel (tool spec: out of scope).
- A spiral preview endpoint or a live display.
- Exposing `phi_start` or the clearance.
- Changes to the spiral design rules.
- Any change to the 12 empirical outputs.

## 13. Decisions (user, 2026-09-29)

| # | Topic | Decision |
|---|---|---|
| 1 | Nose distance | 200 mm from the widest part of the machine (the runner case outer wall by default), **not** scaled by Part scale |
| 2 | Plank line | straight, from the nose tip, tangent to the generator (Closed generator) / cone (With cone) circle; the tangent that continues the nose |
| 3 | Plank section | 50 mm × Part scale thick, from LEB to the ceiling; free edge above the cone top or a typed generator height |
| 4 | Patch | new `tongue` patch (type `wall`) = nose + plank |
| 5 | Inlet | the spiral's bottom opening, the min-Y face; detection unchanged |
| 6 | Corner chamfers | the spiral's L2/L4 are the chamfers; the Chamfer checkbox is disabled and ignored |
| 7 | B Kammer too narrow | build + warning with the worst area error; refuse only when no valid wall exists |
| 8 | Casing flow velocity | form field, default 0.922 m/s, range 0.3 to 3 |
| 9 | Spiral start angle | fixed 160° |
| 10 | Length, B1, LT, chamfers | read-only derived values, status `from spiral` |
| 11 | Feet | the form disables Feet and the API refuses Feet on (422) |
| 12 | Override clash | measure from the widest part (`rmax`); WS-A refuses `dFirst < dLast − 5 mm` with vanes |
| 13 | Handedness | verified against the vane asset during implementation; the spiral is mirrored if needed, never the vanes |

## 14. Implementation plan

The spec and the plan go in a `docs:` commit first. Then work on a `feat/chamber-semi-spiral` branch, test-first at
each step.

1. **Spiral module.** Create `apps/api/scripts/designSemiSpiral.py`, a port of the reference plus a CLI.
   - Tests in `apps/api/scripts/tests/test_design_semi_spiral.py`, with golden JSONs under
     `tests/spiral_golden/` (§11, spiral module).
   - Add scipy to `requirements.txt` (K8).
2. **Shared contract.**
   - In `packages/shared/src/index.ts`: add `semiSpiral` and `spiralFlowVelocity` to `ChamberInput`;
     `CHAMBER_SPIRAL_FLOW_RANGE` (0.3 to 3, default 0.922); the spiral constants (clearance 0.2 m, 160°); and the
     derivation helper from vertices to the eight box values, used to fill the read-only rows.
   - Run `npm run build:shared`. Tests: `chamberModel.test.ts`.
3. **API.**
   - `chamber.schemas.ts`: fields, defaults and the Feet refusal in `superRefine`.
   - `chamber.service.ts`: exemptions, the spiral step (runner, cache dir, lock, timeout), `resolveGeometryParams`
     (omitted keys and `params.spiral`), and the response `spiral` + derived outputs.
   - `apps/api/src/lib/chamberStorage.ts`: the `chamber-spiral/` paths, confined by the storage helpers.
   - Config: `CHAMBER_SPIRAL_TIMEOUT_MS` in the env schema and `.env.example`.
   - Tests: `chamber.test.ts` (fake spiral runner) and `chamberSaves.test.ts` (snapshot normalisation).
4. **Builder.** In `apps/api/scripts/buildChamber.py`:
   - read `P.get("spiral")` and derive the box values;
   - build the nose prism and the plank (tangent helper);
   - add `tongue` to `PATCH_TYPES` / `PATCH_ORDER`, the `classify` footprint rule and the vane-path source + override;
   - move the box keys behind the spiral branch;
   - validate first, before the booleans;
   - emit the warning passthrough.
   Tests: the two fixtures `tests/params/stepped-spiral.json` and `hollow-vanes-spiral.json`, GOLDEN, and the §11
   geometry assertions. Then purge `apps/api/storage/chamber/*`.
5. **Handedness check.** Compare the spiral's swirl (clockwise from +Z) with the vane asset's opening direction
   (`guideVanes.json` and the blade orientation). Lock it with a pytest assertion; mirror the spiral if it disagrees.
6. **Web.**
   - `apps/web/src/features/chamber/chamberForm.ts`: values, schema, defaults, old-save fallbacks.
   - `ChamberInputsForm.tsx`: the checkbox, the velocity field, and disabling Feet / Chamfer and hiding Length.
   - `ChamberOutputsTable.tsx`: read-only rows with the `from spiral` status.
   - `ChamberPage.tsx`: `FIELD_LABELS` and showing the spiral quality.
   - `ChamberBuildWarnings.test.tsx` gets the new warning text.
   - Follow the UI skill sequence before any JSX.
   - Tests: `cd apps/web && npx vitest run src/features/chamber`.
7. **Verify.** Root typecheck and lint; the API chamber trio plus `meshing.test.ts`; the web chamber tests; the
   spiral tests on Windows; the geometry suite on WSL or in CI (CadQuery). The browser pass covers both designs, with
   and without vanes: viewer patch table, STEP / mirrored STEP, and "Send to Meshing" carrying `tongue.stl`.
8. **Brain.**
   - Changelog entry, recording both cache purges.
   - `features/chamber-creation.md`: §3.1, §3.6 to §3.9, §4.3, §5.1, §7, §11.
   - `architecture/storage-layout.md` (`chamber-spiral/`) and the env var docs.
   - Codemaps for the new script and its tests, then `python brain/codemap/build-index.py`.
   - `known-issues.md` §6: the semi-spiral thread is closed.
   - `decisions.md`: the §13 table.
   - This spec's status becomes `implemented`.
