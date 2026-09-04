# Mirrored STEP download ("Change rotational direction") — design

**Date:** 2026-09-01
**Status:** approved (user decisions: option offered ONLY for proper vane
STEPs; the mirrored file is generated ON DEMAND at first download)

## Goal

When the STEP export carries the real guide vanes (no fallback, no errors),
offer a second download that mirrors the whole build on the z-y plane —
reversing the machine's rotational direction (the vanes curve the other way,
the runner turns the other way). The option is called **"Change rotational
direction"** and appears when the user clicks the STEP download.

## Preconditions (what "proper STEP" means)

`buildChamber.py` already writes `build-meta.json` next to the build with
`stepHasVanes`:

- `true` — guide-vane build whose OCC vane solid passed the re-import volume
  gate; `exports/chamber.step` carries editable vanes. **Only this case gets
  the option.**
- `false` — guide-vane build that fell back to the vane-less solid. No option.
- file absent (API reports `null`) — non-vane build. No option.

The builder is untouched by this feature.

## New script: `apps/api/scripts/mirrorStep.py`

Small standalone CadQuery script, same runtime as `buildChamber.py`
(`CHAMBER_PYTHON_BIN`). Usage: `mirrorStep.py <input.step> <output.step>`.

1. Import the STEP (`cq.importers.importStep`).
2. Record the original bounding box; mirror about the **YZ plane** (x → −x).
3. Translate in x by `(xmin + xmax)` of the ORIGINAL bounding box, so the
   mirrored model occupies exactly the original bounding box — only the
   handedness flips.
4. Export to `<output.step>.tmp` in the destination directory, then
   `os.replace` onto the final name (atomic: a concurrent reader never sees a
   half-written file).
5. Contract mirrors the builder: `OK: mirrored` on stdout / exit 0;
   `KO: <reason>` on stderr / exit 1 on any failure. No warnings channel — a
   mirror either succeeds or fails.

## API

### Build response

`ChamberBuildResult` (shared type + `POST /chamber/build` response) gains
`stepHasVanes: boolean | null`, read from `build-meta.json` via a new
`readChamberBuildMeta(hash)` in `chamberStorage.ts` (absent file → `null`).
Populated on BOTH paths — fresh build and cache hit — so the UI always knows
whether to offer the option.

### Mirrored export

- `chamberStorage.ts`: `CHAMBER_EXPORT_FILES` gains
  `stepMirrored: 'chamber-mirrored.step'`, giving the storage read and the
  route param validation the new kind for free.
- `GET /chamber/:hash/export/stepMirrored` (the existing export route, new
  kind) with generate-on-first-use semantics in `chamber.service.ts`:
  1. If `exports/chamber-mirrored.step` exists → serve it (cached).
  2. Else read `build-meta.json`; unless `stepHasVanes === true`, throw
     409 `CHAMBER_NOT_BUILT` with the message "The mirrored STEP is only
     available when the STEP export carries the guide vanes." The UI hides
     the option in this case anyway; the check guards direct URL calls.
  3. Else run `mirrorStep.py chamber.step chamber-mirrored.step` through the
     injectable command runner (script path resolved like the builder's,
     `MIRROR_STEP_SCRIPT` env override; `CHAMBER_BUILD_TIMEOUT_MS` timeout).
     On failure → 502 `CHAMBER_BUILD_FAILED` with the stderr tail, and no
     output file is left behind (the atomic rename guarantees this).
  4. Serve the file.
- Concurrency: no lock. Two simultaneous first-clicks both run the script;
  both writes are atomic renames of identical content — harmless. After the
  first success the file is served like every other cached export.

## Web (`ChamberExportButtons`)

The component gains a `stepHasVanes: boolean | null` prop (threaded from the
build response, stored on `ChamberPage` alongside `hash`, reset with it).

- STL and OpenFOAM triSurface: unchanged plain buttons.
- STEP with `stepHasVanes !== true`: unchanged plain download button (today's
  behaviour).
- STEP with `stepHasVanes === true`: the button becomes a dropdown trigger
  (house Radix `DropdownMenu` pattern, chevron affordance) with two items:
  - **Download STEP** — today's `chamber.step` download.
  - **Change rotational direction** — fetches `stepMirrored`, downloads as
    `chamber-mirrored.step`. The button shows its loading spinner during the
    one-time generation (~10–30 s); a toast explains failures, like every
    other export.

## Testing

- **Geometry (pytest, WSL cadquery-env):** run `mirrorStep.py` on a built
  guide-vane STEP → output exists; re-import: same solid count, volume equal
  within tolerance, bounding box identical, centroid x mirrored about the box
  centre (x' ≈ xmin + xmax − x); a nonexistent input exits 1 with `KO:`.
- **API integration (fake runner):** fake builder writes `build-meta.json`
  (`true` / `false` / absent) → build response reports `stepHasVanes`
  accordingly, on fresh and cached builds. Mirrored export: fake mirror runner
  writes the file → 200 and the runner is invoked exactly once across two
  requests (second is cache-served); `stepHasVanes: false` or absent meta →
  409; unauthenticated → 401; runner failure → 502 with detail.
- **Web:** STEP renders as plain button when `stepHasVanes` is `false`/`null`;
  as dropdown with both items when `true`; "Change rotational direction"
  calls the `stepMirrored` API and triggers the object-URL download; API error
  surfaces as a toast.

## Implementation note (discovered while testing)

OCC's analytic mass properties (`BRepGProp`) are unreliable on mirrored
("indirect") surface parametrizations: on this model the mirrored STEP
round-trips with a +0.10% phantom `Volume()` while the ACTUAL geometry is
exact — tessellating the original, the in-memory mirror, and the re-imported
mirrored STEP yields byte-identical watertight mesh volumes (135.473404 m³ on
the stepped-vanes fixture). The geometry test therefore compares tessellated
(trimesh) volume/bounds/centroid, not BRep mass properties.

## Out of scope

- Mirroring the STL / triSurface exports or the GLB preview (STEP only).
- Any change to `buildChamber.py` or the build cache key (the mirrored file
  is derived content inside an existing build directory).
