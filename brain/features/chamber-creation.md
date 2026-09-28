# Feature · Chamber Creation

> **Status**: in production · **Updated**: 2026-09-28 (chamber fit + generator height)
> **Specs**: `brain/specs/2026-08-03-guide-vane-throat-design.md`, `2026-08-06-outlet-x1-ratio-design.md`, `2026-08-10-hub-shroud-x1-adaptation-design.md`, `2026-08-11-chamfer-disable-toggle-design.md`, `2026-08-11-stepped-last-cylinder-through-top-design.md`, `2026-08-11-chamber-to-meshing-transfer-design.md`, `2026-08-13-guide-vane-step-export-design.md`, `2026-08-31-chamber-fullwidth-and-saved-builds-design.md`, `2026-08-31-part-fit-refusals-design.md`, `2026-08-31-vane-te-rounding-design.md`, `2026-09-01-chamber-cache-integrity-design.md`, `2026-09-01-chamber-input-floors-design.md`, `2026-09-01-chamber-minor-polish-design.md`, `2026-09-01-chamber-ux-consistency-design.md`, `2026-09-01-deferred-vane-step-design.md`, `2026-09-01-empirical-50mm-rounding-design.md`, `2026-09-01-mirrored-step-download-design.md`, `2026-09-02-chamber-vocabulary-design.md`, `2026-09-02-generator-dimensions-design.md`, `2026-09-02-physical-input-names-design.md`, `2026-09-02-simplify-generator-design.md` (all under `brain/specs/`) · related plans under `brain/plans/`
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
- Table: a Final ≤ 0 (except `noEffect`) is shown in red with `! ≤ 0 mm` ("not buildable"); inline `! min>max` status; `refined` and `no effect` badges (doubled by `sr-only` text); confidence pill with the CV error visible (e.g. "Low · 38.9 %").
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

The X1..X3 bounds are the training range of the regressions; the server (zod `chamberBuildSchema`) and the form (`chamberFormSchema`) both enforce them.

### 3.2 The 12 derived dimensions (empirical model)
Single source: `CHAMBER_OUTPUT_SPECS` in `packages/shared/src/index.ts` (full-precision coefficients, complete table in `brain/codemap/root-shared-mcp.md`). Each output has its own X1..X3 fit (`linear`: a + b·X1 + c·X2 + d·X3, or `power`: k·X1^e1·X2^e2·X3^e3) and possibly a toggleable **structural relation**.

| Key | Label | Relation (all `defaultOn: true`) | Type |
|---|---|---|---|
| `width` | B Kammer | refine from the Exact of `distFromSideChamfer1` | refine |
| `height` | H Kammer | `= LEB + LEOW` | combination (identity) |
| `distFromSideChamfer1` | B1 | refine from the Exact of `width` | refine |
| `chamferLength1` | LF1 | none | |
| `chamferWidth1` | BF1 | `= LF1` | identity |
| `chamferLength2` | LF2 | `= LF1` | identity |
| `chamferWidth2` | BF2 | `= LF2` | identity |
| `distFromEnd` | LT | `= LF1 + LF2` | identity |
| `dLast` | LE (Durchmesser) | `= f(HLE)` = 255.16 + 3.4954 × HLE | **empirical** combination (`empirical: true`) |
| `hMiddle` | HLE | none | |
| `hMiddlePlusFirst` | LEB | `= 2 × HLE` | identity |
| `hLast` | LEOW | none | |

