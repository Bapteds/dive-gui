# Chamber Creation — chamfer disable toggle — design

**Date:** 2026-08-11
**Feature:** Chamber Creation
**Scope:** shared type + API schema + web form field + `buildChamber.py` geometry (`make_box`). No change to the empirical model (X1/X2/X3 → 12 parameters), to any other geometry (cylinder stack, torque feet, guide vanes), or to the outputs table.

---

## 1. Goal

Add a toggle that skips the two asymmetric corner cuts on the box's inlet end (`make_box` in `buildChamber.py`), leaving a plain rectangular end, **without changing anything else**: the internal cylinder stack's position, the torque feet, and the values shown in the outputs table (`chamferLength1/2`, `chamferWidth1/2`, `distFromSideChamfer1`, `distFromEnd`) must be identical to today, whether the toggle is on or off.

## 2. Why not just zero the chamfer model values

The four chamfer outputs are not independent — `distFromEnd` ("LT") has a **combination relation `= chamferLength1 + chamferLength2`** (`index.ts:2168-2173`), and `chamferWidth1/2` are each defined as `= chamferLength1`/`= chamferLength2`. Driving "no chamfer" through the model (e.g. an Exact override of 0) would zero `distFromEnd` too, shifting the internal part's axis — exactly the side effect the user wants to avoid. So this must be a **geometry-only flag** that never touches `computeChamberOutputs()` or the resolved output values, matching the existing pattern for `guideVanes`/`footAngleDeg`/`partScale`.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Field name | `chamferEnabled?: boolean`, default `true` (today's always-on behaviour is the default). |
| 2 | What it gates | Only the two `.cut()` calls inside `make_box()`. Nothing else in `buildChamber.py` reads it. |
| 3 | Disabled implementation | **Skip the cuts entirely**, not "cut with a zero-size corner" — a zero-length/zero-width setback produces a degenerate (repeated-point) polyline, which OCC/CadQuery will reject. `make_box` gets an `enabled=True` parameter; when `False` it returns `cq.Workplane("XY").box(width, length, height)` untouched. |
| 4 | Outputs table | Unaffected. `chamferLength1/2`, `chamferWidth1/2`, `distFromSideChamfer1`, `distFromEnd` keep displaying their real computed values regardless of the toggle (confirmed with the user) — the numbers describe the model's chamfer geometry even when the box itself isn't cut. |
| 5 | Positioning | `dist_c1` / `dist_from_end` (used to translate the internal part) are computed exactly as today, independent of `chamferEnabled` — the part axis never moves. |
| 6 | UI placement | A checkbox in `ChamberInputsForm.tsx`, next to the existing "Guide vanes" checkbox (same visual pattern: bordered row, bold label + helper line), checked by default. |

## 4. Parameter flow (mirrors `guideVanes`)

1. **`packages/shared/src/index.ts`** (`ChamberInput`, next to `guideVanes`/`footAngleDeg`) —
   ```ts
   /**
    * Cut the two asymmetric corners at the box's inlet end (the chamfer).
    * Geometry-only (not part of the empirical model) — the chamfer's model
    * values (chamferLength1/2, chamferWidth1/2, distFromSideChamfer1,
    * distFromEnd) are still computed and shown in the outputs table, and the
    * internal part's position is unaffected either way. Default true.
    */
   chamferEnabled?: boolean;
   ```
2. **`apps/api/src/modules/chamber/chamber.schemas.ts`** — `chamferEnabled: z.boolean().default(true)` alongside `guideVanes`.
3. **`apps/api/src/modules/chamber/chamber.service.ts`** (`resolveGeometryParams`) —
   ```ts
   params.chamferEnabled = input.chamferEnabled ?? true;
   ```
   Placed with the other geometry-only flags, before the `CHAMBER_OUTPUT_KEYS` loop (order doesn't matter — it's a flat params dict). Joins the cache-key params JSON, so toggling it invalidates the build cache.
