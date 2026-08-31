# Stepped chamber — last cylinder extends through the box top — design

**Date:** 2026-08-11
**Feature:** Chamber Creation — stepped ("closed generator") variant geometry
**Scope:** `apps/api/scripts/buildChamber.py` only (the geometry builder). No change to the shared empirical model, the API, the web app, the patch set, or the hollow / guide-vane build paths.

---

## 1. Goal

In the **stepped** variant the last (top) cylinder is a cavity that currently stops `FLOOR_OVERCUT` (10 mm) short of the box top, leaving a thin solid lid. Worse, because the whole cylinder stack is anchored to the box floor and scaled uniformly by `partScale`, at `partScale < 1` the last cylinder's top drops far below the box top and the lid grows to most of the box height.

Make the last cylinder **always reach and open through the box top**, at any `partScale`, so `box.cut(part)` removes the lid entirely (mirroring how the floor overcut already opens the bottom). The last cylinder's diameter keeps scaling with `partScale`; only its **top** is decoupled from the scale and pinned to the box top. The result stays a single watertight solid and the patch set is unchanged (`inlet` / `outlet` / `cylinder_walls` / `walls`), with the last-cylinder wall remaining in `cylinder_walls`.

## 2. Current mechanism (verified in code)

- The box spans `z ∈ [−H/2, +H/2]` (`make_box`, height `H`). The cylinder stack is a solid `part` subtracted from the box: `result = box.cut(part).cut(feet)`.
- `make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last, omit_middle=False)` (`buildChamber.py:142`) stacks three cylinders along +Z with the first cylinder's base at local `z = 0`: first `[0, h_first]`, middle `[h_first, h_first+h_middle]`, last `[h_first+h_middle, h_first+h_middle+h_last]`. The last cylinder has a flat top **cap** face.
- Uniform scale (`buildChamber.py:1148-1152, 1170-1175`): `d_last, h_middle, h_first *= part_scale`; `d_first = d_last * RATIO_D_FIRST_OVER_LAST`, `d_middle = d_last * RATIO_D_MIDDLE_OVER_LAST`; for stepped, `h_last *= part_scale`; `part_height = h_first + h_middle + h_last`.
- Up-scale clamp (`buildChamber.py:1137-1143`): if `part_scale * unscaled_part_height > H`, clamp `part_scale = H / unscaled_part_height`. For stepped, `unscaled_part_height = h_first + h_middle + h_last` (`:1131`).
- Translate (`buildChamber.py:1192`): `part.translate((target_x, target_y, z_floor))` with `z_floor = −H/2 − FLOOR_OVERCUT`. Hence at `partScale = 1`, where the model identity gives `H = (h_first+h_middle) + h_last`, the last cylinder top lands at `z_floor + part_height = +H/2 − FLOOR_OVERCUT` → a 10 mm lid.
- Exceed-box guard (`buildChamber.py:1180-1182`): raises if `part_height > H + 1e-6`.
- Feet (`buildChamber.py:1205-1206`): `z_last_base = z_floor + h_first + h_middle` (scaled) — the leg top sits at the last cylinder's base.
- `classify(...)` (`buildChamber.py:917`): finds the inlet (min-Y plane) and the cylindrical faces; sorts cylinders by z-centre and names the **median** one `outlet`; every pocket face (within `pocket_radius` of the axis) except the outlet is `cylinder_walls`; box faces (extent beyond `pocket_radius`) are `walls`.

## 3. Decisions (locked with the user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Variants affected | **stepped only**. Hollow and guide-vane paths untouched. |
| 2 | Top treatment | **Open through the top**: extend the last cylinder to `+H/2 + FLOOR_OVERCUT` so `box.cut(part)` opens a clean circular hole in the box top (no cap, no lid), exactly like the floor overcut at the bottom. |
| 3 | Patch | The last-cylinder wall **stays in `cylinder_walls`**; no new patch, no classifier change. `inlet/outlet/cylinder_walls/walls` is preserved. |
| 4 | Scale coupling | First + middle cylinders scale with `partScale` as today (diameter and height). The last cylinder's **diameter keeps scaling** with `d_last`; only its **top is pinned** to the box top, independent of `partScale`. Its base stays at the scaled shoulder. |

## 4. Geometry change in `buildChamber.py` (stepped branch only)

### 4.1 Build the last cylinder to a pinned top, not a scaled height

