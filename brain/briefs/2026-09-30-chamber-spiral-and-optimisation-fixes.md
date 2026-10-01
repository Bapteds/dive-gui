# Agent brief: semi-spiral, Length and optimisation fixes

> **Date**: 2026-09-30 · **Requested by**: the user (DIVE Turbinen), from a review session of the brain.
> **Repository**: `github.com/Bapteds/dive-gui` · **Areas**: shared, API, Python (`designSemiSpiral.py`, `buildChamber.py`), web, tests, brain.

## 0. How to work

- Follow `brain/conventions/workflow.md`. Start with `brain/STATUS.md` and the top of `brain/changelog/2026-09.md`.
- **One spec per item** in `brain/specs/YYYY-MM-DD-<topic>-design.md`, approved by the user before any code. Then write the test first, implement, verify, and document. Use one branch per item (`feat/<topic>` or `fix/<topic>`), never commit on `main`.
- The user decisions below are **settled**. Do not re-ask them. The points marked **OPEN** must be asked before the spec is approved, one question at a time.
- Do only what is written here. Other open threads in `STATUS.md` and `known-issues.md` are not part of this work.
- Chamber area reading path: `brain/features/chamber-creation.md` (§3.7 semi-spiral), `brain/conventions/vocabulary.md`, `apps/api/scripts/AGENTS.md`, `brain/codemap/api-scripts.md`, and the specs `2026-09-29-semi-spiral-casing-design.md` and `2026-09-30-spiral-length-design.md`.
- Optimisation reading path: `brain/features/optimisation.md` and `brain/specs/2026-09-29-optimisation-loop-design.md`.
- Every change to `buildChamber.py` requires a purge of `$STORAGE_DIR/chamber/*` at deploy. Say so in the changelog.
- Anything that needs OpenFOAM or a real mesh must be flagged "to validate on the server".

Suggested order:
1. Item 2, then item 1 (they share the Length control).
2. Item 3 (follows from 1 and 2).
3. Item 6.
4. Item 5 (easier to build once the angle is selectable).
5. Item 7.
6. Item 8 (independent, can be done at any time).

Item 4 is a no-change note.

---

## 1. The spiral must not dictate the Length

**Today:** with Semi-spiral casing on, `designSemiSpiral.py` chooses the chamber length freely. The plain `lengthOverride` is hidden and ignored, and the Parameters table row shows the spiral's own length (status `from spiral`). Since 2026-09-30, an optional `spiralLength` Min / Max / Exact can limit or extend it.

**Wanted (user decision):** the spiral is designed **inside** the chamber length. The Length stays the user's value and defaults to **2 × B Kammer**, exactly as without the spiral.

**Approach:**
- Treat the resolved Length as always set with the spiral on. It acts as an Exact: pass it as `max_length` to the designer, then extend the straight inlet channel up to it. Both mechanisms already exist in `2026-09-30-spiral-length-design.md`: `max_length`, `_fit_length`, and moving V0 / V9 in `extendSpiralInlet`.
- **Too short ⇒ refuse (user decision).** If the Length is shorter than the shortest valid spiral, refuse the build (422 `CHAMBER_REFUSED`). Reuse the existing refusal text. When the Length was the default and not typed, word it so the user knows it came from 2 × B Kammer. The user expects this never to happen in practice, so add a test that triggers it on purpose.
- The Length Min / Max / Exact of item 2 still apply on top of the default.

**Consequences to handle and document:**
- `max_length` is now always in the spiral inputs, so **every spiral build re-keys**. The brain notes that any set limit changes the optimiser's search trajectory even when it does not bind, so vertices can differ from today's. The Python golden cases A / B / C are called without `max_length` and must stay unchanged.
- **Optimisation:** a study that varies B Kammer on a spiral base design will now also move the default Length (2 × B Kammer), unless the base design has an explicit Length. Keep that behaviour, test it, and write it in `features/optimisation.md`.
- Old saves load and build. Their spiral output may change, and that change is intended.

## 2. Length gets Min / Max / Exact without the spiral too

**Today:** without the spiral, Length is only a form field (`lengthOverride`, blank = 2 × B Kammer) with no Min / Max / Exact. With the spiral, the Min / Max / Exact live in a separate field (`spiralLength`), because Length is not a `ChamberOutputKey`.

