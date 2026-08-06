# Guide-vane outlet — X1-driven diameter + configurable ratio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide-vane outlet outer diameter tracks X1 (the empirical model's first input), and the inner/outer ratio becomes a user-configurable parameter (default 0.45, range 0.35–0.50), while the hub and shroud profiles stay geometrically unchanged except in the outlet throat/fillet region.

**Architecture:** `outletRatio` is plumbed end-to-end like the existing `vaneAngleDeg` parameter (shared type → API zod schema → service → Python params JSON); X1 is resolved to a metres diameter (`outletOuterD`) in the API service layer and never reaches Python as a raw model input. In `buildChamber.py`, `make_vane_patches` measures the vane's own minimum working radius (`R_anchor`) from the placed/pitched reference blade, resolves the two outlet target rims (with a clamp against `R_anchor` if X1 is too large), and replaces the old single-rim linear radial remap with a monotonic piecewise-linear remap pinned at both rims and fading to identity at `R_anchor` — so the hub roof, shroud brim, and vane band are never touched, and everything downstream (ducts, outlet annulus, hub-core/shroud-casing solids, patch classification) consumes the two resolved rims exactly as it does today.

**Tech Stack:** TypeScript (Fastify API + Zod, React web form), Python 3 (CadQuery/OCP + trimesh/numpy/scipy, run under a dedicated venv).

**Reference spec:** `docs/superpowers/specs/2026-08-06-outlet-x1-ratio-design.md` (read alongside this plan — this plan follows it section by section).

## Global Constraints

