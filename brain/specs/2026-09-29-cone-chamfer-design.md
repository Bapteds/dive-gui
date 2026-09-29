# Cone chamfer (With cone) — design

> **Status**: implemented (2026-09-29, WS-C; approved the same day with every OPEN question resolved with its recommended option, see the decision note at the end) · **Date**: 2026-09-29 · **Workstream**: WS-C (Chamber Creation v2, branch `feat/chamber-v2-cfd-loop`)
> **Area**: shared, backend, python (`apps/api/scripts/buildChamber.py`), frontend, tests
> **Related**: `brain/features/chamber-creation.md` §3.6, §3.7, §3.8, §3.9, §4.3, §5.1; `brain/playbooks/add-chamber-input-or-parameter.md`; `brain/playbooks/change-chamber-geometry.md`; `brain/specs/2026-08-11-chamfer-disable-toggle-design.md` (the corner Chamfer, a different feature); semi-spiral spec `2026-09-29-semi-spiral-casing-design.md` (its plank is tangent to the cone's outer circle, which this change does not touch).

## 1. Goal

In the **With cone** design, an optional 45° chamfer on the **top rim of the cone**, cut on the **inner** top edge of the cone wall so the mouth of the cone flares outward. The option has a size in mm (default 50) and is scaled by Part scale like the other part dimensions. It is off by default: existing builds, saves and hashes do not change.

## 2. User decisions (final, 2026-09-29)

| # | Decision |
|---|---|
| D1 | With cone only. |
| D2 | Checkbox **"Cone chamfer"**, key `coneChamferEnabled`, form default false, API default false. |
| D3 | Field **"Cone chamfer size (mm)"**, key `coneChamferSize`, default 50 mm, multiplied by `partScale` in the builder like the other part dimensions. |
| D4 | 45° chamfer on the top rim so the mouth flares outward, i.e. the inner top edge of the cone wall. |
| D5 | The new face belongs to `cylinder_walls`. |
| D6 | Refusals: size > wall thickness, size too long for the cone, collision with generator / dome / vanes / hub roof as relevant. |
| D7 | The keys enter the hash only when the option is on, in With cone. |
| D8 | No clash with the existing corner Chamfer (`chamferEnabled`). |

## 3. Current geometry (verified in code)

`make_part_hollow` (`buildChamber.py`), all in the part's local frame (base of the runner case at z = 0), after Part scale:

- `z_mid_top = h_first + h_middle` (LEB × Part scale).
- Cone = open-top **cup**: `outer` = cylinder of radius `R_out = d_last/2` from `z_mid_top` to `z_top = z_mid_top + hollow_len`, minus `bore` = cylinder of radius `R_in = d_last/2 − wall` from `z_mid_top + wall` to `z_top`. So the wall and the bottom are both `wall` thick, the inside depth is `hollow_len − wall`, and the top rim is a flat annulus `[R_in, R_out]` at `z_top`.
- Generator = cylinder of radius `c_dia/2` from `z_mid_top` (plus the dome, or pinned through the chamber top in Simplify generator), unioned with the cup.
- The whole part is **subtracted** from the chamber (`result = box.cut(part)`). The cup walls are therefore solid (non-fluid). The inside of the cup, between the generator and the cup wall, is fluid connected over the rim.

**Confirmed**: the cone is an open cup of wall thickness `wallThickness`. The "inner top edge" is the circle `r = R_in, z = z_top`. Chamfering it removes a ring of wall material with a right-isosceles triangular section (legs `c` radial and `c` vertical). The opening radius grows from `R_in` at `z_top − c` to `R_in + c` at `z_top`: the mouth flares outward at 45°. The fluid gains that volume.

## 4. Geometry definition

- `c = coneChamferSize × partScale` (metres). `wall` and `hollow_len` are scaled by the same factor, so every bound below is checked on the **unscaled** form values and holds at any Part scale.
- The flare is built as a solid of revolution and cut from the **cup only** (before the union with the generator):
  `flare = cq.Solid.makeCone(R_in, R_in + c + ε, c + ε, pnt=(0, 0, z_top − c), dir=(0, 0, 1))` with `ε = FLOOR_OVERCUT` (10 mm). The cutter runs 45° all the way and overshoots the rim top, so no coplanar face is left (the builder's usual overcut practice). Then `tube = tube.cut(flare)`.
- Why a revolved cutter and not an OCC `.chamfer()` on the edge: the selector-based edge chamfer fails when `c` equals the rim width (the flat face vanishes), and an edge selector on the unioned part is fragile. The cutter is exact for `0 < c ≤ wall` and is a no-op above the rim.
- **Size limits**:
  - `c ≤ wall`. At `c = wall` the flat rim disappears and the rim becomes a knife edge at `R_out`: see OPEN Q1.
  - `c ≤ hollow_len − wall` (the inside depth). Beyond it the flare would cut into the cup bottom. This is the exact form of the user's "size > cone length" refusal: the chamfer runs down the **inside** wall, whose height is Cone length minus Wall thickness.
- **Collisions (analysis)**: the chamfer only **removes** cup material inside the box `R_in ≤ r ≤ R_in + c ≤ R_out`, `z_top − c ≤ z ≤ z_top`. Consequences:
  - **Generator / dome**: they sit at `r ≤ c_dia/2`. Normally `c_dia/2 < R_in`, so the flare moves the wall **away** from them and a collision is impossible. When `c_dia > d_last − 2·wall` (already a builder WARN: "central diameter … exceeds the hollow bore"), the generator union refills part of the flare: the chamfer is partly hidden, with no invalid geometry. Nothing new needed (OPEN Q2).
  - **Vanes / hub roof**: they lie at `z ≤ z_mid_top`. The flare's lowest point is `z_top − c ≥ z_mid_top + wall`, thanks to the depth limit. A collision is impossible.
  - **Chamber walls, top, chamfer corners, feet, semi-spiral plank**: the outer radius `R_out`, the part height and the footprint are unchanged. Nothing new can stick out.
  So no collision refusal is needed beyond the two size limits.
- **Simplify generator**: it is compatible (the cup is identical, and the generator is only pinned through the top).
- **Corner Chamfer** (`chamferEnabled`, "Chamfer"): an independent feature (the chamber's two inlet-end corners). The new keys have the `cone` prefix; there is no shared code or key.

### 4.1 Prototype measurements (scratch copy of the builder, not committed; `hollow-vanes` fixture, Part scale 0.7944, so `R_in` = 1024.7 mm and `wall` = 39.7 mm scaled)

| Build | Result | Expected `ΔV = π·c²·(R_in + c/3)` |
|---|---|---|
| base (off) | OK, 153.091653 m³ (GOLDEN 153.090155) | |
| Cone chamfer 25 mm (`c` = 19.9 mm) | OK, watertight, patches = `VANE_PATCHES`, ΔV = **+0.0012774 m³** | 0.0012780 (−0.05 %) |
| Cone chamfer 50 mm = Wall thickness (knife edge, `c` = 39.7 mm) | OK, watertight, ΔV = **+0.0051426 m³** | 0.0051447 (−0.04 %) |

Patch check on both: **252 new 45° triangles** (|nz| and |n·r̂| ≈ 0.707), at r up to `R_in + c` and z just under the rim top, **all in `cylinder_walls`**. None are in `walls`, `hub`, `shroud` or `guide_vanes`. The volume change (≤ 3.4e-5 relative) is far below `VOL_RTOL` (5e-3), so the tests assert the delta, not a GOLDEN.

## 5. Changes per layer

### 5.1 Shared (`packages/shared/src/index.ts`)
- `export const CHAMBER_CONE_CHAMFER_SIZE_MM = 50;` next to `CHAMBER_WALL_THICKNESS_MM`.
- `ChamberInput.coneChamferEnabled?: boolean` with JSDoc: With cone only; a 45° chamfer on the inner top edge of the cone wall, so the mouth flares outward; geometry-only; default false.
- `ChamberInput.coneChamferSize?: number` with JSDoc: mm, both legs of the 45° chamfer, scaled by partScale; at most the Wall thickness and the cone's inside depth; default `CHAMBER_CONE_CHAMFER_SIZE_MM`; read only when `coneChamferEnabled` in With cone.
- `npm run build:shared`.

### 5.2 API
- `chamber.schemas.ts`: `coneChamferEnabled: z.boolean().default(false)` and `coneChamferSize: dimensionMm.optional()` (pattern: `wallThickness`), with comments.
- `chamber.service.ts` `resolveGeometryParams`, inside `if (variant === 'hollow')`:
  ```ts
  if (input.coneChamferEnabled) {
    params.coneChamferEnabled = true;
    params.coneChamferSize = (input.coneChamferSize ?? CHAMBER_CONE_CHAMFER_SIZE_MM) * MM_TO_M;
  }
  ```
  Nothing is written when the option is off or in Closed generator.
- The size bounds stay the builder's (OPEN Q3).

### 5.3 Builder (`apps/api/scripts/buildChamber.py`)
- Constant `CONE_CHAMFER_SIZE = 0.05` (m, default when the size is missing).
- `main()`, hollow block (unscaled validation, next to the Wall thickness and Cone length checks):
  - `cone_chamfer = None`;
  - if `bool(P.get("coneChamferEnabled", False))`, then `cone_chamfer = num_opt("coneChamferSize")`, falling back to `CONE_CHAMFER_SIZE` if absent;
  - `cone_chamfer <= 0` raises R0; `> wall + 1e-9` raises R1; `> hollow_len − wall + 1e-9` raises R2.
  - Stepped never reads the keys.
- Scaling: `cone_chamfer *= part_scale` with `wall` and `hollow_len`.
- `make_part_hollow(..., cone_chamfer=None)`: after `tube = outer.cut(bore)`, `if cone_chamfer: tube = tube.cut(flare)` (§4). Docstring updated.
- `classify` / vane labelling: **no change**. The conical face lies within `pocket_radius` of the axis, so it is `cylinder_walls` in BREP builds. In vane builds it is part of the `cylinder_walls` source (verified §4.1). `classify` counts only cylindrical faces, and a conical face does not change the count.
- No change to the height check, `rmax`, feet, vanes or STEP. The vane-less STEP carries the chamfer (OCC result). The vaned STEP cuts the distributor from the same `result`.

### 5.4 Web
- `chamberForm.ts`:
  - `ChamberFormValues.coneChamferEnabled: boolean`, `coneChamferSize?: number`;
  - schema `coneChamferEnabled: z.boolean()`, `coneChamferSize: optionalPositive`;
  - a `superRefine` rule, only when `variant === 'hollow' && coneChamferEnabled && coneChamferSize != null`. With `wall = wallThickness ?? CHAMBER_WALL_THICKNESS_MM`:
    - size > wall: "Must be at most the Wall thickness (50 mm)";
    - size > `hollowLength − wall` (when hollowLength is set): "Must be at most the inside depth of the cone (Cone length minus Wall thickness = 150 mm)";
  - `CHAMBER_FORM_DEFAULTS`: `coneChamferEnabled: false`, `coneChamferSize: CHAMBER_CONE_CHAMFER_SIZE_MM`;
  - `chamberInputToFormValues`: `?? CHAMBER_FORM_DEFAULTS.x` for both (old saves: off, 50).
- `ChamberInputsForm.tsx`, inside `variant === 'hollow'`, right after the "Simplify generator" checkbox, a checkbox copied from that block:
  - title "Cone chamfer";
  - description "Cut a 45° chamfer on the inside of the cone rim so its mouth flares outward.".
  When it is checked, the hollow grid shows, after "Wall thickness (mm)":
  `<Field label="Cone chamfer size (mm)" error=... helperText="Both legs of the 45° cut; at most the Wall thickness (default 50)"><Input type="number" step="any" {...register('coneChamferSize', { setValueAs: numOrUndef })} /></Field>`.
  Blank = 50 on the server. The flag is watched in `ChamberPage` and passed as a prop `coneChamferEnabled` (model: `simplifyGenerator`). Existing primitives only, so step 4 of the skill sequence is enough.
- `ChamberPage.tsx`: `FIELD_LABELS.coneChamferSize = 'Cone chamfer size'`; `watch` + prop.

## 6. Hash impact

| Body | Params added | Hash vs today |
|---|---|---|
| Closed generator, any cone-chamfer values | none | unchanged |
| With cone, `coneChamferEnabled` false or absent (any size) | none | **unchanged** |
| With cone, enabled | `coneChamferEnabled: true`, `coneChamferSize: <m>` | new key; a different size gives a different key; enabled + blank size = enabled + 50 |

## 7. Refusals and messages (exact texts)

Numbers are the form's unscaled values in whole mm (`_mm`). The API shows them as "Cannot build the chamber. …".

| Id | Layer | Condition (unscaled) | Message |
|---|---|---|---|
| R0 | Builder | size ≤ 0 (hand-fed params; zod already blocks it) | `Cone chamfer size must be greater than 0 mm. Untick Cone chamfer for a square cone rim.` |
| R1 | Builder (+ form, OPEN Q3) | size > Wall thickness | `Cone chamfer size (60 mm) is larger than the Wall thickness (50 mm): a 45° chamfer cannot be wider than the cone wall. Lower the Cone chamfer size to 50 mm or less, or increase the Wall thickness.` |
| R2 | Builder (+ form) | size > Cone length − Wall thickness | `Cone chamfer size (40 mm) is deeper than the inside of the cone: Cone length 80 mm minus Wall thickness 50 mm leaves 30 mm. Lower the Cone chamfer size to 30 mm or less, or lengthen the Cone length.` |

No collision refusal (§4, OPEN Q2). Form messages: see §5.4.

## 8. Patches

Unchanged list. With cone without vanes: `inlet, cylinder_walls, walls`. With vanes: `inlet, cylinder_walls, walls, hub, shroud, outlet, guide_vanes`. The conical chamfer face is in `cylinder_walls`.

## 9. Tests (test-first)

**Python** (`test_build_chamber.py`, overrides on the `hollow-vanes` fixture, no new GOLDEN):
1. `test_cone_chamfer_adds_the_flare_volume`: `{"coneChamferEnabled": true, "coneChamferSize": 0.025}` gives exit 0, watertight, manifest = `VANE_PATCHES`. `ΔV` vs the plain fixture = `π·c²·(R_in + c/3)` with `c = 0.025·ps`, `R_in = (dLast/2 − wallThickness)·ps`, within 3 %. Prototype error: 0.05 %.
2. `test_cone_chamfer_face_is_cylinder_walls`: in `trisurface.zip`, triangles with |nz| and |n·r̂| within 0.08 of 0.707, inside the band `R_in − 2 mm ≤ r ≤ R_in + c + 2 mm`, `z_top − c − 2 mm ≤ z ≤ z_top + 2 mm` (axis = outlet centre, `z_top = −H/2 − FLOOR_OVERCUT + ps·(hMiddlePlusFirst + hollowLength)`): more than 0 in `cylinder_walls`, 0 in every other patch; 0 in that band for the plain fixture.
3. `test_cone_chamfer_equal_to_the_wall_builds`: size 0.05 (= wall) gives exit 0 and watertight (the knife edge). Keep only if OPEN Q1 = (a).
4. `test_cone_chamfer_wider_than_the_wall_is_refused`: size 0.06 gives exit 1, `KO:`, `Cone chamfer size (60 mm) is larger than the Wall thickness (50 mm)`.
5. `test_cone_chamfer_deeper_than_the_cone_is_refused`: `{"hollowLength": 0.08, "coneChamferEnabled": true, "coneChamferSize": 0.04}` gives exit 1 and `is deeper than the inside of the cone`.
6. `test_cone_chamfer_is_ignored_on_closed_generator`: `stepped` + the two keys gives the GOLDEN volume (rel 1e-6 of the plain build).
7. Guard: all existing GOLDEN values **unchanged**.

**API** (`chamber.test.ts`, fake runner):
8. `keys the With cone build on the cone chamfer only when it is on`:
   - hollow + `coneChamferEnabled: false` + `coneChamferSize: 80` gives the same hash as plain hollow;
   - enabled gives a new hash; the spy sees `coneChamferEnabled: true`, `coneChamferSize: 0.05`;
   - enabled without size = enabled + 50 (same hash);
   - enabled 30 ≠ enabled 50;
   - the 12 outputs are unchanged.
9. `ignores the cone chamfer on Closed generator`: stepped + enabled gives the same hash as stepped.
10. `rejects a non-positive cone chamfer size`: 0 gives 422.

**Web**:
11. `chamberForm.test.ts`:
    - defaults (off, 50);
    - old saves load as off / 50;
    - round trip;
    - superRefine errors (size 60 with wall 50; size 40 with Cone length 80 and wall 50);
    - no error when the option is off or in Closed generator.
12. `ChamberInputsForm.test.tsx`:
    - the checkbox shows in With cone only;
    - the size field appears only when the checkbox is ticked;
    - submit carries `coneChamferEnabled: true, coneChamferSize: 50`.

## 10. GOLDEN impact

**None may move.** When off, `make_part_hollow` skips the cut (`if cone_chamfer:`), which is bit-identical. The new tests assert volume deltas, not new GOLDEN entries.

## 11. Cache purge

`buildChamber.py` changes, so purge `apps/api/storage/chamber/*` (dev) and `<STORAGE_DIR>/chamber/*` at deployment. Record it in the changelog.

## 12. Out of scope

- A chamfer on the outer top edge, a rounded (fillet) rim, or an angle other than 45°.
- A cone chamfer in Closed generator (no cone there).
- The known With cone gaps: no vane-less With cone pytest fixture, and the dome-apex sliver that makes the vane-less With cone STL non-watertight (known-issues §6). The tests use the vaned fixture.
- Any change to the corner Chamfer, the outputs table, or the viewer.

## 13. OPEN questions

- **OPEN Q1 (size equal to the wall)**:
  - (a) allow `size ≤ Wall thickness` (the user's proposal): at equality the rim becomes a knife edge; the prototype builds it cleanly (watertight, correct ΔV);
  - (b) require `size < Wall thickness`, leaving a flat rim (e.g. at least 1 mm), so the mesher never meets a zero-thickness lip.
  **Recommendation: (a)**, as proposed by the user. The build is sound, and a knife edge is a user choice.
- **OPEN Q2 (collision refusal)**: the analysis (§4) shows the inner flare cannot reach the generator, dome, vanes, hub roof or any chamber boundary.
  - (a) no collision refusal, keep the existing "central diameter exceeds the hollow bore" WARN (recommended);
  - (b) also refuse the chamfer when the Generator Ø reaches into the bore (`c_dia > dLast − 2·wall`), since the generator then hides part of the flare.
- **OPEN Q3 (where the size bounds are checked)**:
  - (a) builder (authoritative `KO:`) + web form `superRefine` for instant feedback (recommended, as written);
  - (b) also in the API zod `superRefine` (a 422 before starting CadQuery; a third copy of the same rule).
- **OPEN Q4 (field visibility)**:
  - (a) "Cone chamfer size (mm)" is shown only when "Cone chamfer" is ticked (recommended, same pattern as Simplify generator hiding the dome);
  - (b) always visible in With cone.

## 14. Implementation plan (ordered)

1. `docs:` commit of this spec (status approved).
2. Shared constant, fields and JSDoc, then `npm run build:shared`.
3. API tests 8 to 10 (red), then zod fields and `resolveGeometryParams` (green).
4. Python tests 1 to 7 (red), then builder: read and validate, scale, `make_part_hollow` cutter (green). Run the full geometry suite with `C:/cqv/Scripts/python.exe -m pytest apps/api/scripts/tests -q`.
5. Web tests 11 and 12 (red), then `chamberForm.ts`, `ChamberInputsForm.tsx`, `ChamberPage.tsx` (green).
6. Purge `apps/api/storage/chamber/*`; `npm run typecheck`, `npm run lint`, targeted suites.
7. Manual browser pass: With cone with and without vanes, sizes 25 / 50 / 60 (refused), Simplify generator on, old save loads with the option off.
8. Brain: changelog, `features/chamber-creation.md` (§3.6 or §3.7 rows, §3.8 R0 to R2, §3.9 note, §4.3 step 4, §4.7 old saves, §5.1 hash, §11 glossary), `vocabulary.md` ("Cone chamfer" vs "Chamfer"), codemaps (`api-scripts.md`, `root-shared-mcp.md`, `api-core.md`, `web-features-assemble-chamber.md`), `python brain/codemap/build-index.py`, `STATUS.md`.

## Decisions (2026-09-29)
The user accepted the recommended option for every OPEN question above (Q1 to Q4).
