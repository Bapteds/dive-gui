# Guide-vane pitch — direction and spindle position — design

**Date:** 2026-10-08
**Status:** approved (decisions taken by the user, Hristo Dimitrov, in a session with Claude Code); implemented on `fix/vane-pitch-spindle`.
**Feature:** Chamber Creation — guide-vane distributor, vane angle (`vaneAngleDeg`).
**Scope:** `apps/api/scripts/buildChamber.py` (`make_vane_patches`, the pitch in `main()`), its tests, doc comments in `packages/shared` / `apps/api` / `apps/web`, and the brain. No new parameter, no schema or UI change, so the build hash is unchanged (cache purge needed).

---

## 1. Problem

Found while generating a standalone 33° vane ring for the user (2026-10-08). Two defects in how each blade is turned to the requested angle:

1. **Direction.** The user's convention: a **smaller** absolute vane angle means **more open** vanes (33° is more open than the 50° asset). The builder applied `vaneAngleDeg − 50` as a counter-clockwise turn, which closes the vanes for angles below 50: 45° closed the ring and 55° opened it. Measured on the asset ring (scale 1, 16 vanes), turning 17° counter-clockwise widens the smallest blade-to-blade gap from 220.6 mm to about 250 mm; turning 17° clockwise narrows it to 167.9 mm.
2. **Spindle.** The spindle (the point each blade turns about) was put at `pivotRadius` (0.86732 m, the CAD value) on the azimuth of the **mean of the blade mesh vertices**. The leading edge is densely tessellated (about 2100 of the 4067 vertices at r > 0.99 m), which drags that azimuth 3.6° away: the point (0.27948, −0.82106) m sits **15.0 mm outside** the blade, so a pitched blade slid sideways instead of turning in place (about 4.7 mm at ±5°). The same point is the centre of the chord scaling for vane counts above 16.

## 2. The rules

- **Pitch**: `pitch = VANE_BASE_ANGLE_DEG − vaneAngleDeg` (degrees, counter-clockwise about +z), held by the pure helper `_vane_pitch_deg(vane_angle_deg)`. 45° turns the blades 5° counter-clockwise (more open), 55° turns them 5° clockwise (more closed). The accepted range stays 45..55.
- **Spindle** (asset frame, before placement): on the circle `r = pivotRadius` about the ring axis, at the **mid-thickness** of the blade: the mid-point (mid-azimuth) of the arc where that circle crosses the blade's mid-height section. Held by the pure helper `_vane_spindle_xy(np, loop, radius)`, which intersects the circle with the closed outline and raises `ValueError` unless it crosses it exactly twice. On the committed asset: (0.3303, −0.8020) m, azimuth −67.62°, about 28.5 mm inside the outline, about 50 % of the chord from the leading edge. Placement keeps scaling it with the ring (`s`) and the vane-count chord scale keeps using it as its centre.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Sign convention | Smaller `vaneAngleDeg` = more open (user, 2026-10-08). |
| 2 | Spindle radius | `pivotRadius` 0.86732 m stays the authority (user, 2026-10-08: "it was supposed to be this 0.86732 point from the axis origin"). |
| 3 | Spindle azimuth | Mid-thickness where that circle crosses the blade (the only place on the circle inside the blade is 45–56 % of the chord, 49–52 % with 20 mm of material around a bore). A CAD spindle position, if the user supplies one later, replaces this rule. |
| 4 | Source of the outline | The blade mesh's own mid-height section (already loaded; no new dependency on `guideVanes_blade_profile.json`). |

## 4. Consequences

- **Unchanged**: every build at 50° with 16 vanes or fewer (no pitch, no chord scaling: the spindle is not used). All 16-vane GOLDEN volumes stay.
- **Changed on purpose**: builds at an angle other than 50° (opposite direction, new centre) and builds with more than 16 vanes (chord scaled about the new centre). `stepped-vanes-18` GOLDEN and the `VANE_GAP_RATIO` table of the free-count test are re-measured.
- **Saves**: a saved build at 45° now regenerates more open than before (and 55° more closed). No migration: the field keeps its value, its meaning is now the user's.
- **Cache**: purge `apps/api/storage/chamber/*` locally and `<STORAGE_DIR>/chamber/*` on the server (the hash does not cover code).

## 5. Tests

- `_vane_pitch_deg`: 45 → +5, 50 → 0, 55 → −5.
- `_vane_spindle_xy`: a synthetic rectangle crossing a circle gives the mid-arc point; an outline the circle misses raises `ValueError`.
- `make_vane_patches` at scale 1: the returned `pivot` lies on `r = pivotRadius` and inside the blade's mid-height outline; the motion between two angles is a rotation about that pivot; the smallest blade gap at 45° is wider than at 50°, which is wider than at 55°.
- End to end (CadQuery): the free-count gap table re-measured with gap(45°) > gap(55°) at 8 and 32 vanes; the full geometry suite green.
- Found while verifying: `test_vane_skin_stays_on_the_guide_vanes_patch[stepped-vanes-18]` read four sub-µm shroud-floor slivers as blade skin because it recomputes normals from the ASCII triSurface (~1 µm rounding). The check now skips faces under 10 µm high; the builder's labels were right.

## 6. Out of scope

- The UI helper text of the Vane angle field (unchanged; it does not state a direction).
- A CAD-measured spindle position (none in the repo: `GuideVanes50Deg.STEP` holds only surfaces).
