# Deferred guide-vane STEP export — design

**Date:** 2026-09-01
**Status:** approved ("make the STEP download be optional", after measurement)

## Why

Measured on real builds: the plain (non-vane) STEP write costs 0.05 s of a
2.2 s build, but the guide-vane STEP work — carving the blades as editable OCC
BREP plus the export/re-import verification gate — costs 23–28 s, i.e. roughly
TWO THIRDS of a 36–40 s vane build. Deferring it cuts every vane Generate to
~12–13 s; the price is that the FIRST STEP download of a vane build re-runs the
builder (~35–40 s, once per build; cached after, and the mirrored STEP reuses
it).

## Builder (`buildChamber.py`)

- New optional CLI flag: `buildChamber.py <params> <outDir> [--step]`.
- **Non-vane builds:** unchanged — `chamber.step` is written at build time in
  both modes (it is effectively free).
- **Guide-vane builds, normal mode (no flag):** the vane STEP carve + gate and
  the `chamber.step` export are SKIPPED, and no `build-meta.json` is written
  (whether the vanes carve cleanly is simply unknown yet).
- **Guide-vane builds, `--step`:** today's full behaviour — carve + gate,
  `chamber.step` (real vanes, or the vane-less fallback with its WARN), and
  `build-meta.json` with `stepHasVanes`. The flag re-runs the whole build into
  the same directory (the other artifacts are rewritten with identical
  content — harmless); the pipeline state the gate needs (reference fluid
  volume, profiles, vane meshes) cannot be reconstructed more cheaply.

## API (`chamber.service.ts`)

- `getChamberExport('step')` gains generate-on-first-use, like the mirrored
  kind: if `exports/chamber.step` is missing and the build exists (GLB on
  disk), run the builder with `--step` (same interpreter/timeout/env as a
  build), then serve. 409 `CHAMBER_NOT_BUILT` when the build itself is absent;
  502 `CHAMBER_BUILD_FAILED` with the stderr tail on failure. The persisted
  `warnings.json` of the original build is NOT touched by this run.
- `getChamberExport('stepMirrored')`: if the mirrored file is missing and
  `chamber.step` is missing too, generate the STEP first (above), THEN apply
  the existing gate (`stepHasVanes === true`) and mirror. So one click on
  "Change rotational direction" can pay both steps.
- The build response keeps `stepHasVanes` (now usually `null` for fresh vane
  builds; still `true`/`false` for builds whose STEP was generated before).

## Web

- `ChamberExportButtons` prop changes from `stepHasVanes` to a computed
  `offerMirror: boolean`; `ChamberPage` passes
  `guideVanes && stepHasVanes !== false` captured at build success (the
  mutation's input carries `guideVanes`): the option shows for every vane
  build, and hides only when a previously generated STEP is KNOWN to be the
  vane-less fallback. If the on-demand generation discovers the fallback, the
  download errors with the server's clear 409 message as a toast.
- First-click UX: when a vane build's STEP (plain or mirrored) download starts,
  show an info toast that the first download of a build can take about a
  minute; the button keeps its loading spinner throughout.

## Testing

- **Geometry (pytest):** the `build` fixture gains `step: bool = False`
  (part of the cache key, appends `--step`). A plain vane build ships NO
  `chamber.step` and NO `build-meta.json`; a `--step` vane build ships both
  (`stepHasVanes` asserted true for both vane fixtures, as today); non-vane
  builds keep shipping `chamber.step` without the flag. The mirror test feeds
  off a `--step` build.
- **API (fake runners):** a vane-like fake that writes no STEP at build; the
  first `GET /export/step` invokes the builder again with `--step` (asserted
  on the args) and serves the file, the second serves from disk without a run.
  `GET /export/stepMirrored` with neither file generates the STEP (with
  `--step`), then mirrors — two tool runs, then cached. Absent build → 409;
  tool failure → 502.
- **Web:** export-buttons tests renamed prop; menu shown for `offerMirror`,
  plain button otherwise; info toast fired on vane STEP downloads.

## Out of scope

- Deferring the plain (non-vane) STEP — measured at 0.05 s, deferral would
  only add a pointless rebuild to its first download.
- Persisting intermediate pipeline state to make `--step` cheaper than a
  rebuild.
