# Guide-vane outlet — X1-driven diameter + configurable inner/outer ratio — design

**Date:** 2026-08-06
**Feature:** Chamber Creation — guide-vane distributor, outlet sizing
**Scope:** shared type + API schema + web form field + `buildChamber.py` geometry. No change to the empirical model (X1/X2/X3 → 12 parameters) beyond reading X1 in the API service layer; no change to the non-guide-vane build path.

---

## 1. Goal

Today the guide-vane outlet's outer radius is a fixed fraction of `d_last` (baked into the vane asset's `outletOuterR`, scaled by `s = 0.80·d_last / (2·pivotRadius)`), and its inner radius drifts with the HLE vertical scale factor `sz` — so the inner/outer ratio is not constant and is not user-controlled (observed range ≈0.15–0.65 across existing test cases).

Two changes:

1. **Outlet outer diameter = X1** (the first empirical model input, mm, range 700–2420, default 1450), instead of the asset-derived fraction of `d_last`.
2. **Outlet inner diameter = ratio · outer diameter**, where `ratio` is a new user-facing parameter, default **0.45**, adjustable in **0.35–0.50**, and no longer coupled to the HLE band.

The hub and shroud profiles (roof, throat curvature, floor fillet, brim) must stay correct — i.e., visually and dimensionally unchanged from today's boolean-distributor geometry — for the default case, and must deform smoothly and monotonically (no faceting, no folding, no new holes) as X1 or the ratio move away from their defaults.

## 2. Current mechanism (as verified in code)

- `apps/api/scripts/assets/guideVanes.json`: `outletOuterR = 0.6550047512379339`, `outletInnerR = 0.2957333029119147`, `pivotRadius = 0.86732` (all metres). Natural ratio ≈ **0.4515** — already close to the new default of 0.45.
- `buildChamber.py` (`vane_scale_and_height`): `s = (RATIO_D_MIDDLE_OVER_LAST · d_last) / (2 · pivotRadius)` — the single radial scale pinning the blade pivot circle to `0.80·d_last`.
- `buildChamber.py` (main, guide-vane branch):
  ```python
  vane_outlet_ro = _vmeta["outletOuterR"] * vane_s              # shroud rim: FIXED
  vane_outlet_ri = vane_outlet_ro + (_vmeta["outletInnerR"] * vane_s - vane_outlet_ro) * _vane_sz
  ```
  `vane_outlet_ro` scales only with `d_last` (via `s`). `vane_outlet_ri` is pulled *toward* `ro` as `sz` (HLE-driven) shrinks below 1, and pushed *away* as `sz` grows above 1 — this is the source of the ratio drift.
- `make_vane_patches` → `place_throat(mesh)`: remaps every vertex's radius as `r_new = max(r_shroud + (r·s − r_shroud)·sz, 1e-3)`, i.e. a single linear map anchored at the (fixed) shroud rim `r_shroud`, applied uniformly from the axis to the shroud. This is what warps the **hub throat**, **outlet asset**, and (implicitly, via the duct radii it produces) the **ducts** to reach the target rims. It is monotonic in `r`, which is why today's throat never folds.
- The **shroud** mesh itself is *not* warped by `place_throat` — it uses the plain uniform `place()` (scale `s`, `sz`) and is treated as the fixed reference; its outer rim is `r_shroud` by construction (`meta["outletOuterR"] * s`).
- Downstream, `vane_outlet_ri`/`ro` drive: the mesh ducts (`_open_cylinder`), the outlet annulus (`_flat_annulus`), the hub-core/shroud-casing solids (built from the hub/shroud meshes, which already have the ducts appended), and three deterministic classification rules (outlet floor annulus, hub roof, outlet-duct walls by radius).

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Ratio exposure | New user-facing field, **guide-vanes only**, default **0.45**, range **0.35–0.50** — plumbed like `vaneAngleDeg` (shared type → API schema → form → service → Python), not part of `CHAMBER_INPUT_RANGES`. |
| 2 | Outer diameter source | `vane_outlet_ro = X1(mm)/2 · MM_TO_M` — X1 is read in the **API service layer** (it already has `input.x1`) and written into the geometry params JSON as a new `outletOuterD` key (metres), alongside the existing `outletRatio` key. Python never sees X1 directly, matching the existing boundary ("the empirical model lives in the Node/TS layer"). |
| 3 | Feasibility guard | **Clamp + warn.** If the requested outer radius would put the outlet rim at or past the vane inner working radius, clamp it to a safe margin inside that radius and print a `WARNING:` line in the Python build log (visible in the API build output). The build still succeeds. |
| 4 | Hub/shroud profile preservation | Replace the `sz`-anchored `place_throat` remap with a **monotonic piecewise-linear radial remap pinned at both outlet rims and fading to identity at the vane inner radius** (§5). This confines the reshaping to the outlet throat/fillet region; the vane band, hub roof, and shroud brim are geometrically untouched. |