**Computation chain** (`computeChamberOutputs`):
1. Master switch `relationsMaster` (default true): `false` turns off all relations (hard override). Otherwise each relation follows `relations[key] ?? defaultOn`.
2. **Pass 1**: outputs without a relation, with the relation off, or with a `refine` relation (which reads the partner's **entered Exact** in `constraints`, not its Final; without a partner Exact, falls back to the base fit, `refined: false`).
3. **Pass 2**: active `combination` relations, resolved to a fixed point (LEB before H Kammer); they read the partners' **Final**, so an override propagates.
4. Each value goes through the 50 mm rounding (§3.4) then through Min / Max / Exact (§3.3).
5. `hLast` (LEOW) gets `noEffect` if the `height` relation is inactive or if `height` has an Exact: the builder never reads LEOW directly (the last stepped cylinder is pinned through the ceiling, the With cone variant ignores it).

The geometric options (§3.7) never influence the empirical model (`computeChamberOutputs`); since 2026-09-28 they can raise the chamber dimensions through the fit post-pass (§3.5b).

### 3.3 Min / Max / Exact constraints and statuses
- `ChamberConstraint { min?, max?, exact? }` per output; each value must be `> 0` and `≤ CHAMBER_DIMENSION_MAX_MM` (100,000 mm). In the table, `NumCell` only accepts `0 < v ≤ 100,000`; any other entry clears the constraint.
- Precedence: **Exact** wins (`set exact`); otherwise Min > Max gives `! min>max` and keeps the model value; otherwise clipping (`capped at max`, `raised to min`); otherwise `within range` (fit) or `from relation` (with `relationLabel`).
- `! min>max` **refuses** the build: on the web before any call (red panel + toast), on the API as 422 `VALIDATION_ERROR` ("Cannot build: inverted constraint range on B Kammer: Min 5000 > Max 4000…").

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

### 3.5b Chamber fit around the parts (since 2026-09-28)
The 12 fits are independent, so the model's chamber was often too small for the parts it sizes (≈ 70 % of the X1..X3 range refused with "would stick out of the box"). `fitChamberToParts(input, outputs)` (`@dive/shared`), run by the API before building and by the page for the live table, raises the AUTO B1, B Kammer, LT, H Kammer and length to the next 50 mm step that holds the scaled parts: runner case / cylinders, the exact swung foot footprint, the guide-vane distributor (0.6 × dMiddle, dLast/2 + 10 mm), the two chamfer faces (moves LT), and the stack height (Closed generator: LEB + 30 mm, or LEB + Generator height; With cone: LEB + max(cone, generator + dome); Simplify: LEB + max(cone, typed height)). Raised outputs show the status **raised to fit**; an Exact is never raised, a Max caps the raise, a typed Length is kept (the builder then refuses as before). A raised H Kammer marks LEOW `no effect`. Part scale therefore grows the chamber instead of being refused. The builder keeps its own refusals as the safety net (constants mirrored, keep in sync). Decision: user, 2026-09-28.

### 3.6 Manual overrides and cascade
All in mm, optional; empty = auto (`setValueAs: numOrUndef`, `placeholder="auto"`, help "Blank = auto ≈ N mm"). Bounds: `> 0`, `≤ 100,000`.

| Key | Label | Auto (if empty) | Scope |
|---|---|---|---|
| `lengthOverride` | Length (mm) | `2 × width.final` (help "Blank = 2 × width ≈ N mm") | both designs |
| `dFirst` | Runner case Ø (mm) | `1.14703 × dLast` (`CHAMBER_D_FIRST_OVER_LAST`) | both designs |
| `dMiddle` | Guide vanes Ø (mm) | `0.8 × dLast` (`CHAMBER_D_MIDDLE_OVER_LAST`); also sets the diameter of the vane ring | both designs |
| `hollowLength` | Cone length (mm) | **required** in With cone (form default 200) | With cone |
| `wallThickness` | Wall thickness (mm) | `CHAMBER_WALL_THICKNESS_MM` = 50 | With cone |
| `x4` | Power (kW) | Gen Dim v3 | With cone |
| `centralDiameter` | Generator Ø (mm) | Gen Dim v3 | With cone |
| `centralHeight` | Generator height (mm) | With cone: Gen Dim v3. Closed generator and Simplify generator: blank = through the chamber top (hint "≈ (H Kammer − Part scale × LEB) / Part scale"); a value = flat-topped cylinder closed below the top (a top within 1 mm of the chamber top is pinned like blank; taller than H Kammer allows = refusal unless H Kammer is auto, then it is raised) | both designs (since 2026-09-28) |
| `domeHeight` | Dome height (mm) | Gen Dim v3; ignored if Simplify generator | With cone |

- `dFirst`/`dMiddle` are sent to the builder **unscaled** (m): the builder multiplies them by `partScale`; without an override it applies its own copies of the ratios to the already scaled `dLast`. The ratios therefore exist twice (TS and Python): keep them in sync.
- The web hint `computeChamberAutoDims` calls the same shared function with the current overrides: hints and build cannot diverge.

### 3.7 Geometric options (outside the empirical model)
All of them enter the build hash (unless stated) and never affect the 12 outputs.

| Key | UI label | Form default | API default | Range | Effect |
|---|---|---|---|---|---|
| `variant` | Design: "Closed generator" (`stepped`) / "With cone" (`hollow`) | `stepped` | `stepped` | enum | Stepped: three stacked solid cylinders, last cylinder pinned **through** the ceiling at any scale. Hollow: solid runner case + middle cylinder, last cylinder as a **cone** (open cup, wall and bottom of thickness `wallThickness`), central **generator** + semi-ellipsoidal dome. |
| `relationsMaster` / `relations` | Structural relations + "Configure relations (n/9 on)" | true / all on | true / defaults | bool | §3.2 (these two fields enter the hash only through the Finals). |
| `guideVanes` | Guide vanes | **true** | **false** | bool | Replaces the middle cylinder with a distributor of 16 guide vanes (both designs). Caution: a direct API call without this field builds **without** vanes. |
| `vaneAngleDeg` | Vane angle (°) | 50 | 50 | 45 to 55 | Absolute opening angle; each vane pivots by `vaneAngleDeg − 50` around its axis. Only useful with vanes. |
| `outletRatio` | Outlet ratio | 0.45 | 0.45 | 0.35 to 0.50 | Outlet inner radius = ratio × outer radius (= X1/2). Only useful with vanes. |
| `chamferEnabled` | Chamfer | true | true | bool | Cuts (or not) the two corners of the chamfered end; does not move the axis, does not change the table. |
| `feetEnabled` | Feet | true | true | bool | Carves (or not) the 4 torque feet (leg + gusset plank). |
| `footAngleDeg` | Foot angle (°) | 40 | 40 | 0 to 180 | 0/180 tangential, 90 radial; the gusset only exists between ≈ 37° and 143°, excluding ≈ 90° (otherwise refusal). |
| `partScale` | Part scale (×) | 1 | 1 | > 0, ≤ 5 | Uniform scale of the inner assembly (cylinders, cone, generator, dome, feet, vanes, dFirst/dMiddle overrides). The chamber (width/length/height), the chamfers and the axis do not move. Any height overflow is **refused** in both designs (§3.8). |
| `simplifyGenerator` | Simplify generator | false | false | bool | With cone only: generator as a plain cylinder with no dome, pinned through the ceiling unless a Generator height is typed (then closed below it); `domeHeight` hidden and omitted, `centralHeight` sent only when typed. In stepped, the flag is not passed on (no re-key). |

### 3.8 Refusals and warnings
**API refusals before any build** (422 `VALIDATION_ERROR`, CadQuery never started):
- zod schema: X1..X3 out of range, dimensions ≤ 0 or > 100,000, `x4` outside ]0, 100,000], `footAngleDeg` outside [0, 180], `vaneAngleDeg` outside [45, 55], `outletRatio` outside [0.35, 0.50], `partScale` outside ]0, 5], With cone without `hollowLength`;
- Final ≤ 0 (`nonPositiveChamberFinals`, except `noEffect`; the 4 chamfers LF1/BF1/LF2/BF2 are exempt if `chamferEnabled === false`, LT and B1 always count): message starting with "Cannot build: H Kammer = … mm", which lists each offending dimension and the levers (Runner Ø / Head / Q_max, relations, constraints);
- Min > Max (§3.3).