4. **`apps/web/src/features/chamber/chamberForm.ts`** — add `chamferEnabled: boolean` to `ChamberFormValues`, `chamferEnabled: z.boolean()` to the zod schema, `chamferEnabled: true` to `CHAMBER_FORM_DEFAULTS`.
5. **`apps/web/src/features/chamber/ChamberInputsForm.tsx`** — new checkbox row next to "Guide vanes":
   ```tsx
   <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-bg p-3">
     <input
       type="checkbox"
       {...register('chamferEnabled')}
       className="mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/40"
     />
     <span className="text-sm">
       <span className="font-medium text-text">Chamfer</span>
       <span className="mt-0.5 block text-text-secondary">
         Cut the two corners at the inlet end. Turn off for a square-ended box — the rest of the geometry (cylinders, feet, outputs table) is unaffected.
       </span>
     </span>
   </label>
   ```
6. **`apps/api/scripts/buildChamber.py`** — read `chamfer_enabled = bool(P.get("chamferEnabled", True))`; pass it to `make_box(...)`.

## 5. Geometry change in `buildChamber.py`

```python
def make_box(cq, width, length, height, end, big_side, ch_big, ch_small, enabled=True):
    """Box with two asymmetric chamfers on the two vertical corners of ONE end
    (when enabled). ch = (length_setback, width_setback): cut along Y (length)
    and X (width). When enabled=False the box is returned untouched — the
    chamfer's own model values (ch_big/ch_small) are ignored entirely, never
    coerced to a zero-size cut (which would be a degenerate wire)."""
    b = cq.Workplane("XY").box(width, length, height)
    if not enabled:
        return b
    end_sy = 1.0 if end.startswith(">") else -1.0
    big_sx = 1.0 if big_side.startswith(">") else -1.0
    b = b.cut(_corner_prism(cq, width, length, height, big_sx, end_sy,
                            ch_big[0], ch_big[1]))
    b = b.cut(_corner_prism(cq, width, length, height, -big_sx, end_sy,
                            ch_small[0], ch_small[1]))
    return b
```

Call site (`main`, unchanged besides the new argument):
```python
box = make_box(cq, width, length, height,
               CHAMFER_END, BIG_CORNER_SIDE, ch_big, ch_small,
               enabled=chamfer_enabled)
```

Everything downstream — `target_x`/`target_y` (part translate), `make_feet`, `classify`'s wall/patch grouping — reads `width`/`length`/`height`/`dist_c1`/`dist_from_end`/box faces generically and needs no change; a box without corner cuts still classifies into the same four patches (`inlet`/`outlet`/`cylinder_walls`/`walls`), just with two fewer plane facets in `walls`.

## 6. Backward compatibility

Cached/old params JSON files without `chamferEnabled` default to `True` in both the API service (`?? true`) and the Python reader (`P.get("chamferEnabled", True)`) — old builds reproduce byte-identical geometry.

## 7. Verification plan

- `apps/api/tests/chamber.test.ts`: extend with a case building `chamferEnabled: false` and asserting it succeeds and produces a **different hash** than the default build (mirrors the existing `footAngleDeg` 0°-vs-90° hash-difference test) — proves the flag reaches the builder and actually changes the cache key.
- `chamberModel.test.ts`: no changes expected — `chamferEnabled` never touches `computeChamberOutputs()`.
- Manual/cadquery-env check (per the project's existing verification convention for Python geometry changes): build once with the toggle on and once off at the same X1/X2/X3 — confirm (a) the off build is a valid watertight solid with square inlet-end corners, (b) the outputs table values and internal part position are identical between the two, (c) both still produce `inlet`/`outlet`/`cylinder_walls`/`walls` patches.

## 8. Out of scope

- Any change to the torque feet's own fixed 45° chamfer (`FOOT_CHAMFER`) — not a user-facing parameter, not what this toggle addresses.
- Any change to `computeChamberOutputs()` or the outputs table's rendering.
- Per-corner toggles (big chamfer vs. small chamfer independently) — not requested; the two corners toggle together.