**Wanted (user decision):** Length has Min / Max / Exact in **both** modes, with the default 2 × B Kammer.

**Approach (to confirm in the spec):**
- Make Length a single Parameters-table row in both modes, using the same `NumCell`, statuses and inverted-range 422 as the other rows.
- Collapse `lengthOverride` and `spiralLength` into one control.
- Old saves must still load: a saved `lengthOverride` loads as a Length Exact, and a saved `spiralLength` loads as it is.
- Length is not an empirical output. The spec must choose between adding a Length row to the model (with no fit, defaulting to 2 × B Kammer Final) and keeping a dedicated field shown as a table row.
- **OPEN:** should the Length row become pickable in optimisation studies? Ask the user. Do not add it by default.

## 3. Casing flow velocity field placement

**Today:** the read-only Casing flow velocity (derived from B Kammer since 2026-09-30) sits in the form slot that Length vacated. This placement was an implementation choice, not a user decision.

**Wanted:** once Length is a single table row (item 2), give the read-only velocity a sensible home. **Proposal:** show it next to B Kammer, since it follows B Kammer, or in the Semi-spiral casing card, keeping its helper text and refusal message. Confirm the exact spot with the user in the spec. Follow the UI skill sequence (`brain/conventions/frontend.md`).

## 4. Casing flow velocity range: no change

The 0.3 to 3 m/s window now effectively limits B Kammer (the 422 names the B Kammer range that fits). The brain records no rationale for it. **User decision: leave it as it is.** Do not remove it or turn it into a warning. Only item 6 adjusts its wording, because the formula depends on the start angle.

## 5. Debug sketch of the spiral

**Wanted:** a top-down 2D sketch of the semi-spiral and of the straight lines that approximate it, available now for debugging.

**Content:**
- the ideal area-law wall R_cl(φ);
- the 6 spiral segments and the 3-line nose, with vertices V0 to V9 labelled;
- the plank (item 7);
- the turbine circles and the r_inner clearance circle (widest part + 200 mm);
- the start angle, and the angle of the worst cross-section error, with its value;
- the B Kammer and Length limits;
- next to it, a small chart of the cross-section error (real vs ideal area) against angle.

**Approach:**
- `designSemiSpiral.py` already computes the needed data (`ray_distances`, `area_error`, 321 sample angles). Emit the ideal curve samples and the per-angle error in its output.
- Show the sketch in the Chamber page while Semi-spiral casing is on (a debug panel is fine).
- Also write `spiral.svg` into `<outDir>/_debug/` when `CHAMBER_DEBUG_DUMP=1`.
- Adding data to the designer's output changes the spiral cache payload. Decide whether to bump `ALGORITHM` / `SPIRAL_ALGORITHM` or purge `chamber-spiral/`, and document the choice.

## 6. Selectable spiral start angle

**Today:** `phi_start` is fixed at 160° and hidden.

**Wanted (user decision):** a selectable start angle of **140°, 150° or 160°**, defaulting to 160°, so that existing builds, saves and cache keys do not change.

**Everywhere 160° is assumed today:**
- the new input: `ChamberInput`, zod, form, and the save fallback (old saves load at 160°);
- `phi_start` passed to `designSemiSpiral.py`, which enters the spiral hash;
- the B Kammer ↔ velocity formula `c = Q_max × (540 − 2 φ_start)/360 / (H Kammer × (B Kammer − 2 r_inner))`, in `chamberSpiralFlowVelocity` and `chamberSpiralVelocityOf`;
- the velocity-window refusal text and its B Kammer range;
- the degenerate-spiral check at R_cl(φ_start);
- the shortest-length pre-check;
- the vocabulary and the feature sheet.

**Tests:** designer and builder at 150° and 140° (the designer tests already have a 150° frame check). The golden cases stay at 160°.

Out of scope: making the angle an optimisation parameter.

## 7. Plank redesign

