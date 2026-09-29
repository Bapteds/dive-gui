# Guide vane count: any integer from 8 to 32

> **Status**: implemented (2026-09-29) · **Date**: 2026-09-29
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