- Ratio field: **`outletRatio`**, default **0.45**, allowed range **0.35–0.50**. Plumbed exactly like `vaneAngleDeg` (not part of `CHAMBER_INPUT_RANGES`).
- Outer diameter: **`vane_outlet_ro = X1(mm) / 2 · 0.001`** (metres), resolved in the API service layer as a new params-JSON key **`outletOuterD`**; Python never reads X1 directly.
- Feasibility guard: **clamp + warn** — if the requested outer radius would reach or pass `VANE_OUTLET_SAFE_MARGIN` (0.97) of the vane's own inner working radius, clamp to that fraction and print a `WARNING:` line to stdout. The build still succeeds.
- Backward compatibility: when `outletOuterD`/`outletRatio` are **both absent** from the params JSON (old cached builds), reproduce today's exact historical formulas — byte-identical geometry.
- Non-guide-vane build path: **untouched** by every task in this plan.
- **Platform note (this environment):** `npx`/`node` are not on the Windows PATH; run them via `wsl -e bash -lc "cd /mnt/c/... && npx ..."`. The Python builder runs under the dedicated venv `/home/hristo/cadquery-env/bin/python`, also via WSL. Every Bash command below already includes the `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "..."` wrapper this session established — keep it.
- After any `buildChamber.py` change, **purge the build cache**: `rm -rf apps/api/storage/chamber/*` (stale hashed builds must not mask a broken change).
- Per `CLAUDE.md`, **log every code change at the bottom of `PLAN.md`** (French, matching the existing entries' style) — do this as the last step of each task that touches `buildChamber.py` or the API/web plumbing.
- **Do not `git commit` without the user's explicit go-ahead.** This repo's established workflow (see prior chamber-feature rounds in `PLAN.md`) is: build, verify, update `PLAN.md`, purge the cache, then stop and let the user review in the app before any commit. The final task ends at that checkpoint, not at a commit.

---

## Task 1: API plumbing — `outletRatio` end-to-end (shared type → zod schema → service → cache key)

**Files:**
- Modify: `packages/shared/src/index.ts` (near `ChamberInput.vaneAngleDeg`, ~line 2283)
- Modify: `apps/api/src/modules/chamber/chamber.schemas.ts` (near `vaneAngleDeg`, ~line 44)
- Modify: `apps/api/src/modules/chamber/chamber.service.ts` (`resolveGeometryParams`, ~lines 112–116)
- Test: `apps/api/tests/chamber.test.ts`

**Interfaces:**
- Consumes: existing `MM_TO_M` constant (`chamber.service.ts:39`), existing `input.x1` (already on `ChamberInput`).
- Produces: `ChamberInput.outletRatio?: number`; two new geometry-params keys read by Python in Task 3 — `params.outletRatio` (0.35–0.50, default 0.45) and `params.outletOuterD` (metres, = `input.x1 * MM_TO_M`). Both are unconditionally set (like `vaneAngleDeg`/`partScale` today), so they always join the cache-key hash.

- [ ] **Step 1: Add the shared type field**

In `packages/shared/src/index.ts`, right after the existing `vaneAngleDeg?: number;` field (around line 2283), add:

```ts
  /**
   * Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). The outlet's
   * OUTER diameter is X1 (see resolveGeometryParams); the inner diameter is
   * outletRatio * outer. Geometry-only (not part of the empirical model). Only
   * affects guide-vane builds (ignored when guideVanes is false).
   */
  outletRatio?: number;
```

- [ ] **Step 2: Add the API zod schema field**

In `apps/api/src/modules/chamber/chamber.schemas.ts`, right after the existing `vaneAngleDeg: z.number().finite().min(45).max(55).default(50),` line (line 44), add:

```ts
    // Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). The outlet's
    // outer diameter is X1; the inner diameter is outletRatio * outer. Guide-vane
    // builds only. A different ratio => a different cached build.
    outletRatio: z.number().finite().min(0.35).max(0.5).default(0.45),
```

- [ ] **Step 3: Wire it into the resolved geometry params**

In `apps/api/src/modules/chamber/chamber.service.ts`, right after the existing `params.partScale = input.partScale ?? 1;` line (line 116), add:

```ts
  // Outlet inner/outer ratio (0.35..0.50, default 0.45) — guide-vane builds only,
  // but set unconditionally (like vaneAngleDeg/partScale) so it is always part of
  // the cache key. Part of the cache key, so a new ratio => a new build.
  params.outletRatio = input.outletRatio ?? 0.45;
  // Outlet OUTER diameter tracks X1 directly (metres). X1 is mm; params are metres.
  // Part of the cache key, so a different X1 => a different build.
  params.outletOuterD = input.x1 * MM_TO_M;
```

- [ ] **Step 4: Write the two new tests**

In `apps/api/tests/chamber.test.ts`, add these two tests right after the existing `'keys the build on the guide-vanes flag'` test (after line 194):

```ts
  it('accepts an outlet ratio and keys the build on it', async () => {
    setCommandRunner(successRunner);
    const auth = authHeader(await createTestUser());

    const r35 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.35 })
      .expect(200);
    const r50 = await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.5 })
      .expect(200);

    // Different outlet ratio => different geometry => different cache key.
    expect(r35.body.hash).not.toBe(r50.body.hash);
  });

  it('rejects an outlet ratio outside 0.35-0.50', async () => {
    const auth = authHeader(await createTestUser());
    await request(app)
      .post('/api/v1/chamber/build')
      .set('Authorization', auth)
      .send({ ...BUILD, guideVanes: true, outletRatio: 0.6 })
      .expect(422);
  });
```

- [ ] **Step 5: Run the API test suite**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run chamber 2>&1 | tail -25"
```
Expected: `Tests  31 passed (31)` — the 29 existing `chamber.test.ts`/`chamberModel.test.ts` tests plus the 2 new ones added in this step.

- [ ] **Step 6: Typecheck the shared package and API**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/shared tsc --noEmit -p tsconfig.json && npx --workspace @dive/api tsc -p tsconfig.json --noEmit && echo TYPECHECK_OK"
```
Expected: `TYPECHECK_OK` with no errors printed above it.

- [ ] **Step 7: Leave uncommitted**

Per the Global Constraints, this repo's established workflow is a single batch commit after the WHOLE feature is reviewed in the app (see Task 6, Step 5). Do not commit here — leave the four modified files as uncommitted changes and move on to Task 2.

---

## Task 2: Web form — `outletRatio` field

**Files:**
- Modify: `apps/web/src/features/chamber/chamberForm.ts`
- Modify: `apps/web/src/features/chamber/ChamberInputsForm.tsx` (near the `vaneAngleDeg` field, ~lines 199–211)

**Interfaces:**
- Consumes: `ChamberFormValues` (existing interface in `chamberForm.ts`), the existing `<Field>`/`<Input>` components already imported in `ChamberInputsForm.tsx`, `register`/`errors` from the existing `useForm` hook in that file.
- Produces: `ChamberFormValues.outletRatio: number`, submitted as `outletRatio` in the POST body (already consumed by Task 1's API schema).

- [ ] **Step 1: Add the field to the form contract**

In `apps/web/src/features/chamber/chamberForm.ts`, add to the `ChamberFormValues` interface, right after `vaneAngleDeg: number;` (line 34):

```ts
  /** Outlet inner/outer diameter ratio (0.35..0.50, default 0.45). Guide-vane builds only. */
  outletRatio: number;
```

- [ ] **Step 2: Add it to the zod schema**

In the same file, in `chamberFormSchema`, right after the `vaneAngleDeg` field (lines 63–66):

```ts
    outletRatio: z
      .number({ invalid_type_error: 'Enter a number' })
      .min(0.35, 'Min 0.35')
      .max(0.5, 'Max 0.50'),
```

- [ ] **Step 3: Add the default**

In the same file, in `CHAMBER_FORM_DEFAULTS`, right after `vaneAngleDeg: 50,` (line 92):

```ts
  outletRatio: 0.45,
```

- [ ] **Step 4: Add the form field UI**

In `apps/web/src/features/chamber/ChamberInputsForm.tsx`, right after the closing `</Field>` of the "Vane angle (°)" field (line 211, before the grid's closing `</div>` on line 212), add:

```tsx
        <Field
          label="Outlet ratio"
          error={errors.outletRatio?.message}
          helperText="Guide-vane builds only: inner/outer diameter ratio 0.35–0.50 (0.45 = default)"
        >
          <Input
            type="number"
            step="0.01"
            min="0.35"
            max="0.5"
            {...register('outletRatio', { valueAsNumber: true })}
          />
        </Field>
```

- [ ] **Step 5: Typecheck the web app**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/web tsc --noEmit -p tsconfig.json && echo TYPECHECK_OK"
```
Expected: `TYPECHECK_OK` with no errors printed above it.

- [ ] **Step 6: Manual check in the app**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/web vite --port 5173 &"
```
Open the chamber-creation page in a browser, confirm the "Outlet ratio" field appears next to "Vane angle (°)", defaults to `0.45`, and rejects `0.6` (shows "Max 0.50"). Stop the dev server afterward.

- [ ] **Step 7: Leave uncommitted**

Same as Task 1, Step 7 — do not commit yet. Move on to Task 3.

---

## Task 3: `buildChamber.py` — resolve X1/ratio-driven outlet rims and the pinned-rim radial remap

This is the geometry core. It replaces `make_vane_patches`'s single-rim linear remap (`place_throat`) with a monotonic piecewise-linear remap pinned at both outlet rims and fading to identity at the vane's own inner working radius, and moves the outlet-rim resolution (with the clamp + warning) from `main()` into `make_vane_patches`, which now returns the resolved rims.

**Files:**
- Modify: `apps/api/scripts/buildChamber.py`
  - Module constants block (~line 82, near `VANE_BASE_ANGLE_DEG`)
  - `num()` helper block (~line 874)
  - `make_vane_patches` (currently lines 365–562) — full rewrite
  - `main()`'s guide-vane rim block (currently lines 1043–1063) and the `make_vane_patches` call site (currently lines 1085–1087)
- Create (scratch verification script, not committed): `apps/api/scripts/_verify_outlet_ratio.py`

**Interfaces:**
- Consumes: `vane_scale_and_height(meta, d_last)` (unchanged, existing function), `_split_hub_shroud(np, walls)` (unchanged), `_flat_annulus(...)` (unchanged), `P.get(key)` (existing params dict).
- Produces: `make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last, vane_angle_deg=0.0, outlet_outer_d=None, outlet_ratio=None)` returns a dict with all its current keys (`hub`, `hub_throat`, `shroud`, `outlet`, `guide_vanes`) **plus two new float keys**: `outlet_ri`, `outlet_ro`. `main()` reads these instead of pre-computing `vane_outlet_ri`/`vane_outlet_ro` itself.

- [ ] **Step 1: Add the safety-margin constant**

In `apps/api/scripts/buildChamber.py`, right after `VANE_BASE_ANGLE_DEG = 50.0` and its trailing comment (currently ending at line 84), add:

```python
VANE_OUTLET_SAFE_MARGIN = 0.97   # outlet outer radius clamp: stay this fraction inside
                                 # the vane's own inner working radius (R_anchor in
                                 # make_vane_patches) so the blade always has shroud/hub
                                 # material to seat on and never overhangs the hole.
```

- [ ] **Step 2: Add the optional-param reader next to `num()`**

Find this block (currently lines 874–875):
```python
        def num(key):
            return float(P[key])
```
Add right after it:
```python
        def num_opt(key):
            v = P.get(key)
            return float(v) if v is not None else None
```

- [ ] **Step 3: Replace `make_vane_patches` in full**

Replace the entire function (currently lines 365–562, from `def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last, vane_angle_deg=0.0):` through the closing `}` of its `return` dict) with:

```python
def make_vane_patches(trimesh, np, cx, cy, z_mid_base, z_mid_top, d_last, vane_angle_deg=0.0,
                       outlet_outer_d=None, outlet_ratio=None):
    """Return {patch_name: Trimesh} for the guide-vane throat: the SOLID vane
    surfaces (blades + contoured hub/shroud walls + the outlet annulus) that sit
    as obstacles in the fluid box, centred at (cx, cy).

    Uniform scale pins the blade PIVOT circle diameter (2 x pivotRadius) to the
    middle diameter (0.80 x d_last), preserving the blade angle and all radii. The
    band is then stretched/clipped VERTICALLY (a separate z scale) so the vane
    channel fills the HLE band exactly: the vane bottom lays on the first-cylinder
    top and the hub roof meets the upper-cylinder base. The curved throat keeps its
    shape (scaled in z, never flattened) and continues down to the outlet. No
    bounding cylinder is used — the vanes are obstacles in the open box cavity, so
    the fluid flows directly around them.

    `outlet_outer_d` (metres, the resolved X1) and `outlet_ratio` (0.35..0.50) size
    the OUTLET: outer radius = outlet_outer_d/2 (clamped, see VANE_OUTLET_SAFE_MARGIN
    below), inner radius = outlet_ratio * outer. Both None (old cached builds that
    predate this feature) reproduces the exact historical asset-derived rims. The
    hub throat, shroud and outlet asset are all remapped by a single monotonic
    piecewise-linear radius function pinned at the two outlet rims and fading to
    IDENTITY at the vane's own inner working radius (R_anchor) — so the vane band,
    hub roof and shroud brim/wall never move; only the outlet throat/fillet reshapes.
    Returns two extra float keys, "outlet_ri"/"outlet_ro", the resolved (possibly
    clamped) rims — main() uses these downstream instead of recomputing them."""
    adir = _vane_assets_dir()
    meta = _load_vane_meta()
    blade = trimesh.load(os.path.join(adir, "guideVanes_blade.stl"))
    walls = trimesh.load(os.path.join(adir, "guideVanes_walls.stl"))
    outlet_asset = trimesh.load(os.path.join(adir, "guideVanes_outlet.stl"))

    s, _ = vane_scale_and_height(meta, d_last)      # RADIAL scale: pivot Ø -> 0.80 d_last
    # Scale RADIALLY by s (fixes the blade pivot circle to 0.80 d_last, so the blade
    # ANGLE and all radii are preserved), then adapt VERTICALLY to the HLE band
    # [z_mid_base, z_mid_top] via the z scale sz = band / channel-height, anchored so
    # the BOTTOM stays fixed on the first-cylinder top and any change happens from the
    # top: the vane bottom (blade body bottom, asset z=blade_z0) lays on z_mid_base and
    # the hub roof (asset z=height) meets the upper-cylinder base z_mid_top. The vanes
    # ELONGATE or CLIP to fill the band; because the blade is prismatic, a pure z scale
    # never distorts its cross-section (same airfoil, taller/shorter). The hub adjusts
    # to the height (roof at z_mid_top, throat scaled in z, never flattened).
    # Anchor on the blade BODY bottom AT THE PIVOT RADIUS (the vane rotation axis),
    # NOT the global minimum: the blade has a small stub/pin at its inner edge that
    # dips ~0.0099 below the airfoil body. Seating that stub floats the whole blade
    # above the first-cylinder top; anchoring at the pivot bottom seats the body and
    # lets the stub embed into the seat. The fallback stays the global min for old
    # assets that predate the baked-in value.
    blade_z0 = float(meta.get("bladeBottomZ", blade.vertices[:, 2].min()))  # vane bottom at pivot (asset z)
    band = z_mid_top - z_mid_base                    # HLE band (first-cyl top -> upper-cyl base)
    sz = band / (meta["height"] - blade_z0)          # vertical scale: channel height -> HLE band
    z_sb = z_mid_base - blade_z0 * sz                 # asset z=0 offset; blade bottom -> z_mid_base

    def place(mesh):
        m = mesh.copy()
        m.apply_scale((s, s, sz))                   # radial s (angle preserved) + vertical sz
        m.apply_translation((cx, cy, z_sb))         # asset bottom (z=0) -> z_sb
        return m

    # Build the reference blade (placed + pitched) FIRST, before any outlet-rim
    # work: R_anchor (the vane's own inner working radius, below) is measured from
    # it, and pitch/placement only move the blade radially — the shroud-floor DRAPE
    # applied later only moves Z, so measuring here (pre-drape) is exact.
    bc = np.asarray(blade.vertices, dtype=float).mean(axis=0)
    theta0 = np.arctan2(bc[1], bc[0])               # reference blade angular position
    piv_x = meta["pivotRadius"] * s * np.cos(theta0) + cx
    piv_y = meta["pivotRadius"] * s * np.sin(theta0) + cy
    pang = np.radians(vane_angle_deg)
    Rp = np.array([[np.cos(pang), -np.sin(pang), 0, 0],
                   [np.sin(pang), np.cos(pang), 0, 0],
                   [0, 0, 1, 0], [0, 0, 0, 1]])

    base = place(blade)
    if vane_angle_deg:
        base.apply_translation((-piv_x, -piv_y, 0))     # pitch about the spindle
        base.apply_transform(Rp)
        base.apply_translation((piv_x, piv_y, 0))
    R_anchor = float(np.hypot(base.vertices[:, 0] - cx, base.vertices[:, 1] - cy).min())

    # OUTLET target rims: outer = outlet_outer_d/2 (the resolved X1, metres), inner =
    # outlet_ratio * outer. Both are None on old cached builds that predate this
    # feature — fall back to the exact historical asset-derived formulas so those
    # builds reproduce identical geometry. ro_natural/ri_natural (the UNCLAMPED,
    # asset-derived rims) are also the knots the remap below pins away FROM.
    ro_natural = meta["outletOuterR"] * s
    ri_natural = ro_natural + (meta["outletInnerR"] * s - ro_natural) * sz
    if outlet_outer_d is None or outlet_ratio is None:
        ro_target = ro_natural
        ri_target = max(ri_natural, 1e-3)
    else:
        ro_target = outlet_outer_d / 2.0
        if ro_target >= VANE_OUTLET_SAFE_MARGIN * R_anchor:
            print("WARNING: outlet outer radius %.4f clamped to %.4f "
                  "(X1 too large for this vane/d_last combination)"
                  % (ro_target, VANE_OUTLET_SAFE_MARGIN * R_anchor))
            ro_target = VANE_OUTLET_SAFE_MARGIN * R_anchor
        ri_target = max(outlet_ratio * ro_target, 1e-3)

    # The HUB throat, SHROUD and OUTLET are all remapped by the SAME monotonic
    # piecewise-linear radius function: pinned at (0,0), the two NATURAL asset rims
    # -> their TARGETS, and IDENTITY from R_anchor (the vane's own inner radius)
    # outward — so the vane band, hub roof and shroud brim/wall are geometrically
    # untouched; only the outlet throat/fillet (r <= R_anchor) reshapes. This is the
    # direct generalization of the old single-rim linear map (which pinned only the
    # shroud rim and extrapolated with slope sz all the way to the axis): now BOTH
    # rims are pinned independently, and the map stays flat (identity) past the vane
    # root instead of extrapolating into the vane band.
    def place_throat(mesh):
        m = mesh.copy()
        v = np.asarray(m.vertices, dtype=float)
        r = np.hypot(v[:, 0], v[:, 1])                       # asset radius about the ring axis
        r_scaled = r * s
        r_new = np.where(
            r_scaled <= R_anchor,
            np.interp(r_scaled, [0.0, ri_natural, ro_natural, R_anchor],
                      [0.0, ri_target, ro_target, R_anchor]),
            r_scaled,
        )
        r_new = np.maximum(r_new, 1e-3)
        ux = np.where(r > 1e-12, v[:, 0] / r, 0.0)           # unit radial (angle preserved)
        uy = np.where(r > 1e-12, v[:, 1] / r, 0.0)
        m.vertices = np.column_stack([cx + r_new * ux, cy + r_new * uy, z_sb + v[:, 2] * sz])
        return m

    # Split the passage walls into the HUB (top + inner surface) and the SHROUD
    # (bottom + outer surface) as SEPARATE CFD wall patches. Both surfaces curve
    # DOWN to the outlet, so a flat z cut is wrong; classify each face by WHICH
    # surface it lies on, following the curve, via its normal about the ring axis:
    #   hub  faces point UP or INWARD  (toward the axis)   -> n.z - n.r_hat > 0
    #   shroud faces point DOWN or OUTWARD                 -> n.z - n.r_hat <= 0
    # where n.r_hat is the outward radial component of the face normal. This holds
    # through the 90 deg bend (flat channel: nz dominates; vertical throat: nr
    # dominates), so the hub follows down to the outlet's inner rim and the shroud
    # down to its outer rim. Done on the RAW asset (normals are unchanged by the
    # uniform place() scale + translate).
    hub_walls, shroud_walls = _split_hub_shroud(np, walls)

    # The hub and shroud are built as their FULL surfaces of revolution (roof + throat
    # + duct, floor + funnel + duct). main() turns each into a watertight solid of
    # revolution (the hub CORE, the shroud CASING) and subtracts them from the fluid, so
    # the non-wetted regions are removed by the boolean at build time; the true wetted
    # boundary is then re-split into named patches. These full surfaces are therefore
    # both the classification sources and the silhouettes the core/casing are revolved
    # from — hence the synthesised roof below (out to the upper-cyl wall) is what caps
    # the core silhouette, not a surface that is emitted verbatim.
    #
    # HUB mesh = the place_throat THROAT + a synthesised flat ROOF. place_throat scales
    # the asset roof by the vertical band factor (it balloons past the wall when sz>1 and
    # shrinks short of it when sz<1), so instead of using that roof we rebuild it as a
    # clean annulus from the throat top out to the upper-cyl wall (d_last/2). The roof
    # then reaches the wall for ANY HLE band, so the hub-core silhouette is full-width.
    _hub_placed = place_throat(hub_walls)
    _hf = _hub_placed.vertices[_hub_placed.faces].mean(axis=1)
    _hfnz = _hub_placed.face_normals[:, 2]
    _roof_face = (np.abs(_hf[:, 2] - z_mid_top) < 0.02 * band) & (np.abs(_hfnz) > 0.7)
    _throat = _hub_placed.submesh([np.where(~_roof_face)[0]], append=True)
    _tv = np.asarray(_throat.vertices, dtype=float)
    _tr = np.hypot(_tv[:, 0] - cx, _tv[:, 1] - cy)
    _throat_top_r = float(_tr[_tv[:, 2] > z_mid_top - 0.02 * band].max())
    _roof = _flat_annulus(np, trimesh, cx, cy, z_mid_top, _throat_top_r, d_last / 2.0)
    hub_mesh = trimesh.util.concatenate([_throat, _roof])

    # The SHROUD now also goes through place_throat (not the plain place()) so its
    # outer rim lands on ro_target too — everything at r > R_anchor (the brim, floor
    # further out) is untouched (identity), so the shroud profile above the vane root
    # is unchanged from before this feature. Derive its FLOOR profile f(r) = top-
    # surface z per radius from the placed mesh; reading it off the ACTUALLY-PLACED
    # shroud makes the blade drape below track HLE, diameter and the new rims
    # automatically.
    shroud_placed = place_throat(shroud_walls)
    _sv = np.asarray(shroud_placed.vertices, dtype=float)
    _sr = np.hypot(_sv[:, 0] - cx, _sv[:, 1] - cy)
    _nb = 240
    _edges = np.linspace(_sr.min(), _sr.max(), _nb + 1)
    _rc = 0.5 * (_edges[:-1] + _edges[1:])
    _idx = np.clip(np.searchsorted(_edges, _sr) - 1, 0, _nb - 1)
    _zf = np.full(_nb, -np.inf)
    np.maximum.at(_zf, _idx, _sv[:, 2])             # per-radius top surface = the floor
    _ok = np.isfinite(_zf)
    _rc_v, _zf_v = _rc[_ok], _zf[_ok]

    def shroud_floor_z(r):
        return np.interp(r, _rc_v, _zf_v)           # clamps to end values outside the range

    # Guide-vane shroud DRAPE. The blade was already placed + pitched above (to
    # measure R_anchor); a rigid pitch shifts the (contoured) bottom edge radially
    # onto a different part of the SLOPED shroud floor, so it would otherwise hang
    # above (or dig into) the shroud — the bottom BAND is re-draped onto
    # shroud_floor_z(r) minus a small overlap, blended to zero shift a band-fraction
    # higher up so the airfoil above stays rigid (no kink). Only Z moves, so the
    # blade cross-section is untouched. The radius-preserving ring rotation below
    # then carries identical copies to their slots (drape is a function of radius,
    # so it survives the ring rotation).
    _bv = np.asarray(base.vertices, dtype=float)
    _br = np.hypot(_bv[:, 0] - cx, _bv[:, 1] - cy)
    _overlap = 0.01 * band                          # small penetration into the shroud: seals the
                                                    # blade->shroud junction (a gap would leak; a
                                                    # coincident plane confuses the mesher) and stays
                                                    # comfortably above typical snappy/cfMesh cell
                                                    # sizes so it is reliably captured. It is hidden
                                                    # behind the shroud wall, so it is invisible in the
                                                    # meshed fluid domain.
    _blend_h = 0.15 * band                          # ramp the drape over the bottom ~15% of the band
    _w = np.clip((z_mid_base + _blend_h - _bv[:, 2]) / _blend_h, 0.0, 1.0)  # 1 at the floor -> 0 above
    _bv[:, 2] = _bv[:, 2] + _w * (shroud_floor_z(_br) - _overlap - _bv[:, 2])
    base.vertices = _bv

    blades = []
    for k in range(int(meta["bladeCount"])):
        b = base.copy()
        ang = np.radians(k * meta["bladeAngleStepDeg"])
        R = np.array([[np.cos(ang), -np.sin(ang), 0, 0],
                      [np.sin(ang), np.cos(ang), 0, 0],
                      [0, 0, 1, 0], [0, 0, 0, 1]])
        b.apply_translation((-cx, -cy, 0))          # rotate about the ring axis (cx, cy)
        b.apply_transform(R)
        b.apply_translation((cx, cy, 0))
        blades.append(b)
    blades_m = trimesh.util.concatenate(blades)

    # Outlet = the passage's whole bottom annular face (hub -> shroud), the real
    # CAD outlet cap. Placed by the SAME remap as the walls, so it lands exactly on
    # the (ratio/X1-scaled) rims and keeps its slight conical form — the full
    # cross-section after the curve, not a synthesised flat ring.
    outlet = place_throat(outlet_asset)

    return {
        # FULL hub/shroud surfaces (roof/floor + throat/funnel), the true refinement
        # surfaces. Hub roof synthesised to meet the wall for any band; shroud now
        # goes through the same pinned-rim remap as the throat/outlet.
        "hub": hub_mesh,
        # THROAT only (funnel + duct, NO flat roof) — the hub-core solid is revolved
        # from this so the throat->roof corner is not cut. Not a CFD patch (not emitted).
        "hub_throat": _throat,
        "shroud": shroud_placed,
        "outlet": outlet,
        "guide_vanes": blades_m,
        # Resolved (possibly clamped) outlet rims — main() uses these downstream
        # instead of recomputing them, so there is exactly one source of truth.
        "outlet_ri": ri_target,
        "outlet_ro": ro_target,
    }
```

- [ ] **Step 4: Update `main()`'s guide-vane rim block**

Find this block (currently lines 1043–1063):
```python
        vane_z_first_top = z_floor + h_first
        vane_s = vane_nat_h = vane_outlet_ri = vane_outlet_ro = vane_z_sb = 0.0
        if guide_vanes:
            _vmeta = _load_vane_meta()
            vane_s, vane_nat_h = vane_scale_and_height(_vmeta, d_last)
            # Outlet scales by the vertical band factor sz ABOUT THE FIXED SHROUD rim
            # (elongate -> wider, clip -> narrower): the shroud outer rim never moves,
            # the hub inner rim slides toward/away from the axis. Straight vertical
            # ducts drop from each rim to the floor (see make_vane_patches.place_throat,
            # which scales the mesh rims to match).
            _vane_sz = h_middle / (_vmeta["height"] - _vmeta["bladeBottomZ"])
            vane_outlet_ro = _vmeta["outletOuterR"] * vane_s              # shroud rim: FIXED
            vane_outlet_ri = vane_outlet_ro + (_vmeta["outletInnerR"] * vane_s - vane_outlet_ro) * _vane_sz
            vane_outlet_ri = max(vane_outlet_ri, 1e-3)                    # hub rim, never past the axis
            vane_z_sb = (z_floor + h_first + h_middle) - vane_nat_h  # natural passage bottom
            # Carve the whole distributor footprint (a full disk of the upper-cyl radius)
            # out of the first cylinder, leaving only the outer ring.
            vane_ring_ri = d_last / 2.0
            _cavity = (cq.Workplane("XY", origin=(target_x, target_y, z_floor))
                       .circle(vane_ring_ri).extrude(h_first))
            part = part.cut(_cavity)
```

Replace it with:
```python
        vane_z_first_top = z_floor + h_first
        vane_outlet_ri = vane_outlet_ro = 0.0
        if guide_vanes:
            # Carve the whole distributor footprint (a full disk of the upper-cyl radius)
            # out of the first cylinder, leaving only the outer ring. (The outlet rims
            # themselves are resolved inside make_vane_patches below — it needs the
            # placed/pitched blade's own footprint (R_anchor) to clamp against, which
            # is not available until that call runs.)
            vane_ring_ri = d_last / 2.0
            _cavity = (cq.Workplane("XY", origin=(target_x, target_y, z_floor))
                       .circle(vane_ring_ri).extrude(h_first))
            part = part.cut(_cavity)
```

- [ ] **Step 5: Update the `make_vane_patches` call site**

Find this block (currently lines 1085–1087):
```python
            vane_patches = make_vane_patches(
                trimesh, np, target_x, target_y, z_mid_base, z_mid_top, d_last,
                vane_angle_deg=vane_pitch)
```

Replace it with:
```python
            vane_patches = make_vane_patches(
                trimesh, np, target_x, target_y, z_mid_base, z_mid_top, d_last,
                vane_angle_deg=vane_pitch,
                outlet_outer_d=num_opt("outletOuterD"), outlet_ratio=num_opt("outletRatio"))
            vane_outlet_ri = vane_patches["outlet_ri"]
            vane_outlet_ro = vane_patches["outlet_ro"]
```

- [ ] **Step 6: Write the verification script**

Create `apps/api/scripts/_verify_outlet_ratio.py`:

```python
"""Verify outlet sizing + hub/shroud profile preservation for a guide-vane build.
Usage: python _verify_outlet_ratio.py <out_dir> [<expected_outer_d_m> <expected_ratio>]
Reuses the debug dump written by buildChamber.py when CHAMBER_DEBUG_DUMP=1 (core.stl,
casing.stl, F.stl, meta.json) plus the emitted exports/trisurface.zip patches.
Exits 0 if all checks pass, 1 otherwise."""
import io, json, os, sys, zipfile
import numpy as np, trimesh

out_dir = sys.argv[1]
expected_outer_d = float(sys.argv[2]) if len(sys.argv) > 2 else None
expected_ratio = float(sys.argv[3]) if len(sys.argv) > 3 else None

DD = os.path.join(out_dir, "_debug")
meta = json.load(open(os.path.join(DD, "meta.json")))
F = trimesh.load(os.path.join(DD, "F.stl"), file_type="stl")
casing = trimesh.load(os.path.join(DD, "casing.stl"), file_type="stl")
cx, cy = meta["target_x"], meta["target_y"]
z_mid_base, z_mid_top, z_box_floor = meta["z_mid_base"], meta["z_mid_top"], meta["z_box_floor"]
ro = meta["vane_outlet_ro"]
ri = meta["vane_outlet_ri"]

ok = True


def check(cond, msg):
    global ok
    print(("OK  : " if cond else "FAIL: ") + msg)
    if not cond:
        ok = False


check(F.is_watertight, "F watertight")
check(len(F.split(only_watertight=False)) == 1, "F single connected component")

if expected_outer_d is not None:
    check(ro <= expected_outer_d / 2.0 + 1e-6,
          "outlet outer radius %.5f <= X1/2=%.5f (equal unless clamped)" % (ro, expected_outer_d / 2.0))
if expected_ratio is not None:
    check(abs(ri / ro - expected_ratio) < 1e-6,
          "inner/outer ratio %.5f matches expected %.5f" % (ri / ro, expected_ratio))

# casing top contour must stay monotone (no up/down wobble) -- proves the shroud
# above the vane root was not disturbed by the new remap.
v = np.asarray(casing.vertices, float)
r = np.hypot(v[:, 0] - cx, v[:, 1] - cy)
z = v[:, 2]
nb = 120
edges = np.linspace(r.min(), r.max(), nb + 1)
rc = 0.5 * (edges[:-1] + edges[1:])
idx = np.clip(np.searchsorted(edges, r) - 1, 0, nb - 1)
ztop = np.full(nb, -np.inf)
np.maximum.at(ztop, idx, z)
good = np.isfinite(ztop)
zc = ztop[good]
dz = np.diff(zc)
sign_changes = int(np.sum(np.diff(np.sign(dz[np.abs(dz) > 1e-6])) != 0))
check(sign_changes == 0, "shroud casing top contour monotone (0 sign changes, got %d)" % sign_changes)

# No stray/misclassified faces at the outlet corner or under the vanes: the two
# regressions this feature could reintroduce, since it changes what feeds the
# EXISTING classification rules (vane_outlet_ri/ro) without changing those rules.
Z = zipfile.ZipFile(os.path.join(out_dir, "exports", "trisurface.zip"))


def load_patch(name):
    m = trimesh.load(io.BytesIO(Z.read(name + ".stl")), file_type="stl")
    return m if hasattr(m, "faces") else None


def wall_faces(mesh, target_r, z_lo, z_hi):
    """Count mesh faces that are a vertical wall (|nz|<0.4) at radius ~target_r,
    within [z_lo, z_hi]. Used below to check ownership at the two duct walls."""
    if mesh is None:
        return 0
    fc = mesh.vertices[mesh.faces].mean(axis=1)
    r = np.hypot(fc[:, 0] - cx, fc[:, 1] - cy)
    nz = np.abs(mesh.face_normals[:, 2])
    sel = (nz < 0.4) & (np.abs(r - target_r) < 0.02) & (fc[:, 2] >= z_lo) & (fc[:, 2] <= z_hi)
    return int(sel.sum())


cw = load_patch("cylinder_walls")
hub = load_patch("hub")

# The sub-brim non-wetted ring regression: cylinder_walls should own NO vertical
# wall at r~ro below the shroud brim (z_mid_base).
ring = wall_faces(cw, ro, -1e9, z_mid_base)
check(ring == 0, "no non-wetted cylinder_walls ring under the vanes (found %d faces)" % ring)

# The hub-hole-above-the-outlet regression: hub should own its FULL inner duct
# wall (r~ri) just above the outlet floor, none stolen by cylinder_walls. Anchored
# at the floor (not z_mid_base): this is exactly where the historical bug band sat
# (a short/wide passage's duct wall can extend well above z_mid_base, but the
# corner theft always happened right at the floor).
band_lo, band_hi = z_box_floor, z_box_floor + 0.15
hub_wall = wall_faces(hub, ri, band_lo, band_hi)
cw_wall = wall_faces(cw, ri, band_lo, band_hi)
check(hub_wall > 0 and cw_wall == 0,
      "hub owns the inner duct wall near the outlet (hub=%d, stolen-by-cylinder_walls=%d)"
      % (hub_wall, cw_wall))

# No stray hub faces above the roof (they would belong to cylinder_walls instead).
if hub is not None:
    fc = hub.vertices[hub.faces].mean(axis=1)
    stray_hi = int((fc[:, 2] > z_mid_top + 0.02).sum())
    check(stray_hi == 0, "no stray hub faces above the roof (found %d faces)" % stray_hi)

print("ALL PASS" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
```

- [ ] **Step 7: Regression-check the OLD (no new params) behaviour still reproduces today's known-good tall-case geometry**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && rm -rf _diag_out && CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py _diag_tall.json _diag_out 2>&1 | tail -5 && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _diag_out"
```
Expected: `OK  : F watertight`, `OK  : F single connected component`, `OK  : shroud casing top contour monotone (0 sign changes, got 0)`, `ALL PASS`. (No expected-value args are passed, since `_diag_tall.json` has no `outletOuterD`/`outletRatio` keys — this exercises the fallback branch.) Also confirm the build log prints no `WARNING:` line.

- [ ] **Step 8: New-params check at default-equivalent values**

Create `apps/api/scripts/_diag_tall_x1.json` by copying `_diag_tall.json` and adding two keys:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python -c \"
import json
d = json.load(open('_diag_tall.json'))
d['outletOuterD'] = 1.45  # X1=1450mm -> metres diameter 1.45, matches CHAMBER_FORM_DEFAULTS.x1
d['outletRatio'] = 0.45
json.dump(d, open('_diag_tall_x1.json', 'w'))
\""
```
Then build and verify:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && rm -rf _diag_out_x1 && CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py _diag_tall_x1.json _diag_out_x1 2>&1 | tail -5 && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _diag_out_x1 1.45 0.45"
```
Expected: all checks `OK`, `ALL PASS`, no `WARNING:` line (X1=1450mm/2=0.725m is well inside the vane's inner radius for the tall case, ~0.79–1.16m observed in this session's earlier diagnostics).

- [ ] **Step 9: Run the existing chamber vitest gate (proves the TS plumbing from Tasks 1–2 is untouched by this Python change)**

Run:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run chamber 2>&1 | tail -10"
```
Expected: `Tests  31 passed (31)`.

- [ ] **Step 10: Purge the build cache and log the change in PLAN.md**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && rm -rf apps/api/storage/chamber/* && echo purged"
```
Append a French changelog entry to the bottom of `PLAN.md` describing this task's change (outlet outer diameter now tracks X1, ratio now user-configurable and no longer HLE-coupled, pinned-rim remap replacing the single-rim linear map, R_anchor measured from the placed/pitched blade, clamp+warning behaviour), matching the style and level of detail of the existing entries in that file.

- [ ] **Step 11: Leave uncommitted**

Same as Task 1, Step 7 — do not commit yet (including this task's `PLAN.md` entry). Move on to Task 4.

---

## Task 4: Verify the feasibility clamp + warning

**Files:**
- No source changes. Uses `apps/api/scripts/_verify_outlet_ratio.py` from Task 3.

**Interfaces:**
- Consumes: `make_vane_patches`'s `outlet_outer_d`/`VANE_OUTLET_SAFE_MARGIN` clamp behaviour from Task 3.

- [ ] **Step 1: Build with a deliberately oversized `outletOuterD`**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && /home/hristo/cadquery-env/bin/python -c \"
import json
d = json.load(open('_diag_tall.json'))
d['outletOuterD'] = 5.0   # far larger than the vane inner radius (~0.79-1.16m for tall)
d['outletRatio'] = 0.45
json.dump(d, open('_diag_tall_oversize.json', 'w'))
\""
```

- [ ] **Step 2: Run the build and capture stdout**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && rm -rf _diag_out_oversize && CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py _diag_tall_oversize.json _diag_out_oversize 2>&1 | tee /tmp/oversize.log | tail -10"
```
Expected: exit `OK:`, and a line matching `WARNING: outlet outer radius 2.5000 clamped to <value> (X1 too large for this vane/d_last combination)` present in `/tmp/oversize.log`.

- [ ] **Step 3: Verify the clamp landed and the build is still watertight**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts && grep -c 'WARNING: outlet outer radius' /tmp/oversize.log && /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py _diag_out_oversize 5.0 0.45"
```
Expected: `1` (the warning appears exactly once), then `OK  : F watertight`, `OK  : F single connected component`, `OK  : outlet outer radius ... <= X1/2=2.50000 (equal unless clamped)` (true because the clamp only ever *reduces* the radius below what was requested), `OK  : inner/outer ratio ... matches expected 0.45` (proves the ratio still holds against the CLAMPED outer radius, not the raw request), `OK  : shroud casing top contour monotone ...`, plus the two stray-face checks, ending in `ALL PASS`.

- [ ] **Step 4: No commit** — this task only exercises Task 3's existing code with new inputs; there is nothing new to commit.

---

## Task 5: Ratio sweep across the template matrix

**Files:**
- No source changes. Uses `apps/api/scripts/_verify_outlet_ratio.py` from Task 3, and the existing template fixtures `_diag_tall.json`, `_dm_short.json`, `_diag_cone.json` (created in earlier sessions; if any are missing, regenerate from `_diag_out_multi.py`'s `mk()` helper in this repo's scratch scripts, or write a fresh one by copying `_diag_tall.json` and adjusting `hMiddle`/`dLast`/`vaneAngleDeg` per that helper's `cases` list).

**Interfaces:**
- Consumes: Task 3's `make_vane_patches(outlet_outer_d=..., outlet_ratio=...)`.

- [ ] **Step 1: Build each template at each ratio in {0.35, 0.45, 0.50}, with a fixed `outletOuterD` of 1.45 m (X1 = 1450 mm)**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "
cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts
for base in _diag_tall _dm_short _diag_cone; do
  for ratio in 0.35 0.45 0.50; do
    tag=\${base}_r\${ratio//./}
    /home/hristo/cadquery-env/bin/python -c \"
import json
d = json.load(open('\$base.json'))
d['outletOuterD'] = 1.45
d['outletRatio'] = \$ratio
json.dump(d, open('\${tag}.json', 'w'))
\"
    rm -rf \${tag}_out
    CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py \${tag}.json \${tag}_out > /tmp/\${tag}.log 2>&1
    echo \"\$tag build exit=\$? \$(tail -1 /tmp/\${tag}.log)\"
  done
done
"
```
Expected: nine lines, each `... build exit=0 OK: ...`.

- [ ] **Step 2: Verify every case**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "
cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts
for base in _diag_tall _dm_short _diag_cone; do
  for ratio in 0.35 0.45 0.50; do
    tag=\${base}_r\${ratio//./}
    echo \"--- \$tag ---\"
    /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py \${tag}_out 1.45 \$ratio
  done
done
"
```
Expected: `ALL PASS` for all nine cases, with every individual check printed `OK`.

- [ ] **Step 3: No commit** — verification-only task; nothing new to commit.

---

## Task 6: Full regression matrix, PLAN.md changelog, cache purge, review checkpoint

**Files:**
- Modify: `PLAN.md` (final changelog entry for this feature)
- No further `buildChamber.py` changes.

**Interfaces:** none (verification + documentation only).

- [ ] **Step 1: Rebuild the full existing template matrix with NO new params (old-cache-compatible path), confirming nothing regressed**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "
cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui/apps/api/scripts
for f in _diag_tall.json _dm_short.json _diag_cone.json; do
  tag=\$(basename \$f .json)
  rm -rf \${tag}_final
  CHAMBER_DEBUG_DUMP=1 /home/hristo/cadquery-env/bin/python buildChamber.py \$f \${tag}_final > /tmp/\${tag}_final.log 2>&1
  echo \"\$tag exit=\$? \$(tail -1 /tmp/\${tag}_final.log)\"
  /home/hristo/cadquery-env/bin/python _verify_outlet_ratio.py \${tag}_final
done
"
```
Expected: three `exit=0 OK: ...` lines and three `ALL PASS` blocks, with no `WARNING:` lines in any of the three logs.

- [ ] **Step 2: Run the full API test suite one more time**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npx --workspace @dive/api vitest run 2>&1 | tail -15"
```
Expected: all test files pass (no failures anywhere in the API suite, not just the `chamber` filter — this is the full run before the review checkpoint).

- [ ] **Step 3: Purge the build cache**

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && rm -rf apps/api/storage/chamber/* && echo purged"
```

- [ ] **Step 4: Append the final PLAN.md changelog entry**

Summarize the whole feature (Tasks 1–5) in one French entry at the bottom of `PLAN.md`, in the same style as the existing chamber-feature entries: what changed (X1-driven outer diameter, configurable ratio, pinned-rim remap, clamp+warning), what was verified (regression matrix, ratio sweep, clamp test, API tests), and note it is **non committed / awaiting app review** per this repo's established workflow.

- [ ] **Step 5: Stop for user review — do not commit**

Tell the user the feature is built, verified (regression matrix + ratio sweep + clamp test + full API suite all green), and the app cache is purged. Ask them to regenerate a guide-vane build in the app (try the default X1/ratio, then try adjusting the new "Outlet ratio" field) and confirm the hub/shroud read as unchanged and the outlet resizes as expected before any commit of this task's `PLAN.md` entry.
