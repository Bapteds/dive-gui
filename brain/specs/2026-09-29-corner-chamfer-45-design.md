# Chamber corner chamfers always at 45°

> **Status**: implemented (2026-09-30), approved 2026-09-29 · **Date**: 2026-09-29
> **Area**: shared (model), API, web, tests (no builder change)

## 1. Goal
The two cut corners of the chamber (option "Chamfer") are always 45°: BF1 = LF1 and BF2 = LF2 in every case.

## 2. User decisions (2026-09-29)
1. BF1 and BF2 always follow LF1 and LF2. The two identity relations `chamferWidth1 = LF1` and `chamferWidth2 = LF2` become **permanent**: they leave the "Configure relations" menu and are not switched off by the Structural relations master switch.
2. In the Parameters table the BF1 / BF2 rows are **read-only** (status "= LF1" / "= LF2"); only LF1 / LF2 take Min / Max / Exact.

## 3. Changes
- **Shared model** (`CHAMBER_OUTPUT_SPECS`, `computeChamberOutputs`, `CHAMBER_RELATIONS`): `chamferWidth1` and `chamferWidth2` are always `= chamferLength1` / `= chamferLength2` (Final copied, `userDriven` inherited), whatever `relationsMaster`, `relations` or `constraints` say; any constraint on them is ignored. `LF2 = LF1` stays a normal toggleable relation. Relations menu count goes from 9 to 7.
- **API**: nothing new beyond the model (the builder receives BF = LF). Old saves carrying a BF Exact or a disabled BF relation now build at 45° (their hash changes, which is the intended fix).
- **Web**: `ChamberOutputsTable` BF rows without Min / Max / Exact inputs, status text "= LF1" / "= LF2"; relations menu without the two BF entries. Loading an old save with BF constraints drops them silently.
- **Semi-spiral casing**: unchanged. The four chamfer rows there come from the spiral outline (read-only, "from spiral") and follow the area law, not 45°.
- **Builder**: unchanged (it still reads the four values).

## 4. Tests (first)
- `chamberModel.test.ts`: BF = LF with relations master off, with the BF relation keys set false, with a BF Exact, with an LF Exact (BF follows, user-driven); LF2 = LF1 still toggleable.
- `chamber.test.ts`: a body with a BF1 Exact ≠ LF1 builds with BF1 = LF1 (same hash as without the constraint).
- Web: BF rows read-only, relations menu 7 entries, old save with BF constraint loads without error.

## 5. Deployment
No builder change: no cache purge needed (Finals change re-keys the affected builds by themselves).
