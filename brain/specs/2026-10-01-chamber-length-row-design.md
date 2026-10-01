# Chamber Length: one Parameters-table row with Min / Max / Exact in both modes

> **Status**: draft, awaiting user approval · **Date**: 2026-10-01 · **Feature**: `brain/features/chamber-creation.md` · **Brief**: `brain/briefs/2026-09-30-chamber-spiral-and-optimisation-fixes.md` item 2 · **Builds on**: `2026-09-30-spiral-length-design.md` · **Branch**: `feat/chamber-length-row`

## 1. Goal

Today the chamber Length has two controls: without the semi-spiral, a form field `Length (mm)` (`ChamberInput.lengthOverride`, blank = 2 × B Kammer, no Min / Max / Exact); with the spiral, a Parameters-table row backed by `ChamberInput.spiralLength` (Min / Max / Exact). The user wants **one Length row in the Parameters table, with Min / Max / Exact, in both modes**, defaulting to 2 × B Kammer.

## 2. User decisions (2026-10-01)

1. **Length is a real model row** (option "add a Length row to the model"), not a dedicated field drawn as a row.
2. **Length is pickable in optimisation studies** (the brief's OPEN point).

Settled by the brief (not re-asked): Min / Max / Exact in both modes; default 2 × B Kammer; old saves load (`lengthOverride` → Length Exact, `spiralLength` as is).

## 3. Changes

### 3.1 Shared model (`packages/shared`)

- `CHAMBER_OUTPUT_KEYS` gains `'length'`, placed **right after `'width'`** (display order: B Kammer, Length, H Kammer, …). It is already the param name `buildChamber.py` reads.
- `CHAMBER_OUTPUT_SPECS` gains a Length spec, label `Length`. It has **no empirical fit**: it is an always-on identity `= 2 × B Kammer` (a `combination` over `width` with coefficient 2, not `empirical`). So:
  - an empirical B Kammer (on the 50 mm grid) gives 2 × B Kammer, already on the grid; a user-driven B Kammer (Exact, bitten Min / Max) propagates verbatim, like every identity today;
  - Min / Max / Exact apply through the shared `resolveChamberFinal` like any other row, with the usual statuses (`from relation` with label `= 2 × B Kammer`, `set exact`, `capped at max`, `raised to min`, `! min>max`);
  - the identity **cannot be turned off**: it is left out of `CHAMBER_RELATIONS` (the "Configure relations (n/9 on)" list keeps its 9 entries) and ignores `relations.length` / `relationsMaster: false`;
  - no confidence claim: the Confidence column shows `-` (the spec type gets whatever minimal change this needs, e.g. an identity-only flag; no invented `cvError`).
- **Legacy fields**: `ChamberInput.lengthOverride` and `ChamberInput.spiralLength` stay in the type and in zod as **accepted legacy inputs**, marked deprecated. A new shared helper `normaliseChamberLength(input)` folds them into `constraints.length` and removes them:
  - `constraints.length` already present ⇒ it wins, the legacy fields are dropped;
  - else, `semiSpiral === true` and `spiralLength` set ⇒ `constraints.length = spiralLength`;
  - else, `lengthOverride` set ⇒ `constraints.length = { exact: lengthOverride }`;
  - else nothing.
  (`spiralLength` was only read with the spiral on, and `lengthOverride` only with it off, so this mapping keeps what each old save actually built.)
- `chamberSpiralLengthLimits(input)` reads `constraints.length` (after normalisation) instead of `spiralLength`.
- `studyPickableKeys(base)`: `length` is pickable **when the semi-spiral is off**. With the spiral on, it is not pickable in this item (its default is still the spiral's own length, not 2 × B Kammer); item 1 of the brief makes the default 2 × B Kammer with the spiral too and will lift this restriction. The refusal text for a spiral base names the reason.

### 3.2 API (`apps/api`)

- `chamber.service.ts` normalises the body first (`normaliseChamberLength`), so the outputs, the refusals, the hash and the persisted `input.json` all see one Length.
- `resolveGeometryParams`: the plain box takes `params.length` from the Length output's FINAL through the existing loop over `CHAMBER_OUTPUT_KEYS` (the special `input.lengthOverride ?? 2 * widthMm` line goes). With the spiral on, `length` is skipped like the spiral-derived keys (the spiral derives the box length, as today).
- The inverted-range refusal: the special `Length: Min X > Max Y` branch goes; Length is refused by the generic `! min>max` path ("Length: Min X > Max Y" wording unchanged). With the spiral on, the Length inverted range is refused exactly as today.
- Studies (`studies.service.ts`, `studyRunner.ts`): the stored base design is normalised before use, so old studies whose base carries `lengthOverride` build the same geometry. The study param-key enum gets `length` automatically from `CHAMBER_OUTPUT_KEYS`.
- Chamber saves: no migration. Saves store the build body; old snapshots are normalised when built (API) and when loaded (web).

### 3.3 Web (`apps/web`)

- **Parameters table** (`ChamberOutputsTable.tsx`): Length is an ordinary editable row in both modes (same `NumCell`, aria labels "Length minimum / maximum / exact", statuses, Final). The special spiral Length row is removed; with the spiral on, the Length row keeps today's spiral behaviour: Final = the build's spiral length, statuses `set exact` / `! min>max` / `capped at max` / `raised to min` / `from spiral` (`spiralLengthStatus` stays).
- **Form** (`ChamberInputsForm.tsx`): the `Length (mm)` field is removed. The read-only Casing flow velocity keeps its current slot when the spiral is on; the slot is empty without the spiral (item 3 of the brief moves the velocity field; nothing else is placed there in this item).
- `chamberForm.ts` / `ChamberPage.tsx`: the separate `spiralLength` state goes; the Length constraint lives in the table constraints like every other row. Loading a save, a study hand-off or a stored build input runs `normaliseChamberLength`. The page no longer sends `lengthOverride` or `spiralLength`.
- **Optimisation** (`StudyCreateForm.tsx`): Length appears in the pickable list for a non-spiral base design, with its band, Min / Max and 50 mm grid like the other rows. Picking it with B Kammer shows the existing relation warning ("Length = 2 × B Kammer: optimising Length together with B Kammer pins Length…").

### 3.4 Not changed

`buildChamber.py`, `designSemiSpiral.py`, the spiral behaviour (Max ⇒ `max_length`, Min ⇒ inlet extension), the MCP server (it forwards the body; old clients sending `lengthOverride` still work).

## 4. Cache, hash and purge

- `chamberHash` sorts the param keys, so moving `params.length` into the output loop does not change the key order.
- Plain box, no Length typed: `params.length` = 2 × B Kammer FINAL × 0.001, the same number as today ⇒ **same hash**. With an old `lengthOverride` (now an Exact): the same number as today ⇒ same hash. A typed Min / Max is new behaviour (new values ⇒ new keys, as for any row).
- Spiral on: `params.length` is still absent and the spiral inputs are unchanged (`max_length` only with a Max or Exact, as today) ⇒ **no spiral re-key**.
- **No builder change ⇒ no `$STORAGE_DIR/chamber/*` purge, no `chamber-spiral/` purge.**

## 5. Backward compatibility

| Stored data | Loads as | Builds as |
|---|---|---|
| save / study base with `lengthOverride: N`, spiral off | Length Exact N | same geometry, same hash |
| save with `spiralLength` (Min / Max / Exact), spiral on | Length row with those values | same as today |
| save with `lengthOverride` and spiral on (ignored today) | nothing (`lengthOverride` was ignored with the spiral) | same as today |
| save with `spiralLength` and spiral off (ignored today) | nothing (if no `lengthOverride`) | same as today |
| no Length data | blank row, default 2 × B Kammer | same as today |

## 6. Tests (written first)

- **Shared** (`chamberModel.test.ts`): Length = 2 × B Kammer (empirical B Kammer on the grid; user-driven B Kammer verbatim); Min / Max / Exact statuses; inverted range flagged; relation not toggleable (`relationsMaster: false` keeps it); `CHAMBER_RELATIONS` still 9; `normaliseChamberLength` (each row of the table in §5, and `constraints.length` winning); `chamberSpiralLengthLimits` from `constraints.length`; `studyPickableKeys` with Length (spiral off: yes; spiral on: no); `computeParamSpace` for Length; relation warning Length + B Kammer.
- **API** (`chamber.test.ts`, `chamberSaves.test.ts`, studies tests): no Length ⇒ same `params.length` and same hash as a frozen pre-change hash; `lengthOverride` ⇒ same hash as before; Length Max binding on the plain box ⇒ `params.length` = Max; inverted Length refused (both modes, wording); spiral builds unchanged (spiral inputs, hash) with `constraints.length` instead of `spiralLength`; old snapshot with `spiralLength` builds the same; a study with a Length param applies it as an Exact.
- **Web**: table shows the Length row in both modes (editable cells, statuses, Final); the form no longer has a Length field; loading a save with `lengthOverride` fills the Length Exact cell; `StudyCreateForm` lists Length for a non-spiral base.
- Targeted suites + `npm run typecheck` after `npm run build:shared`. Python suites untouched (no builder change).

## 7. Out of scope

The spiral designed inside the Length (item 1), moving the Casing flow velocity field (item 3), Length pickable with the spiral on (comes with item 1), any builder change.