## 4. Parameter flow (mirrors `vaneAngleDeg`)

1. **`packages/shared/src/index.ts`** — add `outletRatio?: number` to `ChamberInput`, next to `vaneAngleDeg`. No new entry in `CHAMBER_INPUT_RANGES` (that table is specifically the X1/X2/X3 empirical-model ranges); the 0.35–0.50 bound lives with the schema/form, like `vaneAngleDeg`'s ±5° bound does today.
2. **`apps/api/src/modules/chamber/chamber.schemas.ts`** — add `outletRatio: z.number().finite().min(0.35).max(0.50).default(0.45)` alongside `vaneAngleDeg`.
3. **`apps/api/src/modules/chamber/chamber.service.ts`** (`resolveGeometryParams`) — add, guarded by `guideVanes` (mirroring how `vaneAngleDeg` is only meaningful there):
   ```ts
   params.outletRatio = input.outletRatio ?? 0.45;
   params.outletOuterD = input.x1 * MM_TO_M;   // X1 is mm; params are metres
   ```
   Both keys join the existing cache-key params JSON, so a ratio or X1 change correctly invalidates the build cache.
4. **`apps/web/src/features/chamber/chamberForm.ts`** — add `outletRatio` to `ChamberFormValues`, to the zod schema (`z.number().min(0.35).max(0.50)`), and to `CHAMBER_FORM_DEFAULTS` (`0.45`).
5. **`apps/web/src/features/chamber/ChamberInputsForm.tsx`** — add a `<Field>` next to the vane-angle field, gated on `guideVanes` (same visibility pattern), label "Outlet inner/outer ratio", helper text showing the 0.35–0.50 range.
6. **`apps/api/scripts/buildChamber.py`** — read `outlet_ratio = num_or("outletRatio", 0.45)` and `outlet_outer_d = num_or("outletOuterD", None)` using the existing `num()`/`P.get()` pattern; fall back to today's asset-derived values when either key is absent (keeps old cached params / manual test JSON files working without modification).

## 5. Geometry changes in `buildChamber.py`

### 5.1 Target rims

```python
_vmeta = _load_vane_meta()
vane_s, vane_nat_h = vane_scale_and_height(_vmeta, d_last)
ro_natural = _vmeta["outletOuterR"] * vane_s                                        # == today's r_shroud
ri_natural_sz = ro_natural + (_vmeta["outletInnerR"] * vane_s - ro_natural) * _vane_sz  # today's formula (fallback only)

# NEW: target rims from X1 + ratio, with a feasibility clamp. outlet_outer_d / outlet_ratio
# are None when absent from the params JSON (old cached builds) -> exact old behaviour.
R_anchor = <vane inner working radius, computed below>       # §5.3
ro_target = (outlet_outer_d / 2.0) if outlet_outer_d is not None else ro_natural
if ro_target >= SAFE_MARGIN * R_anchor:
    print("WARNING: outlet outer radius %.4f clamped to %.4f (X1 too large for this vane/d_last combination)"
          % (ro_target, SAFE_MARGIN * R_anchor))
    ro_target = SAFE_MARGIN * R_anchor
ri_target = (outlet_ratio * ro_target) if outlet_ratio is not None else ri_natural_sz
vane_outlet_ro, vane_outlet_ri = ro_target, max(ri_target, 1e-3)
```
`SAFE_MARGIN` ≈ 0.97 (a constant, not user-facing) — keeps the outlet rim just inside the vane inner radius so the blade always has shroud/hub material to seat on. Note the fallback (`outlet_outer_d`/`outlet_ratio` both `None`) reproduces `vane_outlet_ro`/`vane_outlet_ri` byte-identical to today's code, satisfying §6.

### 5.2 Replacing `place_throat`'s radial remap

Today: `r_new = r_shroud + (r·s − r_shroud)·sz` — single linear map anchored at the *natural* shroud rim, extrapolated with slope `sz` all the way to the axis. This is what has to change, because the shroud rim itself now also needs to move (from `ro_natural` to `ro_target`) and the inner rim target is independent of `sz`.