**Builder refusals** (`ValueError`/`RuntimeError` ⇒ `KO:` + exit code 1 ⇒ API 502 `CHAMBER_BUILD_FAILED` with the tail of stderr, shown as is in "Build errors"):
- base dimensions ≤ 0, `hFirst = LEB − HLE ≤ 0`, B1 outside ]0, width[, LT outside ]0, length[;
- active chamfer with a setback ≤ 0 ("…disable the chamfer instead of zeroing it") or larger than the chamber;
- `footAngleDeg` outside [0, 180], `partScale ≤ 0`, `vaneAngleDeg` outside 45..55;
- invalid With cone parameters (`wallThickness` outside ]0, dLast/2[, `hollowLength ≤ wallThickness`, dimensions ≤ 0);
- **height overflow**: stepped, the shoulder (runner case + middle cylinder, = 2 × HLE) must leave at least `MIN_LAST_CYL_H` (50 mm) of last cylinder ("the cylinder shoulder … but H Kammer only allows …"); With cone, `first + middle + max(cone, generator + dome)` must fit under H Kammer, and the message gives the `Part scale ≤ X` that would pass ("H Kammer only allows … reduce Part scale to <= …"); in Simplify generator only the runner case + middle + cone stack counts ("the hollow cone stack …");
- axis in a chamfered corner ("lies inside the … corner cut");
- part too wide: `max(dFirst, dMiddle, dLast)/2` compared with the four walls (B1, B Kammer − B1, LT, Length − LT) and the two chamfer faces ("… so it would stick out of the box" / "… would stick out through the … chamfer face");
- foot outside the chamber, tested on the exact rotated footprint ("a torque foot reaches (x, y) m, outside the …");
- vane distributor outside the chamber, tested on the actual radial reach of the vane + hub + shroud meshes ("the guide-vane distributor (blades + shroud) …");
- impossible gusset ("footAngleDeg … cannot form the triangular gusset");
- internal: `could not find the inlet (min-Y) face`, `expected >=N cylindrical faces`, `no patches produced`.

**Warnings** (build delivered; `WARNING:` lines on stdout and `WARN:` on stderr, collected by `^WARN(?:ING)?:\s*(.+)$`, stderr first, persisted in `warnings.json`, shown in "Build warnings" and returned on every cache hit):
- `outlet outer radius … clamped to … (Runner Ø too large for this vane/d_last combination)`: outlet radius capped at `0.97 × R_anchor`;
- `hub shoulder non-monotonic (Runner Ø too large for the point spacing)`: hub P1 > P2 fold (≈ Runner Ø 2179 mm at ratio 0.45), never refused;
- `central diameter … exceeds the hollow bore …`;
- `could not write edges.bin`;
- `OCC vane STEP reconstruction failed` and `chamber.step falls back to the vane-less solid (no vanes carved)` (only during a `--step` pass, merged into `warnings.json`).

The builder texts still use "box" and "cylinder shoulder" (vocabulary not swept, locked by the pytest assertions).

### 3.9 Patches produced (exact list)
| Configuration | Patches, in emission order | Source |
|---|---|---|
| Closed generator (`stepped`) without vanes | `inlet`, `outlet`, `cylinder_walls`, `walls` | OCC BREP faces (`classify`) |
| With cone (`hollow`) without vanes | `inlet`, `cylinder_walls`, `walls` (**no `outlet`**) | OCC BREP faces |
| With vanes (both designs) | `inlet`, `cylinder_walls`, `walls`, `hub`, `shroud`, `outlet`, `guide_vanes` | triangles of the boolean fluid `fluid_F` |

- Types (`PATCH_TYPES`): `inlet` and `outlet` = `patch`; `cylinder_walls`, `walls`, `hub`, `shroud`, `guide_vanes` = `wall`. A patch with no face is omitted.
- `inlet` = planar face at minimal Y (non-chamfered end of the chamber). `walls` = the chamber faces. `cylinder_walls` = all faces of the inner pocket (cylinders, cone, generator, dome, feet) whose vertices are all within `max(rmax, outer radius of the feet) + 0.1 m` of the axis.
- Stepped without vanes: `outlet` = the cylindrical face at median z, i.e. the side wall of the **middle cylinder** (see §9, discrepancy with the vocabulary rule).
- With vanes: `outlet` = flat ring at the actual floor between `ri` and `ro`; `hub` = inner wall of the channel (roof, shoulder, vertical duct down to the floor); `shroud` = outer wall (elliptical fillet, floor, duct); `guide_vanes` = skin of the 16 vanes.
- `trisurface.zip` contains one ASCII `<patch>.stl` per patch **plus** `domain.stl` (concatenation, never transferred to Meshing: `CHAMBER_TRANSFER_EXCLUDED_STL`).

## 4. Technical flow

### 4.1 Live computation (web)
`ChamberPage` owns the react-hook-form instance (`zodResolver(chamberFormSchema)`, `mode: 'onChange'`, defaults `CHAMBER_FORM_DEFAULTS`) and the `constraints` state. `useMemo` calls `computeChamberOutputs({ x1, x2, x3, constraints, relationsMaster, relations })` on every change; `computeChamberAutoDims(values, dLast.final)` provides the hints; `autoLengthMm = 2 × width.final`. No network call.

### 4.2 Build: web → API → builder
1. `onGenerate` (`handleSubmit`): local Min > Max check, then `useBuildChamber().mutate({ ...values, constraints })` → `buildChamber` (`lib/api/chamber.ts`) → `POST /api/v1/chamber/build` (`requireAuth`, `validate(chamberBuildSchema)`).
2. `buildChamberController` → `chamber.service.buildChamber(input)`:
   - `computeChamberOutputs(input)`; non-positive and Min > Max refusals (§3.8);
   - `resolveGeometryParams(input, outputs)`: parameters **in meters** (§5.1); for `hollow`, `computeChamberGeneratorDims(...).resolved`;
   - `hash = chamberHash(params)`;
   - under `withChamberLock(hash)`: if `chamber.glb` exists, **cache hit** (returns `warnings.json` and `build-meta.json`); otherwise checks the script (500 `SCRIPT_MISSING`), writes `params.json`, runs `CHAMBER_PYTHON_BIN buildChamber.py <params.json> <dir>` (cwd = build folder, timeout `CHAMBER_BUILD_TIMEOUT_MS`); failure, timeout, missing binary or no GLB ⇒ 502 `CHAMBER_BUILD_FAILED`; otherwise extracts and persists the warnings.
   - Response `200 { hash, outputs, warnings, stepHasVanes }` (`stepHasVanes`: `true`/`false` if a STEP with vanes has already been generated, `null` otherwise).
3. Web: `setHash`, `setLastBuildInput(body)`, `setBuildWarnings`, `offerMirror = guideVanes && stepHasVanes !== false`.

### 4.3 Geometric construction (`buildChamber.py main()`)
Protocol: `python buildChamber.py <paramsJson> <outDir> [--step]`; success `OK: <n> patches -> …/chamber.glb` (exit code 0); failure `KO: <message>` on stderr (exit code 1); usage (exit code 2).
1. Reading of the parameters (m) and common validations (§3.8).
2. Unscaled stack dimensions per variant, height check at the requested `partScale` (refusal).
3. Scaling: `dLast`, `hMiddle`, `hFirst` × `partScale`; `dFirst`/`dMiddle` = override × `partScale` or ratio × `dLast`.
4. Inner part: stepped `make_part` (last cylinder of local height `H + 2·FLOOR_OVERCUT − (hFirst + hMiddle)`, hence open through the ceiling; middle cylinder omitted with vanes); hollow `make_part_hollow` (open cone, generator, dome `make_dome`, or pinned generator without dome in Simplify generator). Positive-height guard.
5. `make_box`: box `width × length × height` with two asymmetric chamfers on the vertical corners of the `+Y` end (large chamfer on the `+X` side), or an intact box if `chamferEnabled` is false.
6. Axis positioning: `target_x = width/2 − B1`, `target_y = length/2 − LT`, part lowered to `z = −H/2 − FLOOR_OVERCUT` (FLOOR_OVERCUT = 10 mm, opens the floor).
7. Fit checks: axis in a corner, radius `rmax` against walls and chamfer faces, exact footprint of the feet.
8. `make_feet` if `feetEnabled` (4 voids at 0/90/180/270°, dimensions × `partScale`).
9. Vanes: the first cylinder is hollowed over the whole disk `r < dLast/2` (it only keeps its outer ring).
10. `result = box.cut(part).cut(feet)` (OCC fluid solid), then `classify` of the BREP faces.
11. Vanes only: `make_vane_patches` (ring at the `dMiddle` scale, height filling the HLE band, step `vaneAngleDeg − 50`, rims `ro = min(X1/2, 0.97·R_anchor)` and `ri = outletRatio · ro`, analytic hub P1/P2/P3 and quarter-ellipse shroud `a = 0.160·ro`, `b = 0.119·ro` when `outletOuterD`/`outletRatio` are provided, otherwise the legacy "fallback" path); distributor fit refusal; hub/shroud ducts down to the floor; flat ring outlet; **manifold boolean**: `distributor solid = hub core ∪ shroud casing ∪ vane prisms` (trailing edge rounded by `_round_blade_te`), `fluid_F = tessellation(result) − distributor`.
12. Atomic writing of the artifacts (§4.5).

### 4.4 Patch classification (builds with vanes)
Each triangle of `fluid_F` is labeled by the nearest source (centroid KD-tree, `_label_by_nearest_source`) among `inlet`, `walls`, `cylinder_walls` (bottom disk of the upper cylinder removed), `hub`, `shroud`, `outlet`. Deterministic overrides then: horizontal floor ring `[ri, ro]` → `outlet`; horizontal ring at the roof `z_mid_top`, `r ≤ dLast/2` → `hub`; vertical walls below the passage at `r ≈ ri` → `hub`, at `r ≈ ro` → `shroud`; finally the **vane skin**, assigned last by an exact test (`_blade_skin_mask`: centroid within `VANE_SKIN_TOL` = 1 mm of a vane outline in XY AND `|nz| < 0.5`) → `guide_vanes`. The vanes are deliberately not a voting source (fix of 2026-09-04).

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
- **Compatibility of old saves**: `chamberInputToFormValues` falls back to `CHAMBER_FORM_DEFAULTS` for any missing field with a server default (`variant`, missing relations, `footAngleDeg`, `partScale`, `guideVanes`, `chamferEnabled`, `feetEnabled`, `vaneAngleDeg`, `outletRatio`, `simplifyGenerator`); missing overrides stay empty (auto); missing `x4` = auto. `hollowLength` and `wallThickness` are **not** defaulted (a With cone save always contains `hollowLength`, required by the schema; a missing `wallThickness` stays empty and equals 50 mm on the server; a stepped save whose snapshot does not carry `hollowLength`, loaded then switched to With cone, therefore shows an empty Cone length to fill in). Hidden fields (e.g. `x4` in stepped, heights in Simplify) stay in the snapshot and are ignored by the server.

### 4.8 "Inputs changed since this build" detection
`isStale = hash !== null && lastBuildInput !== null && chamberBodyKey({ ...values, constraints }) !== chamberBodyKey(lastBuildInput)`. `chamberBodyKey` serializes after recursively sorting the keys (`watch()` and the zod output of `handleSubmit` do not order keys the same way; an `undefined` key is equivalent to an omitted key). Cause of the stuck banner fixed on 2026-09-03. The comparison is on the **body**, not on the hash: changing a field with no geometric effect (e.g. `x4` in stepped) also shows the note.

### 4.9 Transfer to Meshing
`SendToMeshingDialog` (modes `new`: name prefilled `chamber-<first 8 characters of the hash>` + engine `snappy`/`cfmesh`; `existing`: chosen session; `copyFrom`: copy of a session's setup + optional name) → `useTransferChamberToMeshing` → `POST /api/v1/meshing/from-chamber` `{ mode, chamberHash, … }` → `meshing.service.importChamberIntoMeshing`: reads `trisurface.zip` via `readChamberExport` (409 `CHAMBER_NOT_BUILT` if absent), keeps all `*.stl` except `domain.stl` (422 `INVALID_STL` if none), resolves the target session (`createSessionDir`, `requireSession`, or `copySessionSetup` = engine + `config.json` + surfaces, without run output), then `addStlFiles` (STL validation, cfMesh rules, **overwrite by name**; surfaces whose names are absent from the build stay in place). On success: navigation to `/meshing/<id>`. snappy uses one STL per patch, cfMesh merges them at run time. Same path as the one planned for a future optimization loop (`POST /chamber/build` then `from-chamber` `copyFrom` then run).

## 5. Data and storage

### 5.1 Build cache `<STORAGE_DIR>/chamber/<hash>/`
- Global, not tied to a project, shared by the team. Tree: `params.json`, `chamber.glb`, `manifest.json`, `edges.bin`, `warnings.json`, `build-meta.json`, `exports/{chamber.stl, chamber.step, chamber-mirrored.step, trisurface.zip}`, and `_debug/` if `CHAMBER_DEBUG_DUMP`.
- **Key**: `chamberHash(params)` = SHA-1 of the JSON of the sorted `[key, value]` pairs, truncated to 16 hex. `params` contains: `length`, `variant`, `footAngleDeg`, `guideVanes`, `chamferEnabled`, `feetEnabled`, `vaneAngleDeg`, `partScale`, `outletRatio`, `outletOuterD` (= X1 in m), `dFirst`/`dMiddle` if entered, the 12 Finals (m); in hollow `wallThickness`, `hollowLength`, `centralDiameter`, `simplifyGenerator` and, outside Simplify, `centralHeight`, `domeHeight` (in Simplify, `centralHeight` only when typed); in stepped `centralHeight` only when typed. The 12 Finals and `length` are those AFTER `fitChamberToParts`. **Not included**: `x4`, `relations`, `constraints` (only via the Finals), the Python code version, its constants and its assets.
- Consequences: explicitly sending the auto values gives the same hash as empty fields; `vaneAngleDeg`, `outletRatio` and `outletOuterD` are set even without vanes, so changing them re-keys a vane-less build (identical geometry, rebuilt).
- **Completeness** = presence of `chamber.glb` (`chamberGlbExists`). A killed build leaves at most `.tmp` files and partial artifacts, never a GLB: the next request rebuilds.
- **Lock**: `withChamberLock(hash, fn)`, promise-chain mutex **in process memory**, around the cache check + build, and around the `step`/`stepMirrored` generation (state rechecked inside the lock). Reads without lock (safe thanks to atomic writes). Only one API instance supported (K31).
- **Mandatory purge**: the hash does not capture the code. **Any change to `buildChamber.py`, its constants or its assets requires `rm -rf apps/api/storage/chamber/*`** (decision of 2026-08-05). The code never purges this cache (K29); no quota and no eviction.
- `CHAMBER_DEBUG_DUMP` (non-empty): builds with vanes, writes `<outDir>/_debug/` (`core.stl`, `casing.stl`, `result.stl`, `hub_throat.stl`, `hub_source.stl`, `shroud_source.stl`, `vanes_source.stl`, `F.stl`, `meta.json`), consumed by `_verify_outlet_ratio.py`. `CHAMBER_STEP_DEBUG`: `STEPDBG` traces of the STEP pass.

### 5.2 Database
Prisma model `ChamberSave` (migration `20260831142110_chamber_saves`): `id` (cuid), `name` globally **unique**, `ownerId` → `User` (**cascade** on deletion of the owner, deliberate choice aligned with `Project`/`Template`), `snapshot` (TEXT, JSON of `ChamberInput`), `createdAt`, `updatedAt`, index `ownerId`. No column per field: a new `ChamberInput` field goes through without a migration.

## 6. Configuration and external dependencies
- `CHAMBER_PYTHON_BIN` (default `python` on Windows, `python3` elsewhere): dedicated venv with `cadquery`, `trimesh`, `numpy`, and for builds with vanes `scipy` (`PchipInterpolator`, `cKDTree`), `shapely`, `manifold3d`, `networkx`. Reference pinned versions: `apps/api/scripts/requirements-geometry.txt` (cadquery 2.8.0, trimesh 4.12.2, numpy 2.4.6, scipy 1.18.0, manifold3d 3.5.2, shapely 2.1.2). `requirements.txt` does not include `scipy` (K8).
- `BUILD_CHAMBER_SCRIPT`, `MIRROR_STEP_SCRIPT`: path overrides (default: `apps/api/scripts/*.py` resolved from the module). `CHAMBER_BUILD_TIMEOUT_MS` (default 600,000): builds, `--step` passes and mirrors.
- Assets committed under `apps/api/scripts/assets/`: `guideVanes.json` (metadata: `pivotRadius` 0.86732, 16 vanes at 22.5°, rims 0.29573 / 0.65500…), `guideVanes_blade.stl`, `guideVanes_walls.stl` (fallback), `guideVanes_outlet.stl`, `guideVanes_blade_profile.json` (vane profile for the STEP). Produced offline by `preprocessVanes.py` and `bakeVaneBladeProfile.py`.
- Without an interpreter or without CadQuery: 502 `CHAMBER_BUILD_FAILED` ("Could not start the chamber builder…"); missing script: 500 `SCRIPT_MISSING`. The live table computation always works (pure TS).
- Business source for Gen Dim v3: `documents/Gen Dim v3 Only Calculator (standalone).xlsx` (if its formulas change, `computeChamberGeneratorDims` and the parity tests follow).

## 7. Tests
- **API** (`apps/api/tests/`, builder and mirrorer simulated by fake runners, they never run CadQuery):
  - `chamber.test.ts`: build (401, hash + 12 outputs, manifest, GLB, STL `immutable`), `WARN:`/`WARNING:` warnings persisted and replayed on cache hit, deferred STEP (`--step` on the first download then served from disk), mirrored STEP (generates the STEP then mirrors, once), 409 for fallback or vane-less build, 502 then recovery, per-hash lock (concurrent builds, STEPs and mirrors = one execution), 422 refusals (Final ≤ 0, Min > Max, zod bounds, `x4`, `outletRatio`, `footAngleDeg`, hollow without `hollowLength`), cache keys (each flag and override re-keys without changing the outputs; `x4` and `simplifyGenerator` without effect in stepped; hidden heights out of the key in Simplify; explicit auto values = same hash), constraints and refinement.
  - `chamberModel.test.ts`: 12 fits, 50 mm rounding, relations and statuses, `userDriven`, `noEffect`, `nonPositiveChamberFinals`, Gen Dim v3 parity (frames, length code, cascade).
  - `chamberSaves.test.ts`: CRUD, 401/403/404/409/422, super-admin, normalized snapshot.
  - `meshing.test.ts`: `from-chamber` transfer (new, existing, copyFrom), exclusion of `domain.stl`, 409 `CHAMBER_NOT_BUILT`.
- **Real geometry** (`apps/api/scripts/tests/test_build_chamber.py`, pytest, CI job `geometry` = authority; skipped without CadQuery): 5 fixtures (`stepped`, `stepped-feet-off`, `stepped-vanes`, `hollow-vanes`, `hollow-vanes-overrides`) with golden volumes (`VOL_RTOL` 5e-3) and exact patch lists; `OK:`/`KO:` contract, watertight STL, zip content, `edges.bin`, absence of STEP and `build-meta.json` without `--step` for vanes, `stepHasVanes: true` with `--step`, no leftover `*.tmp`, refusals (height, width, feet, zero chamfer, axis in a corner, distributor), Simplify generator (section below the ceiling: 2 loops versus 1), trailing edge rounding, vane skin exclusively in `guide_vanes`, mirror (volume, box, reflected center of mass). **No With cone fixture without vanes.**
- **Web** (`apps/web/src/features/chamber/*.test.ts(x)`): `chamberForm` (schema, defaults, snapshot round-trip, `chamberBodyKey`, `computeChamberAutoDims`), `ChamberInputsForm`, `ChamberOutputsTable`, `ChamberBuildWarnings`, `ChamberExportButtons`, `ChamberSavesMenu`, `SendToMeshingDialog`. No test for `ChamberPage` (stale state, silent refresh, reset on load checked manually).
- Last known state (2026-09-04, `brain/STATUS.md`): pytest 29/29; API `chamber` 36, `chamberModel` 43, `chamberSaves` 8; web chamber 79/79. Not rechecked since the merge.

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
- **2026-09-22**: spec + reference implementation of the semi-spiral tool (not integrated). **2026-09-28**: merge of PR #3 into `main` (`d43a6ce`). `2026-09.md`.

## 9. Known limits and bugs
See `brain/known-issues.md`:
- §6 (open threads, nothing requested): hub shoulder monotonicity (warning only); builder texts in the old vocabulary; visual pass of Simplify Generator never done in the browser; inverted STL normals (deprioritized); save cascade on owner deletion (product decision); single-instance build lock; integration of the semi-spiral tool.
- §7: **K8** (`scipy` missing from `requirements.txt`), **K10** (`mirrorStep.py`: usage error with exit code 1), **K11** (`--step` without `outletOuterD`/`outletRatio` = STEP without vanes; stale "no OCC boolean" comments), **K12** (`_test_hub_shroud_math.py` outside pytest), **K13** (heterogeneous `nFaces`, empty `edges.bin` with vanes), **K20** (hidden fields sent, `SendToMeshingDialog` accepts `name: ''`, a failed save deletion closes the confirmation), **K25** (`helpId` not wired to `aria-describedby`), **K29** (cache never purged by the code), **K30** (chamber test hygiene), **K31** (in-memory locks: single API instance).

Answer to K20 (code reading): the server does ignore the fields of the unselected variant (`wallThickness`, `hollowLength`, generator, `simplifyGenerator` are only read in hollow; `x4` never passed on). However `vaneAngleDeg` and `outletRatio` enter the hash even without vanes (§5.1).

**Doc/code discrepancies found while writing this sheet (2026-09-28, code reading, not fixed)**:
1. **Part scale in With cone**: the UI helper ("with cone: scaled down to fit"), the JSDoc of `ChamberInput.partScale`, the comment of `chamberBuildSchema`, the one of `resolveGeometryParams` ("The builder clamps up-scaling") and a comment in `buildChamber.py` still describe a shrinking; the builder has **refused** since 2026-08-31.
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
- **Semi-spiral tool** (`documents/Semi-spiral-creation/SEMI_SPIRAL_TOOL_SPEC.md`, 7 inputs → 6 spiral segments + 3 tongue segments): meant to be integrated here, not started, not requested. Leads noted in the changelog of 2026-09-22 (phase 1 via Exact overrides of the chamber outputs, phase 2 in the builder).

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
| `relationsMaster` / `relations` | Structural relations / Configure relations |
| `guideVanes` / `chamferEnabled` / `feetEnabled` | Guide vanes / Chamfer / Feet |
| `footAngleDeg` / `partScale` | Foot angle (°) / Part scale (×) |
| `vaneAngleDeg` / `outletRatio` | Vane angle (°) / Outlet ratio |
| `width` / `height` | B Kammer / H Kammer |
| `distFromSideChamfer1` / `distFromEnd` | B1 / LT |
| `chamferLength1` / `chamferWidth1` / `chamferLength2` / `chamferWidth2` | LF1 / BF1 / LF2 / BF2 |
| `dLast` / `hMiddle` / `hMiddlePlusFirst` / `hLast` | LE (Durchmesser) / HLE / LEB / LEOW |
| export `stl` / `step` / `stepMirrored` / `trisurface` | STL / STEP (Download STEP) / Change rotational direction / OpenFOAM triSurface |
