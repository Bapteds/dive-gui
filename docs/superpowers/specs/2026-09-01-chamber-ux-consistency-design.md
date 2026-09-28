# Chamber UX consistency: fallback warning, stale state, snap visibility, min>max — design

**Date:** 2026-09-01
**Status:** approved (batch 3 "medium" of the chamber review: findings 8, 9, 10, 12)

## 8. The on-demand STEP's warnings are no longer lost

- `generateStep` (chamber.service.ts) extracts the `--step` run's WARN lines
  and merges the NEW ones (deduped against the persisted list) into
  `warnings.json`, so the vane-less-fallback notice survives and every later
  cache hit reports it.
- The web can't read warnings out of a blob download, so after a successful
  vane STEP / mirrored-STEP download `ChamberPage` silently re-POSTs the SAME
  build body it built last (`lastBuildInput`, a guaranteed cache hit — the
  per-hash lock and GLB check make it a pure read): the warnings panel picks
  up the new notice with a toast, and `stepHasVanes` refreshes — a discovered
  fallback collapses the STEP menu back to a plain button (consistent with
  "hide a KNOWN fallback"). A failed refresh is ignored (the download itself
  succeeded).
- `ChamberExportButtons` gains an optional `onDownloaded(kind)` callback fired
  after a successful download.

## 9. No more stale "last build" state

- Loading a save clears the whole last-build state: `hash`, `offerMirror`,
  `buildWarnings`, `buildErrors`, `lastBuildInput` (the viewer returns to its
  empty state until Generate).
- A failed Generate (API error or invalid submit) clears `buildWarnings` too —
  no more previous-build orange notes under the new red errors.
- New `lastBuildInput` state (the exact body of the last successful build)
  powers a staleness note: when a build exists and the current form +
  constraints differ from it, the Export card shows "Inputs changed since this
  build — the preview and downloads still show the previous geometry.
  Generate to refresh." Downloads stay enabled (the old geometry may be
  wanted); the note just names the mismatch. Compared by JSON.stringify of the
  build body (stable key order — both sides are built by the same code path).

## 10. The 50 mm snap becomes visible

- The Parameters card's header hint becomes "values in mm · empirical values
  snap to the 50 mm grid".
- The Final column head carries a title: model estimates are rounded to the
  nearest 50 mm; Exact / bitten Min/Max values pass through unrounded and
  true identities propagate them verbatim.

## 12. An inverted Min>Max range refuses to build

- API (`buildChamber`): outputs with status `! min>max` refuse with 422
  `VALIDATION_ERROR` naming each output ("B Kammer: Min 5000 > Max 4000") —
  the contradiction can no longer build on the silently-ignored model value.
- Web (`onGenerate`): the same check runs on the live outputs BEFORE the
  request; it fills the red notices panel + toast without a round trip. The
  table's `! min>max` status cell stays as the inline pointer.

## Tests

- API: min>max build → 422 naming the output; a `--step` run that emits the
  fallback WARN → the warning is merged once into `warnings.json` (a later
  cache-hit build reports it; no duplicates when the run repeats old WARNs).
- Web: export buttons fire `onDownloaded` after a successful download (and not
  after a failure); the Parameters header shows the grid note.
- Page-level behaviours (state clearing, staleness note, silent refresh) have
  no existing ChamberPage harness; they ride on the component/API tests and
  manual verification — noted, not expanded, in this batch.

## Out of scope

- The remaining review minors (a11y contrast/titles, toast-on-every-download,
  Cache-Control, cascade-delete of saves, builder-version cache key).
- Viewer-side "outdated" chip (the viewer has no header; the Export-card note
  covers the export/preview staleness in one place).