New map operates entirely in **physical (post-`s`-scale) radius**, so asset-space and physical-space are never mixed. First apply the existing radial scale `r_phys = r_asset · s` (same as `place()`/today's `place_throat` already do), then remap `r_phys → r_new` as a **monotonic piecewise-linear function**, built from four knots:
- `(0, 0)` — axis stays the axis.
- `(ri_natural, vane_outlet_ri)` — hub/outlet inner rim moves to its target, where `ri_natural = outletInnerR · s` (today's asset-derived inner radius, in physical units, *before* any `sz` adjustment).
- `(ro_natural, vane_outlet_ro)` — shroud/outlet outer rim moves to its target, where `ro_natural = outletOuterR · s` (today's `r_shroud`).
- `(R_anchor, R_anchor)` — identity from the vane inner working radius outward: the vane band, hub roof, and shroud brim/wall are **not** touched by this remap at all. `R_anchor` is itself a physical radius (§5.3), so this knot is consistent with the others.

`np.interp(r_phys, [0, ri_natural, ro_natural, R_anchor], [0, vane_outlet_ri, vane_outlet_ro, R_anchor])` gives a continuous, monotonic (knots strictly increasing in both `r_phys` and `r_new` whenever `0 < ri_target < ro_target < R_anchor`, which the clamp guarantees together with `ri_natural < ro_natural < R_anchor` holding by construction of the asset) piecewise-linear remap — the direct generalization of today's single linear segment, now with two pinned rims instead of one. The `z` coordinate keeps its existing `sz` scale + offset unchanged; only the radial component changes. Applied to: the hub throat (`_throat`, before the flat-roof synthesis, which already stops at `_throat_top_r ≤ R_anchor` today), and the `outlet_asset`. The **shroud** mesh switches from `place()`'s plain uniform scale to this same physical-radius remap so its rim also lands on `ro_target` (today it implicitly relies on `r_shroud` never moving).

### 5.3 `R_anchor`

`R_anchor` = the vane inner working radius, read the same way the existing code already derives `_throat_top_r` / vane span — the minimum blade-footprint radius at the vane band (`vane_patches["guide_vanes"]` r-range, already computed in `make_vane_patches`). This is a **measured** value per build, not a constant, so the anchor always sits just past the real blade root regardless of vane geometry or pitch.

### 5.4 Downstream (unchanged mechanics, new radii)

`_hub_ext`/`_shr_ext` ducts, `_flat_annulus` outlet, `_hub_core_solid`/`_shroud_casing_solid`, and the three deterministic classification rules (outlet floor, hub roof, outlet-duct walls) all already parametrize on `vane_outlet_ri`/`vane_outlet_ro` — no changes needed there beyond passing the new values through.

## 6. Backward compatibility

- Cached/old params JSON files without `outletRatio`/`outletOuterD` fall back to today's exact formulas (§5.1's fallback branch) — old builds reproduce byte-identical geometry.
- Non-guide-vane path: untouched (this feature only exists inside the `guide_vanes` branch).
- At the defaults (X1=1450mm → ro=0.725m, ratio=0.45), the new rims are close to today's natural values (ro_natural≈0.655·s, ratio≈0.4515) but not identical — a small, deliberate correction (the ratio stops drifting with HLE, and the outer radius now tracks X1 instead of d_last). This is an accepted geometry change, not a regression to guard against.

## 7. Verification plan

Across the short/tall/cone template matrix, and additionally at ratio ∈ {0.35, 0.45, 0.50} and a deliberately-oversized X1 (to exercise the clamp):
- F watertight, single connected component (as today's `_diag_out_verify.py`/`_diag_cyl3.py` checks).
- `outlet` patch outer radius == `ro_target` (or the clamped value, with the WARNING line present in stdout); inner radius == `ratio · ro_target`.
- Hub/shroud fillets remain monotone (0 sign-changes, per the existing `_diag_out_spl.py`/`_diag_out_verify.py` method) and smooth (no facet regression, per `_diag_out_step.py`'s method).
- No stray/misclassified faces at the outlet corner or under the vanes (per `_diag_out_stray.py`/`_diag_cyl3.py`).
- 29 existing `chamber` vitest tests pass unmodified (they mock the Python builder, so they exercise the plumbing, not the geometry).
- Manual build + app review of the rendered GLB at default settings, confirming the hub/shroud read as unchanged from the current committed geometry.

## 8. Out of scope

- Changing the X1/X2/X3 → 12-parameter empirical model itself.
- Any change to the non-guide-vane build path.
- Adding `outletRatio`/X1-derived sizing to `CHAMBER_INPUT_RANGES` (that table is reserved for the three empirical-model inputs).
