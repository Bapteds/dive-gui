# Guide vane count: any integer from 8 to 32

> **Status**: implemented (2026-09-29), amendment §6 implemented (2026-09-30) · **Date**: 2026-09-29
> **Amends**: `2026-09-29-guide-vane-count-design.md` (WS-B, 16 or 18): the count becomes free within a range; the chord rule is generalised.
> **Area**: shared, API, python, web, tests

## 1. Goal
The user chooses any number of guide vanes, not only 16 or 18.

## 2. User decisions (2026-09-29)
1. `vaneCount`: integer, **8 to 32**, default 16.
2. Chord rule generalised from WS-B: each blade is scaled uniformly in plan by **16/n** about its pivot, pivot radius unchanged, pitch 360/n. Solidity is constant, so the blade-to-blade gap stays about 0.53 chord at every n; 16 and 18 build exactly as today.

## 3. Changes
- **Shared**: `CHAMBER_VANE_COUNT_MIN = 8`, `CHAMBER_VANE_COUNT_MAX = 32` (replace the 16/18 list); `ChamberInput.vaneCount` doc.
- **API**: zod `z.number().int().min(8).max(32).default(16)`; `resolveGeometryParams` keeps setting `vaneCount` only with guide vanes and only when ≠ 16, so every existing 16- and 18-vane build keeps its hash.
- **Builder**: accept any integer in [8, 32] (`ValueError` otherwise: "Guide vane count must be a whole number from 8 to 32 (got 7)."); scale `16/n`; the existing 2 mm overlap refusal stays. **New refusal** if a scaled blade outline leaves the distributor passage (reaches beyond the shroud brim edge `LE Ø/2` or inside the hub rim), measured on the real outlines: "With N guide vanes the blades (chord C mm) no longer fit between the hub and the runner case edge. Use between A and B vanes for this machine." (A and B computed if cheap, otherwise the lever sentence without them). The STEP path already fits the profile with a free scale: check it at 8 and 32.
- **Web**: the select becomes an integer number field "Guide vane count" (8 to 32, step 1, default 16, hint "Guide-vane builds only"); form message "Enter a whole number from 8 to 32".

## 4. Tests (first)
- pytest: 8 and 32 vanes on `stepped-vanes`: build, watertight, blade count on `guide_vanes` = n, gap ratio ≈ 0.53 chord at 45° and 55°; `--step` at 8 and 32 keeps `stepHasVanes: true` (or reports the fallback); 7 and 33 refused; 16 and 18 unchanged (GOLDEN).
- API: bounds 8/32, integer only, hash unchanged for 16 and for 18.
- Web: field bounds, integer, old saves (16/18) load as is.

## 5. Deployment
`buildChamber.py` changes ⇒ purge the chamber cache.

## 6. Amendment (2026-09-30): chord capped at the 16-vane blade
**Why**: with the 16/n rule the blades grew below 16 vanes until they left the distributor passage: 8 vanes never fitted on the test machines (tips 93 to 140 mm past LE/2, minimum 11 to 13 vanes), and the vaned STEP fell back at 8 (on a smaller ring) and ran for more than 30 min at 13.

**User decision (2026-09-30)**: the blade plan scale becomes **min(1, 16/n)**.
- Above 16 vanes the blades shrink as before (constant solidity; 18 unchanged, GOLDEN unchanged).
- Below 16 vanes the blades keep the 16-vane size: lower solidity, wider throat (smallest blade gap ≈ 1.18 chord at 45° and 1.24 at 55° with 8 vanes, against ≈ 0.52 to 0.58 at 16).

**Changes**
- Builder: `_vane_chord_scale(n) = min(1, 16/n)` used by `make_vane_patches` and by `_vane_count_fit` (a count m rescales the real outline by `scale(m)/scale(n)`). The "no longer fit" refusal and its range message are kept as a safety net: every count up to 16 draws the 16-vane blade and higher counts shrink it towards its pivot, so it should never fire on a real ring.
- Shared / API / web: doc comments only (the range 8..32, the key rule and the form are unchanged).
- Tests: 8 and 12 vanes build on `stepped-vanes` and `hollow-vanes` (watertight, n blades, chord = 16-vane chord); 8 vanes on the plain `stepped-vanes` ring at 45° / 55° (gap/chord 1.184 / 1.245); `--step` keeps the vanes at 8, 13 and 32.
- Measured (native Windows, CadQuery 2.8.0, two builds in parallel): `--step` on `stepped-vanes` with 8 vanes 28 s, 13 vanes 36 s, both `stepHasVanes: true`.
- Build keys: unchanged rule (16 omitted, other counts keyed); counts 8 to 15 now produce a different blade under the same key, so the chamber cache must be purged (it must be anyway after any builder change).
