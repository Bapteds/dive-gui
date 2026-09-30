# Feature · Chamber Creation

> **Status**: in production · **Updated**: 2026-09-29 (guide vane count: any whole number 8 to 32; guide vane count 16 or 18; guide-vane pocket vs Runner case Ø: refusal, 5 mm snap, junction labels; generator minimum with dome; readable error messages)
> **Specs**: `brain/specs/2026-08-03-guide-vane-throat-design.md`, `2026-08-06-outlet-x1-ratio-design.md`, `2026-08-10-hub-shroud-x1-adaptation-design.md`, `2026-08-11-chamfer-disable-toggle-design.md`, `2026-08-11-stepped-last-cylinder-through-top-design.md`, `2026-08-11-chamber-to-meshing-transfer-design.md`, `2026-08-13-guide-vane-step-export-design.md`, `2026-08-31-chamber-fullwidth-and-saved-builds-design.md`, `2026-08-31-part-fit-refusals-design.md`, `2026-08-31-vane-te-rounding-design.md`, `2026-09-01-chamber-cache-integrity-design.md`, `2026-09-01-chamber-input-floors-design.md`, `2026-09-01-chamber-minor-polish-design.md`, `2026-09-01-chamber-ux-consistency-design.md`, `2026-09-01-deferred-vane-step-design.md`, `2026-09-01-empirical-50mm-rounding-design.md`, `2026-09-01-mirrored-step-download-design.md`, `2026-09-02-chamber-vocabulary-design.md`, `2026-09-02-generator-dimensions-design.md`, `2026-09-02-physical-input-names-design.md`, `2026-09-02-simplify-generator-design.md`, `2026-09-29-vane-pocket-runner-case-design.md`, `2026-09-29-guide-vane-count-design.md` (all under `brain/specs/`) · related plans under `brain/plans/`
> **Codemaps**: `brain/codemap/root-shared-mcp.md` (model, Gen Dim v3, `ChamberInput`), `brain/codemap/api-core.md` (`chamber` module, saves, Prisma), `brain/codemap/api-lib.md` (`chamberStorage`), `brain/codemap/api-scripts.md` (`buildChamber.py`, `mirrorStep.py`, assets, pytest), `brain/codemap/api-tests.md` (`chamber*.test.ts`, `meshing.test.ts`), `brain/codemap/web-features-assemble-chamber.md` (`features/chamber/*`), `brain/codemap/web-core.md` (`pages/ChamberPage.tsx`, `lib/api/chamber*.ts`)
> **Other references**: `brain/conventions/vocabulary.md` (naming rules, read it BEFORE touching a label), `brain/assets/chamber-parameter-map.html` (map of the 12 parameters and their relations, "model v2" state of 2026-08-04: covers neither Gen Dim v3 nor the geometric options), `brain/architecture/storage-layout.md`.

## 1. Purpose

Chamber Creation generates the parametric geometry of a turbine chamber (the fluid volume around the runner) from four physical quantities: **Runner Ø**, **Head**, **Q_max** and, optionally, **Power**. An empirical model (in `@dive/shared`) derives 12 dimensions from them, a CadQuery builder (`apps/api/scripts/buildChamber.py`) builds the fluid solid, splits it into **named OpenFOAM patches**, produces a 3D preview and exports (STL, STEP, mirrored STEP, zipped triSurface), then the build can be **transferred to a Meshing session**. Form inputs can be stored as shared **saved builds**.

**Global** tool (not tied to a project), route `/chamber`, available to any authenticated user. Builds are shared by the whole team (cache indexed by a hash of the parameters). Saves are visible to and loadable by everyone; only the author or a `SUPER_ADMIN` can overwrite, rename or delete them.

## 2. User journey

### 2.1 Location and layout
- Navigation entry "Chamber Creation" (icon `Box`), route `/chamber` lazy-loaded. **Full-width** page (opt-out of `max-w-content` in `AppShell`).
- Header: title "Chamber Creation" + `ChamberSavesMenu` (saves dropdown, Save button, "Saved build actions" menu: Rename / Duplicate / Delete).
- Grid `lg:grid-cols-[minmax(22rem,1fr)_2.5fr]`:
  - left column: `ChamberInputsForm` (single orange CTA button "Generate chamber"), then the **Export** card (`ChamberExportButtons` + secondary button "Send to Meshing");
  - right column: `ChamberViewer` (3D preview colored by patch, reuses `MeshScene` and `PatchTable` from Visualize).
- Below the grid: `ChamberBuildWarnings` (red "Build errors" block, orange "Build warnings" block) then `ChamberOutputsTable` (table of the 12 parameters, columns Parameter, Model, Min, Max, Exact, Final, Status, Confidence; collapsible "Dimension reference" legend with the drawing `assets/chamber-dimensions.png`).