The last cylinder must run from the scaled shoulder `z_shoulder = z_floor + (h_first + h_middle)` (both already scaled) up to `z_top_target = +H/2 + FLOOR_OVERCUT`. In the part's LOCAL frame (first-cylinder base at local `z = 0`, later translated by `z_floor`), the last cylinder base is at local `h_first + h_middle` and its top must reach local `z_top_target − z_floor = H + 2·FLOOR_OVERCUT`. So the last cylinder's local height is:

```
last_h_local = (H + 2*FLOOR_OVERCUT) - (h_first + h_middle)
```

Two clean ways to implement; pick the one that keeps `make_part` reusable:

**Chosen: pass an explicit last-cylinder height into `make_part` for the stepped branch.** Add an optional `h_last_override` param to `make_part`; when provided it is used verbatim as the last cylinder's extrude length instead of `h_last`. This keeps `make_part` a pure builder and leaves the guide-vane/omit_middle logic intact.

```python
def make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
              omit_middle=False, h_last_override=None):
    """... last cylinder height is h_last, or h_last_override when given (used by
    the stepped build to pin the last cylinder's TOP to the box top regardless of
    partScale)."""
    part = cq.Workplane("XY").circle(d_first / 2).extrude(h_first)
    last_h = h_last if h_last_override is None else h_last_override
    if omit_middle:
        last = (cq.Workplane("XY", origin=(0, 0, h_first + h_middle))
                .circle(d_last / 2).extrude(last_h))
        return part.union(last)
    part = part.faces(">Z").workplane().circle(d_middle / 2).extrude(h_middle)
    part = part.faces(">Z").workplane().circle(d_last / 2).extrude(last_h)
    return part
```

At the stepped call site (`buildChamber.py:1170-1175`), after `h_last *= part_scale` (kept so `h_last` still exists for reference/logging), compute the override and the true part height:

```python
        else:
            h_last *= part_scale  # scaled model value (kept for reference)
            # Pin the last cylinder's TOP to a hair above the box top so the
            # boolean opens it through the top at ANY partScale (mirrors the
            # floor overcut at the bottom). Its base stays at the scaled shoulder;
            # only the top is decoupled from the scale. Diameter still scales via
            # d_last above.
            last_h_local = (height + 2 * FLOOR_OVERCUT) - (h_first + h_middle)
            part = make_part(cq, d_first, h_first, d_middle, h_middle, d_last, h_last,
                             omit_middle=guide_vanes, h_last_override=last_h_local)
            part_height = h_first + h_middle + last_h_local  # == height + 2*FLOOR_OVERCUT
            rmax = max(d_first, d_middle, d_last) / 2
```

Because the part is later translated by `z_floor = −H/2 − FLOOR_OVERCUT`, the last cylinder's global top is `z_floor + (h_first + h_middle + last_h_local) = +H/2 + FLOOR_OVERCUT` — through the top, at every scale. (Guide-vane stepped builds keep the same pin: `omit_middle` still unions the last cylinder at its usual base, now with the pinned top.)

### 4.2 Up-scale clamp — keep the shoulder under the top

The last cylinder now auto-fills to the top, so the stack no longer "grows past the box" by scaling; the real constraint is that the **scaled shoulder must stay below the box top** with enough room to leave the last cylinder a positive (minimum) height. Replace the stepped clamp basis.

Introduce a small floor for the last cylinder height, e.g. `MIN_LAST_CYL_H = 0.05` (50 mm; a builder constant, not user-facing). The shoulder must satisfy `(h_first + h_middle) * part_scale ≤ (H + 2*FLOOR_OVERCUT) − MIN_LAST_CYL_H`. Compute the clamp against the shoulder growth rather than the whole stack:

```python
        else:
            h_last = num("hLast")
            if h_last <= 0:
                raise ValueError("hLast must be > 0")
            # The last cylinder is pinned to the box top; only the shoulder
            # (first+middle) grows with partScale. Clamp so the shoulder never
            # reaches the top (the last cylinder keeps at least MIN_LAST_CYL_H).
            unscaled_shoulder = h_first + h_middle   # UNSCALED (pre-partScale)
```

and change the clamp block (`:1137-1143`) so, for the stepped variant, it clamps on the shoulder:

```python
        # Clamp partScale so the SCALED shoulder stays below the box top with room
        # for the last cylinder (stepped) / the whole stack fits (hollow). Scaling
        # DOWN is always allowed.
        if variant == "hollow":
            clamp_basis = unscaled_part_height          # whole stack (unchanged)
            clamp_limit = height
        else:
            clamp_basis = unscaled_shoulder             # first+middle only
            clamp_limit = height + 2 * FLOOR_OVERCUT - MIN_LAST_CYL_H
        if clamp_basis > 0 and part_scale * clamp_basis > clamp_limit + 1e-6:
            clamped = clamp_limit / clamp_basis
            sys.stderr.write(
                "WARN: partScale %.4f would leave no room for the last cylinder; "
                "clamped to %.4f\n" % (part_scale, clamped))
            part_scale = clamped
```

(The hollow branch keeps its existing `unscaled_part_height` basis and `height` limit — unchanged behaviour. `unscaled_part_height` is still computed in the hollow branch as today; the stepped branch computes `unscaled_shoulder` instead and no longer needs `unscaled_part_height`.)

### 4.3 Exceed-box guard

The stepped part now intentionally extends to `H/2 + FLOOR_OVERCUT`, so the `part_height > H` guard (`:1180-1182`) would always trip. Scope it to the hollow variant (where it still means something), and rely on §4.2's clamp + a positive-height assertion for stepped:

```python
        if variant == "hollow":
            if part_height > height + 1e-6:
                raise ValueError(
                    "part height %.4f exceeds box height %.4f" % (part_height, height))
        else:
            # Stepped: the last cylinder is pinned through the top by construction;
            # the clamp above guarantees the shoulder leaves room. Guard the floor.
            if last_h_local <= 0:
                raise ValueError(
                    "last cylinder height %.4f <= 0 (shoulder above the box top)"
                    % last_h_local)
```

### 4.4 Feet, classifier, warnings — unchanged

- `z_last_base = z_floor + h_first + h_middle` (scaled) is still the last cylinder's base → feet legs still land on the shoulder. No change.
- `classify(...)` still sees three cylinders (first < middle < last by z-centre) → `outlet` = middle, last-cylinder wall → `cylinder_walls`. The last cylinder's old flat cap face is gone (open top); the box top face becomes a ring with a circular hole and still classifies as `walls` (its horizontal extent reaches the box corners). No classifier change.
- The `abs(target_x) + rmax > width/2` side-wall warning is unchanged (`rmax` still uses `d_first/2`, the widest cylinder).

## 5. Backward compatibility & invariants

- **`partScale = 1`**: identical to today except the ~10 mm top lid is removed — the last cylinder pokes through instead of stopping short. Everything else (diameters, shoulder, middle-cylinder outlet, feet) is byte-for-byte the same.
- Shared model, API params, web form, cache-key params JSON: **untouched**. `hLast` / P12 still computes and displays in the outputs table; it simply no longer literally sets the stepped last cylinder's top (at scale 1 the result equals it anyway). No new params, so cached builds and the hash are unaffected in shape.
- Hollow and guide-vane (non-stepped) paths: **untouched** (the pin lives entirely in the stepped `else` branch and the variant-gated clamp/guard).

## 6. Verification plan (cadquery-env, per the project convention for Python geometry)

Rebuild the stepped variant at `partScale ∈ {1.0, 0.5, 0.25}` (and one up-scale, e.g. 1.5, to exercise the clamp), and confirm for each:

1. Exit 0, **single watertight solid** (STEP), matching the existing `_diag`-style checks.
2. The last cylinder **opens through the box top** — the box top face is a ring with a circular hole (radius `d_last/2` about the part axis), no flat cap face, at every scale (no lid).
3. Patches are exactly `inlet / outlet / cylinder_walls / walls`; the last-cylinder wall is in `cylinder_walls`; `walls` still contains the (holed) box top; `outlet` is still the middle cylinder.
4. `partScale = 1` matches the current committed geometry except for the removed top lid (compare volume: new ≈ old − lid slab; the difference equals the ~10 mm slab minus the last-cyl bore through it).
5. Up-scale past the limit prints the WARN and clamps; the last cylinder keeps ≥ `MIN_LAST_CYL_H`.
6. The existing `apps/api/tests/chamber.test.ts` cases (14) still pass (they mock the Python builder, so they're unaffected; run them to confirm no plumbing regressed).
7. App review of the rendered GLB at default and at `partScale = 0.5`, confirming the top opening and no lid.

## 7. Out of scope

- Hollow / guide-vane variants.
- Any change to the empirical model, `hLast`/P12 semantics in the outputs table, the API, or the web app.
- A dedicated top-opening patch or a flat top cap (explicitly declined — the wall stays in `cylinder_walls` and the top is an open hole).
- Changing the last cylinder's diameter behaviour (it keeps scaling with `partScale`).