**Today** (`2026-09-29-semi-spiral-casing-design.md` §5.3, `buildChamber.py`):
- The plank runs from the nose tip V6, **tangent** to the dLast circle, continuing the V5 → V6 flank.
- It is 50 mm × Part scale thick (`SPIRAL_PLANK_THICK`), with `SPIRAL_PLANK_OVERLAP` at the ends.
- It runs from **LEB to the ceiling** and deliberately stops at LEB to avoid the vanes. It leaves a free edge above the cone top or above a typed generator height.

**Wanted (user decisions):**
- **Side:** the plank sits on the **V7–V8 line** of the nose, the flank opposite V5–V6.
- **Direction:** it always points at the **turbine axis** (radial).
- **Height:** it runs from the **bottom of the model to the ceiling**.
- **Inner end:** it follows the part profile all the way down, with a stepped inner edge per height band:
  - above LEB, it touches the dLast part (generator or cone);
  - in the guide-vane band, it stops **50 mm** from the guide vanes: the smallest distance between the plank and any vane surface is 50 mm;
  - below, it runs down along the **runner case with no gap** between plank and runner case.
- Thickness, the `tongue` patch (nose + plank, type `wall`) and the overlap idea are unchanged unless the spec says otherwise.

**Vane clearance (user decision):** 50 mm between the plank and the guide vanes, in both designs. It is measured to the real vane surfaces, not to a circle, so the plank's inner edge in the vane band depends on the vane count, angle and chord. Assumption: a fixed 50 mm, **not** scaled by Part scale, like the 200 mm nose clearance. Confirm this with the user in the spec. Add a builder check that the gap is 50 mm (± tolerance), and a `KO:` refusal if the plank cannot keep it.

**OPEN, ask before approving the spec:**
1. **Anchor point on V7–V8.** A radial line can cross V7–V8 at many points. The proposal is the point on V7–V8 closest to the axis, so the plank meets that face square-on (likely at or near V7). Confirm it.

**Also handle:**
- **Cone foot chamfer:** `known-issues.md` and the 2026-09-29 changelog log a wedge of fluid between the plank end and the 45° foot chamfer just above LEB. The new plank must follow the chamfer with no gap.
- **Without guide vanes:** define the inner edge on the middle cylinder too.
- **Meshing:** the new thin gap between plank and vanes is a likely snappy / cfMesh trouble spot (the lid-iteration kit already notes mesh failures at plank/lid corners). Flag it "to validate on the server" with a real mesh.
- **Tests:** rewrite the plank tests in `test_build_chamber.py`, which today assert "solid above LEB, fluid in the vane band". Keep the watertight check, the patch list, the tangency/radial check and the no-gap check on the runner case.
- **Deploy:** this is a builder change, so purge `$STORAGE_DIR/chamber/*`.

## 8. Adjustable optimisation step, per parameter

**Today:** every study parameter moves on the fixed 50 mm grid (`CHAMBER_GRID_MM`, spec Q2). The stored search space already has an unused optional `step` field (`ParamRange { key, base, min, max, step?, source }`).

**Wanted (user decision):** one step per ticked parameter, chosen from **50, 100, 150 or 200 mm**, defaulting to 50 mm.

**Behaviour:**
- The possible values are the multiples of the chosen step inside the band ∩ table Min / Max, with the bounds snapped inward as today. Example: B Kammer 4450 mm at ±10% with a 100 mm step gives 4100, 4200 … 4800.
- The baseline is still evaluated at the exact base value, even when that is off the grid.
- A step can empty a short parameter's range: 500 mm at ±10% with a 200 mm step has no value. Show this live in the form, and refuse it at creation (the existing 422).
- `optimiseSuggest.py` uses the step (Optuna `suggest_int` / `suggest_float` with `step`).
- Old studies without a stored step keep 50 mm.

**Tests:** search-space computation per step, the empty range, `test_optimise_suggest.py` honouring the step, and the form.

---

## 9. Housekeeping

- `brain/STATUS.md` still describes BF1 = LF1 / BF2 = LF2 as permanent ("Corner chamfers always at 45°"). That was reverted on 2026-09-30 (`fix/bf-relations-toggleable`). Rewrite the snapshot, as the brain's maintenance rules require.
- For each item, close with the changelog entry, feature sheet, codemaps + `python brain/codemap/build-index.py`, `decisions.md` (the user decisions above), `known-issues.md` (the plank / chamfer wedge once fixed) and `STATUS.md`.