### 2.2 Steps
1. Enter Runner Ø, Head, Q_max (defaults 1450 / 7.85 / 8), choose the **Design** ("Closed generator" or "With cone"), the options (Structural relations, Guide vanes, Chamfer, Feet) and any overrides. The parameter table is recomputed **live** on the client (`computeChamberOutputs`), with no network call.
2. Edit Min / Max / Exact in the table as needed (page-local `constraints` state, not in react-hook-form).
3. **Generate chamber**: `POST /chamber/build`. On success: hash kept, viewer loaded, exports and "Send to Meshing" enabled, toast "Chamber generated." (or `toast.warning` if the builder emitted warnings).
4. Download STL, STEP (or a STEP menu with "Download STEP" / "Change rotational direction" for a build with vanes), "OpenFOAM triSurface".
5. "Send to Meshing": three-mode dialog (new session, existing session, copy of a session's setup), then navigation to `/meshing/<id>`.
6. Optional: Save / Load / Rename / Duplicate / Delete of a saved build.

### 2.3 Key states and messages
- Viewer: no hash (prompt "Enter Runner Ø, Head and Q_max plus a length, then Generate…"), no WebGL, manifest loading or in error, no patches, geometry loading or in error (collapsible `ApiError` details).
- Build: button in `loading` during the mutation. Any error (server refusal 422/502, invalid form, Min > Max detected on the client) appears **both** in the "Build errors" block and as a toast; the previous build's warnings are cleared on failure.
- Table: a Final ≤ 0 (except `noEffect`) is shown in red with `! ≤ 0 mm` ("not buildable"); inline `! min>max` status; `refined` and `no effect` badges (doubled by `sr-only` text); confidence pill with the CV error visible (none, shown as "-", on the BF1 / BF2 rows, which copy LF1 / LF2, and on the spiral-derived rows) (e.g. "Low · 38.9 %").
- Export card: amber note `role="status"` "Inputs changed since this build…" when the form has drifted from the last build (downloads stay active, they serve the old geometry).
- First STEP (or mirrored) download of a build with vanes: info toast "Preparing the STEP export…" (once per kind and per hash).

## 3. Business rules and invariants

### 3.1 Inputs
See also `brain/conventions/vocabulary.md` §1: **renames = display only**, internal keys never change.

| Key | Displayed label | Unit | Bounds (form + API) | Form default | Role |
|---|---|---|---|---|---|
| `x1` | Runner Ø (mm) | mm | 700 to 2420 (`CHAMBER_INPUT_RANGES`) | 1450 | Input of the empirical model; also gives `outletOuterD` (outer diameter of the vane outlet) and is used in Gen Dim v3. |
| `x2` | Head (m) | m | 1.8 to 14.9 | 7.85 | Input of the empirical model and of Gen Dim v3. |
| `x3` | Q_max (m³/s) | m³/s | 1 to 23 | 8 | Input of the empirical model and of Gen Dim v3. |
| `x4` | Power (kW) | kW | > 0, ≤ `CHAMBER_X4_MAX` (100,000); optional | empty (auto) | **Gen Dim v3 only** (With cone variant). Empty = `0.9 · 9.81 · Head · Q_max`. **Never** passed to the builder or to the hash. Field shown only in With cone. |

The X1..X3 bounds are the training range of the regressions; the server (zod `chamberBuildSchema`) and the form (`chamberFormSchema`) both enforce them. Form message: "Must be between 700 and 2,420 mm (the range the model was fitted on)".

### 3.2 The 12 derived dimensions (empirical model)
Single source: `CHAMBER_OUTPUT_SPECS` in `packages/shared/src/index.ts` (full-precision coefficients, complete table in `brain/codemap/root-shared-mcp.md`). Each output has its own X1..X3 fit (`linear`: a + b·X1 + c·X2 + d·X3, or `power`: k·X1^e1·X2^e2·X3^e3) and possibly a toggleable **structural relation**.

| Key | Label | Relation (all `defaultOn: true`) | Type |
|---|---|---|---|
| `width` | B Kammer | refine from the Exact of `distFromSideChamfer1` | refine |
| `height` | H Kammer | `= LEB + LEOW` | combination (identity) |
| `distFromSideChamfer1` | B1 | refine from the Exact of `width` | refine |
| `chamferLength1` | LF1 | none | |
| `chamferWidth1` | BF1 | `= LF1` (**permanent**, not toggleable) | identity |
| `chamferLength2` | LF2 | `= LF1` | identity |
| `chamferWidth2` | BF2 | `= LF2` (**permanent**, not toggleable) | identity |
| `distFromEnd` | LT | `= LF1 + LF2` | identity |
| `dLast` | LE (Durchmesser) | `= f(HLE)` = 255.16 + 3.4954 × HLE | **empirical** combination (`empirical: true`) |
| `hMiddle` | HLE | none | |
| `hMiddlePlusFirst` | LEB | `= 2 × HLE` | identity |
| `hLast` | LEOW | none | |

**Computation chain** (`computeChamberOutputs`):
1. Master switch `relationsMaster` (default true): `false` turns off all toggleable relations (hard override). Otherwise each relation follows `relations[key] ?? defaultOn`. **Corner chamfers always at 45°** (since 2026-09-30, spec `2026-09-29-corner-chamfer-45-design.md`): BF1 = LF1 and BF2 = LF2 are `permanent: true` relations, always on whatever `relationsMaster` / `relations` say, and any Min / Max / Exact on BF1 / BF2 is ignored (Final copied from LF, `userDriven` inherited). They are listed in `CHAMBER_PERMANENT_RELATION_KEYS` and left out of `CHAMBER_RELATIONS`, so the relations menu has 7 entries ("Configure relations (n/7 on)"). LF2 = LF1 stays toggleable. With Semi-spiral casing the four chamfer rows still come from the spiral (`from spiral`, not 45°).
2. **Pass 1**: outputs without a relation, with the relation off, or with a `refine` relation (which reads the partner's **entered Exact** in `constraints`, not its Final; without a partner Exact, falls back to the base fit, `refined: false`).
3. **Pass 2**: active `combination` relations, resolved to a fixed point (LEB before H Kammer); they read the partners' **Final**, so an override propagates.
4. Each value goes through the 50 mm rounding (§3.4) then through Min / Max / Exact (§3.3).
5. `hLast` (LEOW) gets `noEffect` if the `height` relation is inactive or if `height` has an Exact: the builder never reads LEOW directly (the last stepped cylinder is pinned through the ceiling, the With cone variant ignores it).

The geometric options (§3.7) **never** influence the 12 outputs. A chamber too small for its parts is **refused** by the builder (§3.8), by design (user decision 2026-09-28).

### 3.3 Min / Max / Exact constraints and statuses
- `ChamberConstraint { min?, max?, exact? }` per output; each value must be `> 0` and `≤ CHAMBER_DIMENSION_MAX_MM` (100,000 mm). In the table, `NumCell` only accepts `0 < v ≤ 100,000`; any other entry clears the constraint.
- Precedence: **Exact** wins (`set exact`); otherwise Min > Max gives `! min>max` and keeps the model value; otherwise clipping (`capped at max`, `raised to min`); otherwise `within range` (fit) or `from relation` (with `relationLabel`).
- **BF1 / BF2 take no constraint** (since 2026-09-30): their table rows are read-only (Min / Max / Exact show "-", screen-reader text "BF1 exact: read-only, always equals LF1"), status "= LF1" / "= LF2"; the model ignores BF constraints sent by the API or kept in old saves, and loading a save drops them (`chamberInputToConstraints`) along with the BF relation toggles (`chamberInputToFormValues`). Old saves with a BF Exact or a disabled BF relation now build at 45° (new key, intended).
- `! min>max` **refuses** the build: on the web before any call (red panel + toast), on the API as 422 `VALIDATION_ERROR` ("Cannot build the chamber. The Min is larger than the Max for B Kammer: Min 5000 > Max 4000. Swap or clear…").

### 3.4 50 mm rounding (manufacturing grid)
`CHAMBER_GRID_MM = 50`, `snapToChamberGrid(v) = round(v / 50) · 50`. Rule (spec `2026-09-01-empirical-50mm-rounding-design.md`):
- **estimates** are rounded: X1..X3 fits, `refine` fits, and the empirical relation LE = f(HLE) (rounded even if HLE is entered);
- rounding happens **before** the Min/Max clamp, which compares against the rounded value;
- a **user-driven** value (`set exact`, `capped at max`, `raised to min`) passes as is, and true **identities** (BF1, LF2, BF2, LT, H Kammer, LEB) propagate it without rounding (`userDriven: true`);
- auto length = `2 × width.final` (identity: on the grid if width is empirical, verbatim otherwise);
- **not rounded**: the dFirst/dMiddle ratios, the Gen Dim v3 dimensions, any entered override.
The Model column keeps the raw value; the Model/Final gap is the rounding.

### 3.5 Gen Dim v3 (generator of the With cone variant)
`computeChamberGeneratorDims({ x1, x2, x3, x4?, centralDiameter?, centralHeight?, domeHeight? })`, pure function shared by the API (build) and the web (hints). Source: `documents/Gen Dim v3 Only Calculator (standalone).xlsx`.

```
X4auto = 0.9 · 9.81 · X2 · X3            X4used = x4 ?? X4auto
R (frame) = X4used > 1560 → 115
          | X4used ≤ 175  → (X1 ≤ 940 → 26, else 46)
          | else          → (X1 ≤ 683 → 48, else 62)
L (length code) = clamp(30, 215, round((132.21 − 0.8294·R − 0.0825·X1 + 13.861·X3) / 5) · 5)
                  (rounded to the step of 5 BEFORE the clamp, Excel order)
auto Ø       = CATALOG[R]    (26:572, 36:745, 38:753, 45:976, 46:933, 48:986, 62:1242, 77:1545, 115:2225;
                              only 26/46/48/62/115 are reachable)
resolved Ø   = centralDiameter ?? auto Ø
auto height  = 71.258 + 0.45856 · resolved Ø + 6.2368 · L
auto dome    = 79.609 + 0.21315 · resolved Ø
```
- **Cascade**: an entered Ø re-bases the auto height and dome; an entered height does **not** change the dome; an entered X4 can change the frame R. No R field and no display of the derivation: a wrong R is corrected by typing the Ø.
- Reference parity (tested): X1 = 1450, X2 = 7, X3 = 10 gives X4 ≈ 618.03, R = 62, L = 100, Ø 1242, height ≈ 1264.47, dome ≈ 344.34.
- No 50 mm rounding on these values.

### 3.6 Manual overrides and cascade
All in mm, optional; empty = auto (`setValueAs: numOrUndef`, `placeholder="auto"`, help "Blank = auto ≈ N mm"). Bounds: `> 0`, `≤ 100,000`.

| Key | Label | Auto (if empty) | Scope |
|---|---|---|---|
| `lengthOverride` | Length (mm) | `2 × width.final` (help "Blank = 2 × width ≈ N mm") | both designs; **hidden and ignored** with Semi-spiral casing (the spiral derives Length) |
| `dFirst` | Runner case Ø (mm) | `1.14703 × dLast` (`CHAMBER_D_FIRST_OVER_LAST`) | both designs |
| `dMiddle` | Guide vanes Ø (mm) | `0.8 × dLast` (`CHAMBER_D_MIDDLE_OVER_LAST`); also sets the diameter of the vane ring | both designs |
| `hollowLength` | Cone length (mm) | **required** in With cone (form default 200) | With cone |
| `wallThickness` | Wall thickness (mm) | `CHAMBER_WALL_THICKNESS_MM` = 50 | With cone |
| `coneChamferSize` | Cone chamfer size (mm) (shown only when Cone chamfer is ticked, right under its checkbox; no placeholder, prefilled 50, hint "Blank = 50 mm") | `CHAMBER_CONE_CHAMFER_SIZE_MM` = 50 (builder `CONE_CHAMFER_SIZE` 0.05 m); both legs of the 45° foot chamfer = the widening of the LE part, × Part scale; at most the LE part height above LEB (§3.8) | both designs + Cone chamfer |
| `x4` | Power (kW) | Gen Dim v3 | With cone |
| `centralDiameter` | Generator Ø (mm) | Gen Dim v3 | With cone |
| `centralHeight` | Generator height (mm) | With cone: Gen Dim v3. Closed generator and Simplify generator: blank = through the chamber top (hint "≈ (H Kammer − Part scale × LEB) / Part scale", followed by "(min ≈ G + dome D = N mm)": the Gen Dim generator + dome minimum checked by the API, see §refusals); a value = flat-topped cylinder closed below the top (a top within 1 mm of the chamber top is pinned like blank; taller than H Kammer allows = refusal "The generator does not fit under the chamber top") | both designs (since 2026-09-28) |
| `domeHeight` | Dome height (mm) | Gen Dim v3; ignored if Simplify generator | With cone |

- `dFirst`/`dMiddle` are sent to the builder **unscaled** (m): the builder multiplies them by `partScale`; without an override it applies its own copies of the ratios to the already scaled `dLast`. The ratios therefore exist twice (TS and Python): keep them in sync.
- The web hint `computeChamberAutoDims` calls the same shared function with the current overrides: hints and build cannot diverge.

### 3.7 Geometric options (outside the empirical model)
All of them enter the build hash (unless stated) and never affect the 12 outputs.

| Key | UI label | Form default | API default | Range | Effect |
|---|---|---|---|---|---|
| `variant` | Design: "Closed generator" (`stepped`) / "With cone" (`hollow`) | `stepped` | `stepped` | enum | Stepped: three stacked solid cylinders, last cylinder pinned **through** the ceiling at any scale. Hollow: solid runner case + middle cylinder, last cylinder as a **cone** (open cup, wall and bottom of thickness `wallThickness`), central **generator** + semi-ellipsoidal dome. |
| `relationsMaster` / `relations` | Structural relations + "Configure relations (n/7 on)" (BF1 = LF1 and BF2 = LF2 are permanent, not in the menu) | true / all on | true / defaults | bool | §3.2 (these two fields enter the hash only through the Finals). |
| `guideVanes` | Guide vanes | **true** | **false** | bool | Replaces the middle cylinder with a distributor of 8 to 32 guide vanes (`vaneCount`, both designs). Caution: a direct API call without this field builds **without** vanes. |
| `vaneAngleDeg` | Vane angle (°) | 50 | 50 | 45 to 55 | Absolute opening angle; each vane pivots by `vaneAngleDeg − 50` around its axis. Only useful with vanes. |
| `vaneCount` | Guide vane count (integer number field, 8 to 32, step 1, hint "Guide-vane builds only", just before Vane angle, always visible) | 16 | 16 | whole number 8..32 | Number of guide vanes. With n vanes each blade is scaled uniformly in XY by **min(1, 16/n)** about its own pivot (same pivot radius, airfoil kept similar), ring step 360°/n (spec 2026-09-29-guide-vane-count-any, amended 2026-09-30; 16 or 18 only before). Above 16 the chord shrinks × 16/n (same solidity `n·c/(2π·R_pivot)`; 18 unchanged); below 16 the blade keeps its 16-vane size (lower solidity, wider throat). Smallest blade gap: ≈ 1.18 to 1.24 chord at 8 vanes, 0.52 to 0.58 at 16, 0.54 to 0.61 at 32 (45..55°). Every count 8..32 builds on the test machines; the passage refusal (§3.8) is only a safety net. Only useful with vanes. Enters the hash **only** for a build with vanes and a count other than 16 (16 and vane-less builds omit it: no re-key; 18 keys exactly as before). |
| `outletRatio` | Outlet ratio | 0.45 | 0.45 | 0.35 to 0.50 | Outlet inner radius = ratio × outer radius (= X1/2). Only useful with vanes. |
| `chamferEnabled` | Chamfer | true | true | bool | Cuts (or not) the two corners of the chamfered end; does not move the axis, does not change the table. |
| `feetEnabled` | Feet | true | true | bool | Carves (or not) the 4 torque feet (leg + gusset plank). Must be off with Semi-spiral casing (form: unticked + disabled with the reason shown; API: 422). |
| `semiSpiral` | Semi-spiral casing (checkbox after Guide vanes; description "Wrap the chamber around the turbine as a semi-spiral ending in a tongue (both designs). Length, B1, LT and the corner chamfers then come from the spiral.") | false | false | bool | Both designs (since 2026-09-29, spec `2026-09-29-semi-spiral-casing-design.md`). The footprint becomes the semi-spiral outline (6 spiral lines + 3-line nose) optimised by `designSemiSpiral.py` in a cached API step (§4.2, §5.1), extruded over H Kammer; a **nose** prism (tip 200 mm, not scaled, from the widest part `rmax`) and a **plank** (50 mm × Part scale thick, from the nose tip tangent to the generator / cone circle `dLast·s/2`, from LEB up through the ceiling) are cut from the fluid and form the `tongue` patch. B Kammer becomes the spiral's width **limit**; Length, B1, LT, LF1/BF1/LF2/BF2 are derived (read-only rows, status `from spiral`); `lengthOverride` hidden and ignored; Chamfer unticked, disabled and ignored (the spiral's L2/L4 are the corner cuts), then restored to its previous state when the spiral is unticked (`semiSpiralToggle`, user decision 2026-09-29; left alone after loading a save with the spiral on); Feet must be off. **Handedness**: the tool frame turns the flow clockwise seen from +Z, the guide-vane asset counter-clockwise, so the builder mirrors the spiral (tool x → builder −X, chamfer 1 = L2, B1 = −x_in; `SPIRAL_MIRROR_X`, mirrored by `chamberSpiralBoxDims`). Off adds nothing to the key. |
| `spiralFlowVelocity` | Casing flow velocity (m/s) (in place of Length while Semi-spiral casing is ticked) | 0.922 | 0.922 | 0.3 to 3 (`CHAMBER_SPIRAL_FLOW_RANGE`) | The spiral tool's `c_flow`. Enters the key only through `params.spiral.inputs`. |
| `footAngleDeg` | Foot angle (°) | 40 | 40 | 0 to 180 | 0/180 tangential, 90 radial; the gusset only exists between ≈ 37° and 143°, excluding ≈ 90° (otherwise refusal). |
| `partScale` | Part scale (×) | 1 | 1 | > 0, ≤ 5 | Uniform scale of the inner assembly (cylinders, cone, generator, dome, feet, vanes, dFirst/dMiddle overrides). The chamber (width/length/height), the chamfers and the axis do not move. Any height overflow is **refused** in both designs (§3.8). |
| `simplifyGenerator` | Simplify generator | false | false | bool | With cone only: generator as a plain cylinder with no dome, pinned through the ceiling unless a Generator height is typed (then closed below it); `domeHeight` hidden and omitted, `centralHeight` sent only when typed. In stepped, the flag is not passed on (no re-key). |
| `coneChamferEnabled` | Cone chamfer (checkbox in both designs, right after the main grid (Guide vanes options); description per design: "Chamfer the foot of the cone / generator at 45° at LEB; … widened by the chamfer size above it, so its foot stays on LE Ø.") | false | false | bool | Both designs (WS-C v2, spec `2026-09-29-cone-foot-chamfer-design.md`, replaces the top-rim chamfer of the same day): a 45° **foot** chamfer on the lower outer edge of the LE part (Closed generator: the last cylinder, which runs through the ceiling or up to a typed Generator height; With cone: the cone outer wall). The part is widened to `LE Ø/2 + c` above `LEB + c` (`c` = `coneChamferSize` × Part scale) and a frustum runs from `LE Ø/2` at LEB to `LE Ø/2 + c` at `LEB + c`: the foot stays on LE Ø/2, so the joint with the distributor roof does not move; the With cone bore does not change (the wall is `c` thicker). Built as one revolved profile (`make_le_part`). The fluid loses `π·H·(2rc + c²) − π·c²·(r + 2c/3)` (H = LE part height in the chamber above LEB). The widened radius counts in every fit check (rmax: walls and chamfer faces), the feet legs anchor from `max(Runner case Ø, LE Ø + 2c)/2` (the planks still weld at LE Ø/2), the semi-spiral plank is tangent to `LE Ø/2 + c` and the spiral's `D_LE` counts `LE Ø + 2c` (`chamberConeChamferMm`). The foot face is `cylinder_walls` (vane builds: explicit override of the sloped faces in the band); the hub-roof rule stays `r ≤ LE Ø/2`. Enters the hash **only** when on (flag + size), both designs; off: nothing passed (no re-key, no GOLDEN moves). |

### 3.8 Refusals and warnings
**API refusals before any build** (422 `VALIDATION_ERROR`, CadQuery never started):
- zod schema: X1..X3 out of range, dimensions ≤ 0 or > 100,000, `x4` outside ]0, 100,000], `footAngleDeg` outside [0, 180], `vaneAngleDeg` outside [45, 55], `vaneCount` not a whole number in [8, 32] (form: "Enter a whole number from 8 to 32"), `outletRatio` outside [0.35, 0.50], `partScale` outside ]0, 5], With cone without `hollowLength`;
- Final ≤ 0 (`nonPositiveChamberFinals`, except `noEffect`; the 4 chamfers LF1/BF1/LF2/BF2 are exempt if `chamferEnabled === false`, LT and B1 always count): message "Cannot build the chamber. These dimensions come out at 0 mm or below: H Kammer = … mm", with the levers (Runner Ø / Head / Q_max, relations, Min / Exact in the Parameters table);
- Min > Max (§3.3).
- **Blank Generator height (Closed generator, and With cone + Simplify generator since 2026-09-29): H Kammer below LEB + the Gen Dim v3 generator + dome heights** (`blankGeneratorHeightRefusal`; dome counted since 2026-09-29): the generator runs through the top, so without this check any H Kammer above the shoulder (+ cone) built with a cut-down generator. Minimum = (`computeChamberGeneratorDims(input).resolved.centralHeight` + `auto.domeHeight`) × Part scale: the dome is not modelled in these designs but belongs to the real generator; its Gen Dim fit is used (a hidden typed Dome height is ignored). The form hint shows "min ≈ G + dome D = N mm" in both designs. In With cone it only fires when that total exceeds the Cone length (a taller cone is the builder's cone check). The message gives the H Kammer to reach (next 50 mm) and the Part scale that would fit. A typed height and the domed With cone design are checked on the real geometry by the builder.
- **Guide vanes with a typed Runner case Ø that does not clear the outlet** (`runnerCaseClearanceRefusal`, WS-A v2 since 2026-09-29, spec `2026-09-29-runner-case-below-le-design.md`; it replaced the WS-A refusal below LE Ø − 5 mm): refused when `partScale × dFirst < X1 + 20 mm` (`CHAMBER_RUNNER_CASE_OUTLET_CLEARANCE_MM`; the outlet follows X1 unscaled), so the runner case wall stays at least 10 mm (radius) outside the outlet passage: "With guide vanes the runner case must clear the outlet: Runner case Ø (1460 mm) must be at least Runner Ø + 20 mm (1470 mm). Increase Runner case Ø, clear it (auto ≈ 1835 mm), or turn Guide vanes off." (with Part scale ≠ 1 the scaled value is added: "Runner case Ø (1600 mm, 1440 mm at Part scale 0.9)"). Between that bound and LE Ø − 5 mm the builder builds the **ledge** (§3.8 below); within 5 mm of LE Ø it snaps flush (WS-A). Only a typed `dFirst` can trigger it; vane-less builds are not concerned. The builder repeats the check (§3.8 below).

**Builder refusals** (`ValueError` ⇒ `KO:` + exit code 1 ⇒ API 502 `CHAMBER_BUILD_FAILED`; `summarizeFailure` shows the `KO:` text alone, prefixed "Cannot build the chamber.", in "Build errors"; any other exception becomes "The geometry engine failed on these inputs (Type: reason)…"; a failure without `KO:` keeps the exit code + a "Technical details" tail). Since 2026-09-29 the texts use the form's names (LEB, Cone length, Generator height, B1, LT, Runner case Ø…), lengths in whole mm, and name the levers:
- base dimensions ≤ 0, `hFirst = LEB − HLE ≤ 0`, B1 outside ]0, width[, LT outside ]0, length[;
- active chamfer with a setback ≤ 0 ("Corner chamfer N needs LFN and BFN greater than 0 mm … turn the chamfer off instead of setting it to 0") or larger than the chamber;
- `footAngleDeg` outside [0, 180], `partScale ≤ 0`, `vaneAngleDeg` outside 45..55, `vaneCount` not a whole number in [8, 32] ("Guide vane count must be a whole number from 8 to 32 (got 7).", hand-fed params);
- a guide vane count whose blades leave the distributor passage (safety net since the 2026-09-30 amendment; spec guide-vane-count-any; `_vane_count_fit` on a real mid-height outline, checked before the manifold union): past LE Ø/2 (the shroud brim edge) or inside the hub rim (`outlet_ri`): "With N guide vanes the blades (chord C mm) no longer fit between the hub and the runner case edge. Use between A and B vanes for this machine." The range is computed by rescaling that outline by `scale(m)/scale(n)` about its pivot for every m (`scale = min(1, 16/n)`). The limits are never tighter than the 16-vane blade itself (a ring oversized through Guide vanes Ø already pokes out at 16: not the count's doing). Since every count up to 16 draws the 16-vane blade and higher counts shrink it towards its pivot, it should never fire on a real ring (under the first 16/n rule, 8 vanes were refused on every fixture);
- invalid With cone parameters (`wallThickness` outside ]0, dLast/2[, `hollowLength ≤ wallThickness`, dimensions ≤ 0);
- **Semi-spiral casing** (since 2026-09-29): API 422 before any build for Feet on ("The semi-spiral casing needs Feet off for now. Uncheck Feet, or uncheck Semi-spiral casing."; the API default `feetEnabled` is true, so direct callers must send false) and a velocity outside 0.3 to 3. Spiral step `KO:` (502 `CHAMBER_BUILD_FAILED`, shown alone after "Cannot build the chamber."): degenerate spiral ("Q_max is too small for this H Kammer and runner case: the spiral would be narrower than the 200 mm gap around the turbine.", a guard: `R_cl = r_inner + A/H` so legal inputs never reach it) and no valid wall under B Kammer ("The semi-spiral casing does not fit in B Kammer (N mm): the narrowest valid spiral for these inputs is M mm wide. Raise B Kammer to at least M mm."); timeout ("The semi-spiral casing design took too long and was stopped. … raise CHAMBER_SPIRAL_TIMEOUT_MS."). **Warning** (build delivered, persisted in `warnings.json`, listed first): "The semi-spiral casing is limited by B Kammer (N mm): worst cross-section error X m² at Y°. Raise B Kammer to reduce it." Builder `KO:` guards: Feet on, vertices of another machine (nose tip not at `rmax + 200 mm` ± 1 mm: "The semi-spiral outline was designed for another machine: … Generate again to redesign the spiral."), no tangent (`r_t ≥ r_inner`), incomplete outline; the existing wall / chamfer fit checks run on the derived box. The derived rows are exempt from the non-positive and Min > Max refusals, and their leftover constraints are ignored (`chamberSpiralModelInput`, so a hidden B1 Exact no longer refines B Kammer);
- **Cone chamfer** (WS-C v2, both designs, Cone chamfer on): size ≤ 0 ("Cone chamfer size must be greater than 0 mm. Untick Cone chamfer for a square foot.", hand-fed params; zod blocks it first with a 422); With cone, size > Cone length − Wall thickness (unscaled: "Cone chamfer size (600 mm) is taller than the cone: Cone length 600 mm minus Wall thickness 50 mm leaves 550 mm. Lower the Cone chamfer size to 550 mm or less, or lengthen the Cone length."; the form mirrors it: "Must be at most Cone length minus Wall thickness (550 mm)"); Closed generator, scaled size > the generator above LEB ("Cone chamfer size (3000 mm) is taller than the generator: the generator rises only 2714 mm above LEB up to the chamber top. Lower the Cone chamfer size to 2714 mm or less, or increase H Kammer.", or with a typed height "… the Generator height is only 500 mm. Lower the Cone chamfer size to 500 mm or less, or raise the Generator height."; ", N mm at Part scale S" is added after the size when scaled; builder only). The widened part too wide for the chamber uses the part-too-wide messages below, with "Cone chamfer size" in the levers;
- **height overflow**: stepped, the shoulder (runner case + middle cylinder, = 2 × HLE) must leave at least `MIN_LAST_CYL_H` (50 mm) of last cylinder ("H Kammer (…) is too low: LEB … leaves less than 50 mm above it for the generator"); With cone, `first + middle + max(cone, generator + dome)` must fit under H Kammer, and the message names the part that sets the top and gives the Part scale that would pass ("The cone does not fit under the chamber top: LEB … + Cone length … = …, but H Kammer is only …. Set Part scale to 0.79 or less, …"); in Simplify generator the builder counts the cone (or a typed generator height), the blank generator's minimum is the API check above;
- axis in a chamfered corner ("The turbine axis (placed by B1 and LT) lies inside the cut corner of corner chamfer N …");
- part too wide: `max(dFirst, dMiddle, dLast + 2 × Cone chamfer)/2` compared with the four walls (B1, B Kammer − B1, LT, Length − LT) and the two chamfer faces ("The turbine (… across at its widest) would stick out of the chamber: it reaches … from the turbine axis, but the … wall is only … away" / "… through corner chamfer N (LFN × BFN)");
- foot outside the chamber, tested on the exact rotated footprint ("A torque foot would stick out of the chamber through …");
- vane distributor outside the chamber, tested on the actual radial reach of the vane + hub + shroud meshes ("The guide-vane distributor (blades + shroud) would stick out …");
- impossible gusset ("Foot angle …° cannot shape the torque feet …");
- neighbouring guide vanes closer than `VANE_MIN_GAP` = 2 mm (since 2026-09-29, `_min_blade_gap` over all pairs of the real mid-height outlines, checked before the manifold union): "Neighbouring guide vanes touch or overlap: with 18 vanes at a Vane angle of 45°, the closest gap between two blades is 0 mm (at least 2 mm is needed). Increase the Vane angle or set Guide vane count to 16." (the last lever is dropped at 16 vanes). A **safety net**: it cannot fire with the asset over 45..55° (smallest gap ≈ 0.39 chord, 8 vanes at 45°; the gap/chord ratio does not depend on Runner Ø, LE, Guide vanes Ø or Part scale);
- guide vanes with a typed Runner case Ø below Runner Ø + 20 mm (`RUNNER_CASE_OUTLET_CLEARANCE`, scaled Runner case vs X1 = `outletOuterD`): same text as the API refusal above (direct calls); very old params without `outletOuterD` and a Runner case Ø more than 5 mm below LE Ø keep the WS-A text ("… must be at least LE Ø …": no analytic shroud to build the ledge on);
- **Runner case ledge** (WS-A v2, guide vanes, typed Runner case Ø from Runner Ø + 20 mm up to LE Ø − 5 mm, built, no warning): the runner case wall stands at `Runner case Ø/2` from the floor up to `z_ledge` = 20 mm (`LEDGE_GAP` × Part scale) under the shroud brim, where a horizontal ledge runs out to LE Ø/2; above it the distributor envelope is unchanged (brim and roof at LE Ø/2) and the fluid wraps under the ledge. Built on the analytic shroud casing (revolved profile `(ro, duct) → (r_case, duct) → (r_case, z_ledge) → (LE Ø/2, z_ledge) → brim → fillet`; no casing overshoot, the OCC first cylinder is fully inside the `r < LE Ø/2` cavity). When `Runner case Ø/2` still lies on the shroud fillet (floor below the brim, only just above Runner Ø + 20 mm), `z_ledge` is taken 20 mm under the floor at that radius instead (to confirm with the user). The vane prisms (mesh and STEP) are clipped by the fluid annulus under the ledge, so blades that pass over the runner case radius never hang down as pillars. The feet legs anchor from `max(Runner case Ø, LE Ø)/2` with guide vanes (gusset base still at LE Ø/2). Labels (§3.9): wall and ledge underside `cylinder_walls`, the 20 mm band at LE Ø/2 `shroud`, the floor outside `walls`;
- internal (reported as "The geometry engine failed on these inputs (RuntimeError: …)"): `expected N blade sections, found M`, `could not find the inlet (min-Y) face`, `expected >=N cylindrical faces`, `no patches produced`.

**Warnings** (build delivered; `WARNING:` lines on stdout and `WARN:` on stderr, collected by `^WARN(?:ING)?:\s*(.+)$`, stderr first, persisted in `warnings.json`, shown in "Build warnings" and returned on every cache hit):
- `outlet outer radius … clamped to … (Runner Ø too large for this vane/d_last combination)`: outlet radius capped at `0.97 × R_anchor`;
- `hub shoulder non-monotonic (Runner Ø too large for the point spacing)`: hub P1 > P2 fold (≈ Runner Ø 2179 mm at ratio 0.45), never refused; the rule also folds at the small end (P2 > P3 below Runner Ø ≈ 641 to 711 mm depending on the ratio), kept as is by decision of 2026-09-29 (`known-issues.md`);
- `Runner case Ø 1602 mm is within 5 mm of LE Ø 1600 mm: built flush with it.` (guide vanes, `|dFirst − dLast| ≤ 5 mm` scaled): the runner case is built flush with LE Ø (no ring, no casing overshoot);
- `central diameter … exceeds the hollow bore …`;
- `could not write edges.bin`;
- `OCC vane STEP reconstruction failed` and `chamber.step falls back to the vane-less solid (no vanes carved)` (only during a `--step` pass, merged into `warnings.json`).

The builder texts were swept on 2026-09-29 (no more "box" or "cylinder shoulder"); they stay locked by the pytest assertions (§10).

### 3.9 Patches produced (exact list)
| Configuration | Patches, in emission order | Source |
|---|---|---|
| Closed generator (`stepped`) without vanes | `inlet`, `outlet`, `cylinder_walls`, `walls` | OCC BREP faces (`classify`) |
| With cone (`hollow`) without vanes | `inlet`, `cylinder_walls`, `walls` (**no `outlet`**) | OCC BREP faces |
| With vanes (both designs) | `inlet`, `cylinder_walls`, `walls`, `hub`, `shroud`, `outlet`, `guide_vanes` | triangles of the boolean fluid `fluid_F` |
| Semi-spiral casing | the lists above with `tongue` right after `walls` (`inlet`, `outlet`, `cylinder_walls`, `walls`, `tongue` stepped without vanes; `inlet`, `cylinder_walls`, `walls`, `tongue`, `hub`, `shroud`, `outlet`, `guide_vanes` with vanes) | BREP: `classify(tongue_test=…)`; vanes: `tongue` source + exact footprint override before the vane skin |

- Types (`PATCH_TYPES`): `inlet` and `outlet` = `patch`; `cylinder_walls`, `walls`, `hub`, `shroud`, `guide_vanes`, `tongue` = `wall`. A patch with no face is omitted.
- `tongue` (semi-spiral only) = every non-horizontal (`|nz| < 0.5`) wetted face whose centroid lies in the XY footprint of the nose polygon, or of the plank rectangle at or above LEB (tolerance `PLANE_TOL`); the plank underside at LEB stays in `walls`. No build without the spiral emits it.
- `inlet` = planar face at minimal Y (non-chamfered end of the chamber). `walls` = the chamber faces. `cylinder_walls` = all faces of the inner pocket (cylinders, cone and its Cone chamfer face, generator, dome, feet) whose vertices are all within `max(rmax, outer radius of the feet) + 0.1 m` of the axis.
- Stepped without vanes: `outlet` = the cylindrical face at median z, i.e. the side wall of the **middle cylinder** (see §9, discrepancy with the vocabulary rule).
- With vanes: `outlet` = flat ring at the actual floor between `ri` and `ro`; `hub` = inner wall of the channel (roof, shoulder, vertical duct down to the floor); `shroud` = outer wall (elliptical fillet, floor, duct); `guide_vanes` = skin of the 16 or 18 vanes (same patch list for both counts).
- Runner case ledge (WS-A v2, Runner case Ø below LE Ø with vanes): the runner case wall (below `z_ledge`) and the ledge underside are `cylinder_walls`, the 20 mm band at LE Ø/2 between the ledge and the brim is `shroud`, the floor outside `max(Runner case Ø, ro)` is `walls` (deterministic labels after the vote, before the blade skin). No new patch.
- `trisurface.zip` contains one ASCII `<patch>.stl` per patch **plus** `domain.stl` (concatenation, never transferred to Meshing: `CHAMBER_TRANSFER_EXCLUDED_STL`).

## 4. Technical flow

### 4.1 Live computation (web)
`ChamberPage` owns the react-hook-form instance (`zodResolver(chamberFormSchema)`, `mode: 'onChange'`, defaults `CHAMBER_FORM_DEFAULTS`) and the `constraints` state. `useMemo` calls `computeChamberOutputs({ x1, x2, x3, constraints, relationsMaster, relations })` on every change; `computeChamberAutoDims(values, dLast.final)` provides the hints; `autoLengthMm = 2 × width.final`. No network call.

### 4.2 Build: web → API → builder
1. `onGenerate` (`handleSubmit`): local Min > Max check, then `useBuildChamber().mutate({ ...values, constraints })` → `buildChamber` (`lib/api/chamber.ts`) → `POST /api/v1/chamber/build` (`requireAuth`, `validate(chamberBuildSchema)`).
2. `buildChamberController` → `chamber.service.buildChamber(input)`:
   - `computeChamberOutputs(input)`; non-positive, Min > Max and blank-generator minimum (`blankGeneratorHeightRefusal`) refusals (§3.8);
   - `resolveGeometryParams(input, outputs)`: parameters **in meters** (§5.1); for `hollow`, `computeChamberGeneratorDims(...).resolved`;
   - `hash = chamberHash(params)`;
   - under `withChamberLock(hash)`: if `chamber.glb` exists, **cache hit** (returns `warnings.json` and `build-meta.json`); otherwise checks the script (500 `SCRIPT_MISSING`), writes `params.json`, runs `CHAMBER_PYTHON_BIN buildChamber.py <params.json> <dir>` (cwd = build folder, timeout `CHAMBER_BUILD_TIMEOUT_MS`); failure, timeout, missing binary or no GLB ⇒ 502 `CHAMBER_BUILD_FAILED` with the message of `summarizeFailure(result, action)` (the builder's `KO:` text alone, "Cannot build the chamber. …"); otherwise extracts and persists the warnings.
   - Response `200 { hash, outputs, warnings, stepHasVanes }` (`stepHasVanes`: `true`/`false` if a STEP with vanes has already been generated, `null` otherwise).
3. Web: `setHash`, `setLastBuildInput(body)`, `setBuildWarnings`, `offerMirror = guideVanes && stepHasVanes !== false`.

### 4.3 Geometric construction (`buildChamber.py main()`)
Protocol: `python buildChamber.py <paramsJson> <outDir> [--step]`; success `OK: <n> patches -> …/chamber.glb` (exit code 0); failure `KO: <message>` on stderr (exit code 1); usage (exit code 2).
1. Reading of the parameters (m) and common validations (§3.8).
2. Unscaled stack dimensions per variant, height check at the requested `partScale` (refusal).
3. Scaling: `dLast`, `hMiddle`, `hFirst` × `partScale`; `dFirst`/`dMiddle` = override × `partScale` or ratio × `dLast`.
4. Inner part: stepped `make_part` (last cylinder of local height `H + 2·FLOOR_OVERCUT − (hFirst + hMiddle)`, hence open through the ceiling; middle cylinder omitted with vanes); with the Cone chamfer the last cylinder is the revolved `make_le_part`; hollow `make_part_hollow` (open cone, its outer wall widened with the Cone chamfer foot when on, generator, dome `make_dome`, or pinned generator without dome in Simplify generator). Positive-height guard.
5. `make_box`: box `width × length × height` with two asymmetric chamfers on the vertical corners of the `+Y` end (large chamfer on the `+X` side), or an intact box if `chamferEnabled` is false. Semi-spiral: the box keys come from `spiral_box(params.spiral.vertices)` (mirrored, chamfers always on), after the nose-tip check against `rmax + SPIRAL_CLEARANCE`; `spiral_plank` computes the tangent point and the plank rectangle (extended 20 mm × Part scale into the target part, and into the nose until both back corners are inside it).
6. Axis positioning: `target_x = width/2 − B1`, `target_y = length/2 − LT`, part lowered to `z = −H/2 − FLOOR_OVERCUT` (FLOOR_OVERCUT = 10 mm, opens the floor).
7. Fit checks: axis in a corner, radius `rmax` against walls and chamfer faces, exact footprint of the feet.
8. `make_feet` if `feetEnabled` (4 voids at 0/90/180/270°, dimensions × `partScale`).
9. Vanes: the first cylinder is hollowed over the whole disk `r < dLast/2` (it only keeps its outer ring `[dLast/2, dFirst/2]`). Since 2026-09-29 (spec `2026-09-29-vane-pocket-runner-case-design.md`), right after scaling: `dFirst < dLast − 5 mm` is refused; `|dFirst − dLast| ≤ 5 mm` snaps `dFirst` to `dLast` (WARNING) and the cavity grows by `FLOOR_OVERCUT` so the whole first cylinder goes; the effective `dFirst` then drives the fit check `rmax`, the feet legs (`make_feet` gusset base stays on the last cylinder `dLast/2`), the pocket radius and the junction labels. The shroud casing outer wall (and the analytic shroud brim) sits at `dLast/2 + casing_overshoot`, `casing_overshoot = min(FLOOR_OVERCUT, ring width / 2)` (0 when flush, 10 mm for rings of 20 mm and more, i.e. the default geometry is unchanged).
10. `result = box.cut(part).cut(feet)` (OCC fluid solid); semi-spiral: `.cut(nose).cut(plank)` (nose prism closed 10 mm outside the wall, full height; plank from LEB to `H/2 + FLOOR_OVERCUT`); then `classify` of the BREP faces.
11. Vanes only: `make_vane_patches` (ring at the `dMiddle` scale, height filling the HLE band, `vaneCount` (8..32) blades every 360°/n, each scaled by min(1, 16/n) about its pivot, pitch `vaneAngleDeg − 50`, rims `ro = min(X1/2, 0.97·R_anchor)` and `ri = outletRatio · ro`, analytic hub P1/P2/P3 and quarter-ellipse shroud `a = 0.160·ro`, `b = 0.119·ro` when `outletOuterD`/`outletRatio` are provided, otherwise the legacy "fallback" path); distributor fit refusal; hub/shroud ducts down to the floor; flat ring outlet; **manifold boolean**: `distributor solid = hub core ∪ shroud casing ∪ vane prisms` (trailing edge rounded by `_round_blade_te`), `fluid_F = tessellation(result) − distributor`. Before the union: exactly `vaneCount` blade outlines, all inside the passage for that count and no two closer than 2 mm (§3.8). The `--step` pass (`build_vane_step_solid`) needs no change: it iterates the blades and fits the airfoil with a free similarity scale.
12. Atomic writing of the artifacts (§4.5).

### 4.4 Patch classification (builds with vanes)
Each triangle of `fluid_F` is labeled by the nearest source (centroid KD-tree, `_label_by_nearest_source`) among `inlet`, `walls`, `cylinder_walls` (bottom disk of the upper cylinder removed), `hub`, `shroud`, `outlet`. Deterministic overrides then: horizontal floor ring `[ri, ro]` → `outlet`; horizontal ring at the roof `z_mid_top`, `r ≤ dLast/2` → `hub`; vertical walls below the passage at `r ≈ ri` → `hub`, at `r ≈ ro` → `shroud`; runner-case / distributor junction (since 2026-09-29): vertical faces within 3 mm of the effective runner case radius and below `z_mid_base` → `cylinder_walls`, horizontal faces between the shroud brim and `z_mid_base` → `cylinder_walls` outside `dLast/2 + 1 mm` (ring top) and `shroud` between `ro + 3 mm` and `dLast/2 − 1 mm` (brim), the small vertical step at `dLast/2` between brim and ring top → `shroud` (not when flush), horizontal box-floor faces beyond `max(ro, runner case radius) + 1 mm` → `walls`; finally the **vane skin**, assigned last by an exact test (`_blade_skin_mask`: centroid within `VANE_SKIN_TOL` = 1 mm of a vane outline in XY AND `|nz| < 0.5`) → `guide_vanes`. The vanes are deliberately not a voting source (fix of 2026-09-04).

### 4.5 Artifacts and exports
Each file is written as `<final>.tmp` then `os.replace()`; `chamber.glb` is promoted **last**, just before `OK:` (cache completeness marker).

| File | Content |
|---|---|
| `chamber.glb` | trimesh scene, one node per patch (served as `model/gltf-binary`, `Cache-Control: private, max-age=0, must-revalidate`). |
| `manifest.json` | `[{ name, type, nFaces, edgeOffset, edgeCount }]` (`nFaces` = CAD faces without vanes, triangles with vanes). |
| `edges.bin` | float32 LE, segment pairs of the real CAD edges; **empty** with vanes (the viewer computes its own edges). |
| `exports/chamber.stl` | `fluid_F` (vanes) or OCC tessellation (`STL_TOLERANCE` = 10 mm). Downloaded as `chamber.stl`. |
| `exports/chamber.step` | Without vanes: always written at build time (≈ 0.05 s). With vanes: **deferred**, written only during a `--step` pass. |
| `exports/chamber-mirrored.step` | Mirrored STEP, generated on demand. |
| `exports/trisurface.zip` | One ASCII STL per patch + `domain.stl`. Downloaded as `chamber-trisurface.zip`. |
| `build-meta.json` | `{ "stepHasVanes": bool }`, written only by a `--step` pass of a build with vanes. |
| `params.json`, `warnings.json` | Written by the API (not atomic). |

**Deferred STEP for builds with vanes** (spec `2026-09-01-deferred-vane-step-design.md`): the OCC carve of the vanes + the verification gate cost ≈ 2/3 of a build (23 to 28 s). `GET /chamber/:hash/export/step`, if the file is missing, reruns the **whole** builder with `--step` under the hash lock (409 `CHAMBER_NOT_BUILT` if the build does not exist, 502 otherwise), merges the **new** warnings (deduplicated) into `warnings.json`, then serves the file. The `--step` pass tries `build_vane_step_solid` (hub and shroud revolved from the analytic profiles, committed vane profile `guideVanes_blade_profile.json` fitted onto each vane, rounded trailing edge, spline extrusion); accepted only if a single valid solid and a volume after STEP round-trip within 0.5 % of `fluid_F` (`VANE_STEP_VOL_TOL`), otherwise fallback to the vane-less solid + WARN + `stepHasVanes: false`. A STEP never fails a build. Without the analytic path (old params without `outletOuterD`/`outletRatio`), the STEP is always vane-less (K11).

**Mirrored STEP** ("Change rotational direction"): `GET …/export/stepMirrored`; if absent, first generates `chamber.step` if needed, requires `stepHasVanes === true` (otherwise 409 "The mirrored STEP is only available when the STEP export carries the guide vanes."), then runs `mirrorStep.py <chamber.step> <chamber-mirrored.step>` (mirror across the YZ plane, x → −x, translation `xmin + xmax`: same bounding box, inverted chirality; written via `mkstemp` + `os.replace`). Exports are served as attachments with `Cache-Control: private, max-age=31536000, immutable`.

**After a successful STEP/mirror download**, `ChamberPage.onExportDownloaded` silently re-POSTs `lastBuildInput` (guaranteed cache hit) to fetch the new warnings and `stepHasVanes`; a discovered fallback collapses the STEP menu into a single button. A failure of this refresh is ignored.

### 4.6 Reads by hash and viewer
`useChamberManifestQuery` (`['chamber', hash, 'manifest']`), `useChamberGeometryQuery` (`['chamber', hash, 'glb']`), `useChamberEdgesQuery` (`['chamber', hash, 'edges']`) → `GET /chamber/:hash/manifest | geometry | edges` (409 `CHAMBER_NOT_BUILT` if absent; `edges` returns 204 if absent). Queries disabled without a hash, `retry: false`, `staleTime` = `gcTime` = 5 min, never invalidated (resources immutable per hash). The `/saves` routes are declared **before** `/:hash/*`.

### 4.7 Saved builds
- API: `GET /chamber/saves` (`200 { saves }`, sorted `updatedAt desc`, `owner: { id, fullName }`), `POST /chamber/saves` `{ name, snapshot }` (201, 409 `NAME_TAKEN`), `PUT /chamber/saves/:id` `{ name?, snapshot? }` (at least one; 403 `FORBIDDEN` unless author/super-admin; 404; 409), `DELETE /chamber/saves/:id` (204, idempotent `deleteMany`). The snapshot is validated by **`chamberBuildSchema`**: a save cannot hold a non-buildable state, and the schema defaults are materialized in it.
- Web: `useChamberSaves.ts` (key `['chamber', 'saves']`, invalidated by every mutation). `ChamberSavesMenu`: Save creates, or overwrites the save carrying **exactly** that name if the user can manage it, otherwise an inline message ("belongs to …"); Duplicate = `POST` of the source snapshot under "name (copy)", owned by the current user; Rename and Delete restricted to the author or the super-admin. Save is disabled if the form is invalid (`snapshot = isValid ? { ...values, constraints } : null`).
- Load: `reset(chamberInputToFormValues(snapshot))`, `setConstraints(snapshot.constraints ?? {})`, then reset of the whole last-build state (`hash`, `offerMirror`, `lastBuildInput`, warnings, errors). No automatic Generate.
- **Compatibility of old saves**: `chamberInputToFormValues` falls back to `CHAMBER_FORM_DEFAULTS` for any missing field with a server default (`variant`, missing relations, `footAngleDeg`, `partScale`, `guideVanes`, `chamferEnabled`, `feetEnabled`, `vaneAngleDeg`, `vaneCount` (old saves load as 16), `outletRatio`, `simplifyGenerator`, `coneChamferEnabled` / `coneChamferSize` (old saves load off / 50 mm), `semiSpiral` / `spiralFlowVelocity` (old saves load off / 0.922 m/s)); missing overrides stay empty (auto); missing `x4` = auto. `hollowLength` and `wallThickness` are **not** defaulted (a With cone save always contains `hollowLength`, required by the schema; a missing `wallThickness` stays empty and equals 50 mm on the server; a stepped save whose snapshot does not carry `hollowLength`, loaded then switched to With cone, therefore shows an empty Cone length to fill in). Hidden fields (e.g. `x4` in stepped, heights in Simplify) stay in the snapshot and are ignored by the server.

### 4.8 "Inputs changed since this build" detection
`isStale = hash !== null && lastBuildInput !== null && chamberBodyKey({ ...values, constraints }) !== chamberBodyKey(lastBuildInput)`. `chamberBodyKey` serializes after recursively sorting the keys (`watch()` and the zod output of `handleSubmit` do not order keys the same way; an `undefined` key is equivalent to an omitted key). Cause of the stuck banner fixed on 2026-09-03. The comparison is on the **body**, not on the hash: changing a field with no geometric effect (e.g. `x4` in stepped) also shows the note.

### 4.9 Transfer to Meshing
`SendToMeshingDialog` (modes `new`: name prefilled `chamber-<first 8 characters of the hash>` + engine `snappy`/`cfmesh`; `existing`: chosen session; `copyFrom`: copy of a session's setup + optional name) → `useTransferChamberToMeshing` → `POST /api/v1/meshing/from-chamber` `{ mode, chamberHash, … }` → `meshing.service.importChamberIntoMeshing`: reads `trisurface.zip` via `readChamberExport` (409 `CHAMBER_NOT_BUILT` if absent), keeps all `*.stl` except `domain.stl` (422 `INVALID_STL` if none), resolves the target session (`createSessionDir`, `requireSession`, or `copySessionSetup` = engine + `config.json` + surfaces, without run output), then `addStlFiles` (STL validation, cfMesh rules, **overwrite by name**; surfaces whose names are absent from the build stay in place). On success: navigation to `/meshing/<id>`. snappy uses one STL per patch, cfMesh merges them at run time. Same path as the one planned for a future optimization loop (`POST /chamber/build` then `from-chamber` `copyFrom` then run).

## 5. Data and storage

### 5.1 Build cache `<STORAGE_DIR>/chamber/<hash>/`
- Global, not tied to a project, shared by the team. Tree: `params.json`, `chamber.glb`, `manifest.json`, `edges.bin`, `warnings.json`, `build-meta.json`, `exports/{chamber.stl, chamber.step, chamber-mirrored.step, trisurface.zip}`, and `_debug/` if `CHAMBER_DEBUG_DUMP`.
- **Key**: `chamberHash(params)` = SHA-1 of the JSON of the sorted `[key, value]` pairs, truncated to 16 hex. `params` contains: `length`, `variant`, `footAngleDeg`, `guideVanes`, `chamferEnabled`, `feetEnabled`, `vaneAngleDeg`, `partScale`, `outletRatio`, `outletOuterD` (= X1 in m), `vaneCount` only when 18 with vanes, `dFirst`/`dMiddle` if entered, the 12 Finals (m); `coneChamferEnabled` + `coneChamferSize` (m) only when the Cone chamfer is on (both designs); in hollow `wallThickness`, `hollowLength`, `centralDiameter`, `simplifyGenerator`, and, outside Simplify, `centralHeight`, `domeHeight` (in Simplify, `centralHeight` only when typed); in stepped `centralHeight` only when typed. **Semi-spiral casing on**: `semiSpiral: true` and `spiral` (`inputs` = the 7 tool inputs, `vertices` = V0..V9 in m (tool frame), `quality`) are added **before** hashing, and `length`, `distFromSideChamfer1`, `distFromEnd`, the four chamfer Finals and `chamferEnabled` are left out (off: nothing added). **Not included**: `x4`, `relations`, `constraints` (only via the Finals), the Python code version, its constants and its assets.
- Consequences: explicitly sending the auto values gives the same hash as empty fields; `vaneAngleDeg`, `outletRatio` and `outletOuterD` are set even without vanes, so changing them re-keys a vane-less build (identical geometry, rebuilt).
- **Completeness** = presence of `chamber.glb` (`chamberGlbExists`). A killed build leaves at most `.tmp` files and partial artifacts, never a GLB: the next request rebuilds.
- **Lock**: `withChamberLock(hash, fn)`, promise-chain mutex **in process memory**, around the cache check + build, and around the `step`/`stepMirrored` generation (state rechecked inside the lock). Reads without lock (safe thanks to atomic writes). Only one API instance supported (K31).
- **Mandatory purge**: the hash does not capture the code. **Any change to `buildChamber.py`, its constants or its assets requires `rm -rf apps/api/storage/chamber/*`** (decision of 2026-08-05). The code never purges this cache (K29); no quota and no eviction.
- `CHAMBER_DEBUG_DUMP` (non-empty): builds with vanes, writes `<outDir>/_debug/` (`core.stl`, `casing.stl`, `result.stl`, `hub_throat.stl`, `hub_source.stl`, `shroud_source.stl`, `vanes_source.stl`, `F.stl`, `meta.json`), consumed by `_verify_outlet_ratio.py`. `CHAMBER_STEP_DEBUG`: `STEPDBG` traces of the STEP pass.

### 5.2 Database
Prisma model `ChamberSave` (migration `20260831142110_chamber_saves`): `id` (cuid), `name` globally **unique**, `ownerId` → `User` (**cascade** on deletion of the owner, deliberate choice aligned with `Project`/`Template`), `snapshot` (TEXT, JSON of `ChamberInput`), `createdAt`, `updatedAt`, index `ownerId`. No column per field: a new `ChamberInput` field goes through without a migration.

### 5.1b Semi-spiral cache `<STORAGE_DIR>/chamber-spiral/<spiralHash>/`
- `spiralHash` = SHA-1 of `{algorithm: 'ref-2026-09-22-seed5', inputs: sorted [key, value] pairs}`, 16 hex (`chamber.service.ts`). Inputs (`chamberSpiralInputs`): `Q` = Q_max, `c_flow` = Casing flow velocity, `H_ch` = H Kammer Final, `D_LE` = `max(dFirst, dMiddle, dLast) × partScale` (m), `clearance` 0.2, `max_width` = B Kammer Final, `phi_start` 160.
- `in.json` (the inputs) and `spiral.json` (the `designSemiSpiral.py` result, written atomically by the script) under `withChamberLock('spiral:' + hash)`: concurrent builds sharing a spiral optimise it once; a vane-angle change reuses it. A result is validated (10 vertices, quality) before use.
- Purge it whenever `designSemiSpiral.py` or scipy changes (vertices are only reproducible on one scipy version); like the chamber cache (K29).

## 6. Configuration and external dependencies
- `CHAMBER_PYTHON_BIN` (default `python` on Windows, `python3` elsewhere): dedicated venv with `cadquery`, `trimesh`, `numpy`, and for builds with vanes `scipy` (`PchipInterpolator`, `cKDTree`), `shapely`, `manifold3d`, `networkx`. Reference pinned versions: `apps/api/scripts/requirements-geometry.txt` (cadquery 2.8.0, trimesh 4.12.2, numpy 2.4.6, scipy 1.18.0, manifold3d 3.5.2, shapely 2.1.2). `scipy` is also in `requirements.txt` since 2026-09-29 (K8 closed), used by `designSemiSpiral.py` too.
- `CHAMBER_SPIRAL_TIMEOUT_MS` (default 300,000): one semi-spiral optimisation (30 to 90 s per run, same interpreter).
- `BUILD_CHAMBER_SCRIPT`, `MIRROR_STEP_SCRIPT`: path overrides (default: `apps/api/scripts/*.py` resolved from the module). `CHAMBER_BUILD_TIMEOUT_MS` (default 600,000): builds, `--step` passes and mirrors.
- Assets committed under `apps/api/scripts/assets/`: `guideVanes.json` (metadata: `pivotRadius` 0.86732, 16 vanes at 22.5° (`bladeCount` is the reference count for the chord scale; `bladeAngleStepDeg` is no longer read, the step is 360/`vaneCount`), rims 0.29573 / 0.65500…), `guideVanes_blade.stl`, `guideVanes_walls.stl` (fallback), `guideVanes_outlet.stl`, `guideVanes_blade_profile.json` (vane profile for the STEP). Produced offline by `preprocessVanes.py` and `bakeVaneBladeProfile.py`.
- Without an interpreter or without CadQuery: 502 `CHAMBER_BUILD_FAILED` ("Could not start the chamber builder…"); missing script: 500 `SCRIPT_MISSING`. The live table computation always works (pure TS).
- Business source for Gen Dim v3: `documents/Gen Dim v3 Only Calculator (standalone).xlsx` (if its formulas change, `computeChamberGeneratorDims` and the parity tests follow).

## 7. Tests
- **API** (`apps/api/tests/`, builder and mirrorer simulated by fake runners, they never run CadQuery):
  - `chamber.test.ts`: build (401, hash + 12 outputs, manifest, GLB, STL `immutable`), `WARN:`/`WARNING:` warnings persisted and replayed on cache hit, deferred STEP (`--step` on the first download then served from disk), mirrored STEP (generates the STEP then mirrors, once), 409 for fallback or vane-less build, 502 then recovery, per-hash lock (concurrent builds, STEPs and mirrors = one execution), 422 refusals (Final ≤ 0, Min > Max, Closed generator H Kammer below the generator minimum, Runner case Ø below Runner Ø + 20 mm with guide vanes (no builder call; LE Ø − 50 mm now reaches the builder), zod bounds, `x4`, `outletRatio`, `vaneCount`, `footAngleDeg`, hollow without `hollowLength`), cache keys (`vaneCount` 18 re-keys a vane build, 16 and vane-less do not; the Cone chamfer re-keys both designs only when on (blank size = 50, sizes differ), size 0 is a 422 in both; each flag and override re-keys without changing the outputs; `x4` and `simplifyGenerator` without effect in stepped; hidden heights out of the key in Simplify; explicit auto values = same hash), constraints and refinement.
  - `chamberModel.test.ts`: 12 fits, 50 mm rounding, relations and statuses, `userDriven`, `noEffect`, `nonPositiveChamberFinals`, Gen Dim v3 parity (frames, length code, cascade), `blankGeneratorHeightRefusal` (generator + dome minimum, Simplify generator above the cone, Part scale, cases left to the builder), `runnerCaseClearanceRefusal` (exact text, X1 + 20 mm bound, LE − 50 mm and snap range accepted, scaled Runner case vs unscaled X1, auto and vane-less pass).
  - `chamberSaves.test.ts`: CRUD, 401/403/404/409/422, super-admin, normalized snapshot.
  - `meshing.test.ts`: `from-chamber` transfer (new, existing, copyFrom), exclusion of `domain.stl`, 409 `CHAMBER_NOT_BUILT`.
- **Real geometry** (`apps/api/scripts/tests/test_build_chamber.py`, pytest, CI job `geometry` = authority; skipped without CadQuery): 6 fixtures (`stepped`, `stepped-feet-off`, `stepped-vanes`, `hollow-vanes`, `hollow-vanes-overrides`, `stepped-vanes-18`) with golden volumes (`VOL_RTOL` 5e-3) and exact patch lists; `OK:`/`KO:` contract, watertight STL, zip content, `edges.bin`, absence of STEP and `build-meta.json` without `--step` for vanes, `stepHasVanes: true` with `--step`, no leftover `*.tmp`, refusals (height, width, feet, zero chamfer, axis in a corner, distributor), Simplify generator (section below the ceiling: 2 loops versus 1), trailing edge rounding, vane skin exclusively in `guide_vanes`, Runner case Ø vs LE Ø on `hollow-vanes-overrides` and `stepped-vanes` (X1 + 10 mm refused; LE − 100 mm builds the ledge: watertight, section under the ledge shows the runner case circle and fluid under the ledge, wall + ledge `cylinder_walls`, 20 mm band `shroud`, floor `walls`, `guide_vanes` area unchanged; LE − 400 mm on `stepped-vanes`: prisms clipped, no pillar; LE + 2 mm built flush with the WARNING and no `shroud` / `walls` on the runner-case wall, LE + 12 mm thin ring whose wall is entirely `cylinder_walls`), 18 guide vanes (18 blade components on `guide_vanes`, chord 16/18 of `stepped-vanes`, 20° step, `stepHasVanes: true` with `--step`), `_min_blade_gap` unit test, free vane count (7, 33, 12.5, true, "16" refused; `_vane_chord_scale` and `_vane_count_fit` unit tests; 8 and 12 vanes on `stepped-vanes` and `hollow-vanes` build watertight with the 16-vane chord; 8 and 32 vanes on `stepped-vanes` at 45° and 55°: n watertight blades, chord × min(1, 16/n), 360/n step, gap/chord 1.184 / 1.245 / 0.541 / 0.611 ± 0.02; `--step` at 8, 13 and 32 keeps the vanes), Cone chamfer (foot, 50 mm) on `stepped-vanes` and `hollow-vanes` (watertight, `VANE_PATCHES`, volume delta = `π·H·(2rc + c²) − π·c²·(r + 2c/3)` within 3 %, section at LEB + 0.6c: solid just inside `r_le + 0.6c`, fluid just outside, fluid in the plain build; 45° faces in the band only in `cylinder_walls`, none in the plain build), on `stepped` without vanes (BREP: `STEPPED_PATCHES`, foot face in `cylinder_walls`), refusals (600 mm on the 600 mm cone, 3000 mm to the ceiling, 600 mm over a 500 mm Generator height, size 0, widened part too wide), semi-spiral plank tangent to `r_le + c` on `stepped-spiral`, mirror (volume, box, reflected center of mass). Semi-spiral casing (fixtures `stepped-spiral`, `hollow-vanes-spiral`: frozen vertices in `params.spiral`, box keys left out; GOLDEN 51.657323 / 47.762966): single planar inlet at the foot of width `x4 − x_in`, nose tip at `rmax + 200 mm` ± 1 mm, plank solid from the nose to the target circle above LEB and absent in the vane band, 50 mm × Part scale thick, no horizontal `tongue` face, handedness against the vane asset, BREP path patch list (`guideVanes` off), vaned `--step` (`stepHasVanes: true`), Feet refused, vertices of another machine refused. **No With cone fixture without vanes.**
- **Semi-spiral designer** (`apps/api/scripts/tests/test_design_semi_spiral.py`, numpy + scipy only, runs without CadQuery): spreadsheet values, corrected 160° frame check, ray / area evaluator, nose, input and degenerate refusals, chamber wording, CLI contract; `-m slow`: tool-spec cases A/B/C, cross-process determinism, max_width 5.5 width-bound, golden vertices `tests/spiral_golden/case_{A,B,C}.json` pinned to scipy 1.18.0 / 1.18.1.
- **Web** (`apps/web/src/features/chamber/*.test.ts(x)`): `chamberForm` (schema, defaults, snapshot round-trip, `chamberBodyKey`, `computeChamberAutoDims`), `ChamberInputsForm`, `ChamberOutputsTable`, `ChamberBuildWarnings`, `ChamberExportButtons`, `ChamberSavesMenu`, `SendToMeshingDialog`. No test for `ChamberPage` (stale state, silent refresh, reset on load checked manually).
- Last known state (2026-09-29, WS-C v2 foot chamfer + WS-A v2 runner case ledge, Windows workstation, CadQuery venv `C:/cqv`): pytest full suite 106/106 (80 builder + 26 spiral module; GOLDEN unchanged); API `chamber` + `chamberModel` + `chamberSaves` + `chamberPatchTypes` 123/123; web chamber 113/113; typecheck clean, lint 0 errors. Browser check not done.

## 8. History
- **2026-07-30**: creation of the standalone `/chamber` page (model X1..X3 → 12 parameters in `@dive/shared`, pure CadQuery builder, patches `inlet/outlet/cylinder_walls/walls`, STL/STEP/triSurface exports); length = 2 × width; `hollow` variant; 4 torque feet. `brain/changelog/2026-07.md`.
- **2026-07-31**: interdependency refinement, redesign of the feet (angle, gusset), identity H Kammer = LEB + LEOW. `brain/changelog/2026-07.md`.
- **2026-08-03**: guide vane ring; German labels for the 12 parameters; LEB = 2 × HLE; defaults 40° and cone 200 mm. `2026-08.md`.
- **2026-08-04/05**: toggleable relations (master + menu); `partScale`; separate `hub`/`shroud` patches; absolute `vaneAngleDeg` 45 to 55; **cache purge rule**. `2026-08.md`.
- **2026-08-06**: distributor via manifold boolean; outlet driven by X1 + `outletRatio`. `2026-08.md`.
- **2026-08-10/11**: analytic hub/shroud (P1/P2/P3, ellipse); chamfer toggle; last stepped cylinder through the ceiling; transfer to Meshing. `2026-08.md`.
- **2026-08-12/13**: feet toggle; 5 overrides (dFirst, dMiddle, generator); stepped refusal instead of shrinking; STEP with vanes as editable BREP. `2026-08.md`.
- **2026-08-31**: real pytest suite + CI job; warnings in the UI and `no effect` badge; rounded trailing edge; full-width page + saved builds; fit refusals (width, feet, chamfers) and With cone refused instead of shrunk. `2026-08.md`.
- **2026-09-01**: 50 mm rounding; mirrored STEP; deferred STEP; guide vanes checked by default; cache integrity (atomic writes, lock); input floors; UX consistency (STEP warnings, stale state, Min > Max). `2026-09.md`.
- **2026-09-02/03**: polish (saves, AA, exports); **Gen Dim v3** + `x4`; physical names X1..X4; **Simplify Generator**; unified vocabulary then "outlet" correction; fix of the "Inputs changed" banner. `2026-09.md`.
- **2026-09-04**: exact assignment of the vane skin (`49ab0d7`). `2026-09.md`.
- **2026-09-22**: spec + reference implementation of the semi-spiral tool (not integrated). **2026-09-28**: merge of PR #3 into `main` (`d43a6ce`); editable generator height in both designs; automatic chamber enlargement added then removed (refusal kept, by design); Closed generator minimum height (Gen Dim). **2026-09-29**: same minimum in With cone + Simplify generator, dome counted in it; every error of the page reworded (form names, mm, levers; `KO:` text shown alone); guide vanes vs Runner case Ø (WS-A); **Guide vane count 16 or 18** (WS-B); **Cone chamfer** (WS-C); **Semi-spiral casing** (WS-E). `2026-09.md`.

## 9. Known limits and bugs
See `brain/known-issues.md`:
- §6 (open threads, nothing requested): hub shoulder monotonicity (warning only); visual pass of Simplify Generator never done in the browser; inverted STL normals (deprioritized); save cascade on owner deletion (product decision); single-instance build lock.
- §7: **K8** (`scipy` missing from `requirements.txt`), **K10** (`mirrorStep.py`: usage error with exit code 1), **K11** (`--step` without `outletOuterD`/`outletRatio` = STEP without vanes; stale "no OCC boolean" comments), **K12** (`_test_hub_shroud_math.py` outside pytest), **K13** (heterogeneous `nFaces`, empty `edges.bin` with vanes), **K20** (hidden fields sent, `SendToMeshingDialog` accepts `name: ''`, a failed save deletion closes the confirmation), **K25** (`helpId` not wired to `aria-describedby`), **K29** (cache never purged by the code), **K30** (chamber test hygiene), **K31** (in-memory locks: single API instance).

Answer to K20 (code reading): the server does ignore the fields of the unselected variant (`wallThickness`, `hollowLength`, generator, `simplifyGenerator` are only read in hollow; `x4` never passed on). However `vaneAngleDeg` and `outletRatio` enter the hash even without vanes (§5.1).

**Doc/code discrepancies found while writing this sheet (2026-09-28, code reading, not fixed)**:
1. **Part scale in With cone**: the UI helper and the JSDoc of `ChamberInput.partScale` were fixed on 2026-09-28; the comment of `chamberBuildSchema` ("scaled down to fit"), the one of `resolveGeometryParams` ("The builder clamps up-scaling") and a comment in `buildChamber.py` ("Up-scaling is clamped below") still describe a shrinking; the builder has **refused** since 2026-08-31 (rechecked 2026-09-29).
2. **Stepped "outlet"**: `vocabulary.md` says that the outlet is never the middle cylinder and sits "further downstream" in a vane-less build; yet `classify` names `outlet` the side face of the median-z cylinder (the middle cylinder) in stepped without vanes. To clarify with the user (display rule only, or patch to revisit).
3. **With cone without vanes: no `outlet` patch** (only 3 patches), and no pytest fixture covers this case.
4. `ChamberInput.footAngleDeg` documented as "Default 45"; actual default 40 (schema, service, builder, form).
5. Spec 2026-08-06: field "Outlet inner/outer ratio" shown only with vanes and `outletRatio` set only with vanes; in reality the label is "Outlet ratio", the Vane angle and Outlet ratio fields are **always visible**, parameters always in the hash.
6. Spec 2026-08-11 (transfer): 404 `CHAMBER_NOT_BUILT` planned; the code returns **409**.
7. Parameter table: a chamfer ≤ 0 is marked "not buildable" even when Chamfer is unchecked, whereas the API exempts it (the table does not know `chamferEnabled`).
8. Superseded specs (normal, but not to be taken as the current state): 2026-08-03 (`guide_vane_walls` patch, "no OCC boolean"), 2026-08-06 §5.2 (piecewise remap, replaced by 2026-08-10), 2026-09-01 mirrored-step ("no lock", replaced by cache-integrity), 2026-09-01 deferred-step (`warnings.json` untouched, replaced by ux-consistency which merges), 2026-09-02 generator-dimensions (field "X4", renamed "Power (kW)"), 2026-09-02 vocabulary first pass ("Outlet Ø", canceled by the addendum).
9. The viewer's welcome message implies that the length is required (it is optional).

## 10. Changing this feature
- **Cache purge** after any change to `buildChamber.py`, its constants, its assets or `mirrorStep.py`: `rm -rf apps/api/storage/chamber/*` (the hash only sees the parameters). A change to `packages/shared` that changes Finals re-keys by itself.
- **`packages/shared` changed** ⇒ `npm run build:shared` before typecheck and tests (API and web read `dist/`).
- **Adding a field to the build**: `ChamberInput` (shared) → `chamberBuildSchema` (server default) → `resolveGeometryParams` (set it in `params` only if it changes the geometry, and only in the relevant variant to avoid needless re-keys) → read `P.get(..., default)` in `buildChamber.py` (default = previous behavior, for old `params.json`) → `ChamberFormValues`, `chamberFormSchema`, `CHAMBER_FORM_DEFAULTS`, `chamberInputToFormValues` (fallback for old saves) → `ChamberInputsForm` (+ `FIELD_LABELS` in `ChamberPage`) → tests of the three layers. No Prisma migration (JSON snapshot).
- **Renaming a label**: display only (`vocabulary.md` §1); never touch the keys, enums, snapshots or the hash. "outlet" = fluid exit. "Runner Ø" (X1) ≠ "Runner case Ø" (`dFirst`).
- **Builder KO/WARN texts**: locked by `test_build_chamber.py`, by the `chamber.test.ts` fixtures and by `ChamberBuildWarnings.test.tsx`; any rewording is done in all three.
- **Duplicated ratios**: `CHAMBER_D_FIRST_OVER_LAST`/`CHAMBER_D_MIDDLE_OVER_LAST` (TS) and `RATIO_D_FIRST_OVER_LAST`/`RATIO_D_MIDDLE_OVER_LAST` (Python) must stay equal.
- **Changing a pinned version** in `requirements-geometry.txt` can shift the tessellated volumes: refresh `GOLDEN` in the same commit.
- **Builder writes**: every new artifact goes through `<final>.tmp` + `os.replace`, and `chamber.glb` stays promoted last.
- **Gen Dim v3**: any change to the workbook is reflected in `computeChamberGeneratorDims` and in the parity tests (`chamberModel.test.ts`, `chamberForm.test.ts`).
- **UI**: skill sequence from `CLAUDE.md` §0, tokens only, a single orange CTA (Generate), small orange text as `accent-strong` (AA). Every code change is logged in the month's changelog and this sheet is updated in the same change.
- **Semi-spiral casing**: integrated on 2026-09-29 (§3.7). Out of scope, not designed: legs / torque feet with the spiral (refused), the straight approach channel, a live spiral preview, exposing `phi_start` or the clearance.

## 11. Local glossary
Full definitions and naming rules: `brain/conventions/vocabulary.md` (§1 rules, §3 geometric terms). Reminders: **chamber** (never "box" in the UI); **runner case** = first cylinder (`dFirst`); **middle cylinder** = middle cylinder (`dMiddle`, replaced by the vanes); **cone** = open cup of the With cone variant; **generator** = central cylinder; **hub / shroud** = inner / outer walls of the vane channel; **HLE** = height of the middle cylinder; **LEB** = runner case + middle cylinder; **LEOW** = height above; **H Kammer** / **B Kammer** = height / width of the chamber; **refusal** (build blocked) vs **warning** (build delivered with a note).

### Internal key → displayed label
| Internal key | Displayed label |
|---|---|
| `variant: 'stepped'` / `'hollow'` | Design: Closed generator / With cone |
| `x1` / `x2` / `x3` / `x4` | Runner Ø (mm) / Head (m) / Q_max (m³/s) / Power (kW) |
| `lengthOverride` | Length (mm) |
| `dFirst` | Runner case Ø (mm) |
| `dMiddle` | Guide vanes Ø (mm) |
| `hollowLength` / `wallThickness` | Cone length (mm) / Wall thickness (mm) |
| `centralDiameter` / `centralHeight` / `domeHeight` | Generator Ø (mm) / Generator height (mm) / Dome height (mm) |
| `simplifyGenerator` | Simplify generator |
| `coneChamferEnabled` / `coneChamferSize` | Cone chamfer / Cone chamfer size (mm) (not the corner **Chamfer**, `chamferEnabled`) |
| `semiSpiral` / `spiralFlowVelocity` | Semi-spiral casing / Casing flow velocity (m/s) |
| `tongue` (patch) | nose + plank of the semi-spiral casing |
| `relationsMaster` / `relations` | Structural relations / Configure relations |
| `guideVanes` / `chamferEnabled` / `feetEnabled` | Guide vanes / Chamfer / Feet |
| `footAngleDeg` / `partScale` | Foot angle (°) / Part scale (×) |
| `vaneAngleDeg` / `vaneCount` / `outletRatio` | Vane angle (°) / Guide vane count / Outlet ratio |
| `width` / `height` | B Kammer / H Kammer |
| `distFromSideChamfer1` / `distFromEnd` | B1 / LT |
| `chamferLength1` / `chamferWidth1` / `chamferLength2` / `chamferWidth2` | LF1 / BF1 / LF2 / BF2 |
| `dLast` / `hMiddle` / `hMiddlePlusFirst` / `hLast` | LE (Durchmesser) / HLE / LEB / LEOW |
| export `stl` / `step` / `stepMirrored` / `trisurface` | STL / STEP (Download STEP) / Change rotational direction / OpenFOAM triSurface |
