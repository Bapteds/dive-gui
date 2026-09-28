# Per-Patch Override Toggles — Design Spec

**Date:** 2026-08-11
**Branch:** `feat/chamber-creation`
**Status:** approved (pending user review)

## Problem

The two per-patch features already shipped on this branch write a per-patch entry for
**every** patch/surface, so the "global" settings become dead weight and there is no way to
say "this patch inherits the global" or "this surface has no feature edges":

1. **cfMesh per-patch layers** (`CfMeshConfigForm`): the form writes `addLayers.perPatch` for
   every discovered patch, seeded from the globals. A user cannot remove a patch's local
   override to let the global `boundaryLayers` block take over.
2. **snappy per-surface feature edges** (`SnappyConfigForm`): every surface is always feature-
   extracted (`surfaceFeatureExtractDict` has a block per STL, `snappyHexMeshDict` a `features`
   eMesh entry per region). There is no per-surface on/off.

## Decisions (from brainstorming)

- **cfMesh layers: Inherit vs Custom (two states).** Each patch row is either *inherit the
  global* (no `perPatch` entry) or *custom override* (its values written to `perPatch`). No
  per-patch "disable layers" — the single global "Add boundary layers" checkbox still governs
  whether layering happens at all.
- **snappy feature edges: per-surface on/off, OFF = no feature edges at all.** An OFF surface
  is excluded from feature extraction AND from feature refinement (no `surfaceFeatureExtract`
  block, no eMesh entry in `features`). Its sharp edges are simply not captured.
- **snappy per-surface layers: unchanged.** Keep the current on/off `surfaces[]` gate; do NOT
  add an inherit/override model there.

## Part A — cfMesh per-patch layers: Inherit vs Custom

**Web-only change** (`apps/web/src/features/meshing/CfMeshConfigForm.tsx`). The shared model,
Zod schema, and `cfMeshDicts.ts` renderer are already correct: the renderer emits a
`patchBoundaryLayers` sub-block ONLY for patches present in `perPatch`, and patches absent
inherit the global `boundaryLayers`. The only defect is the form writing every patch.

**Change:**
- Each per-patch layer row gains an **Override** checkbox (leading the row). Default =
  unchecked = *inherit global*.
- State: add `patchLayerOn: Record<string, boolean>` seeded from the saved config — a patch is
  "on" (custom) iff `initialConfig.addLayers.perPatch?.[name]` exists. A new patch defaults to
  OFF (inherit).
- The three value inputs (count / thicknessRatio / maxFirstLayerThickness) are disabled/greyed
  when the row is unchecked (inheriting), enabled when checked.
- Config build: `perPatch` receives an entry ONLY for rows whose checkbox is on; send
  `Object.keys(perPatch).length > 0 ? perPatch : undefined`. Unchecked rows are omitted, so the
  renderer inherits the global for them.

**Migration note:** configs saved by the previously shipped version have a `perPatch` entry for
every patch (all equal to the globals). On first load they seed as "custom" with global-equal
values → mesh identical; the user can uncheck any row to inherit. No data loss, no dict change
until re-saved.

**No shared / schema / renderer / snappy changes in Part A.**

## Part B — snappy per-surface feature-edge on/off

Mirror the boundary-layer `surfaces[]` gate for feature edges.

### Data model (`packages/shared/src/index.ts`)

Add to `SnappyConfig`:

```ts
  /**
   * STL surfaces (by file name) whose feature edges are extracted + refined. Omitted
   * or empty means EVERY surface (legacy default), so an old config keeps working.
   * A surface not in this list is excluded from surfaceFeatureExtractDict AND from the
   * snappyHexMeshDict `features` list — its edges are not captured.
   */
  featureSurfaces?: string[];
```

`DEFAULT_SNAPPY_CONFIG` unchanged (no key ⇒ all surfaces on).

### Validation (`meshing.schemas.ts`)

Add `featureSurfaces: z.array(z.string()).optional()` to `runSnappySchema` (next to
`featureRefinements`).

### Renderers (`snappyDicts.ts`)

Both feature sites must gate on the same set. Introduce a helper inside the module:

```ts
const chosen = config.featureSurfaces;
const featureOn = (file: string) => !chosen || chosen.length === 0 || chosen.includes(file);
```

- `renderSurfaceFeatureExtractDict(stlNames, config)`: emit a block only for `stlNames` where
  `featureOn(name)`. If none are on, the dict has an empty body (valid — extractor writes no
  eMesh).
- `renderSnappyHexMeshDict`: the `features (...)` list emits an eMesh entry only for regions
  where `featureOn(r.file)`. An all-off config yields `features ( );` (valid — no feature
  refinement). The per-region `includedAngle`/`level` (from `featureRefinements`) apply only to
  on-surfaces, unchanged.

`surfaceFeatureExtract` is still run as a pipeline step (it reads the dict); with fewer/zero
blocks it simply writes fewer/zero eMesh files. No pipeline-step change needed.

### Web (`SnappyConfigForm.tsx`)

- The per-surface feature-edge table (angle + level per STL) gains a **leading on/off
  checkbox** per row. Default ON (backward-compatible; a surface with feature edges).
- State: `featureSurfaceOn: Record<string, boolean>` seeded from the saved config — ON iff
  `featureSurfaces` is absent/empty (legacy = all on) OR includes the surface. New surface
  defaults ON. Kept in sync with the STL set like the sibling maps.
- The angle/level inputs are disabled/greyed when the row is OFF.
- Config build: write `featureSurfaces = stls.map(name).filter(on)`; still write
  `featureRefinements` for every surface (values are harmless for off surfaces, and keep the
  seed stable). Add `featureSurfaces` and `featureSurfaceOn` to the memo dependency array.

## Testing

- **cfMeshDicts / snappyDicts unit tests** (Part B renderer): a config with `featureSurfaces:
  ['rotor.stl']` and two STLs renders an extraction block + eMesh entry for `rotor` only; a
  config with no `featureSurfaces` renders both (byte-identical to today). An empty-selection
  config renders `features ( );` and no extraction blocks.
- **schema test:** `featureSurfaces` validates as an optional string array.
- **web:** cfMesh — a per-patch Override toggle off omits that patch from `perPatch` (autosave
  body), on includes it; snappy — a feature-edge row toggled off drops that surface from
  `featureSurfaces`. Both persist across reload. Verified via the autosave PUT body + reload,
  as with the prior features.
- **No-regression:** existing `meshing.test.ts` / `snappyDicts.test.ts` / `cfMeshDicts.test.ts`
  stay green.

## Backward compatibility

- Part A: renderer already inherits on absence; only the form changes. Old saved configs seed
  as all-custom (global-equal) → identical mesh until re-saved.
- Part B: `featureSurfaces` absent/empty ⇒ every surface on ⇒ dicts byte-identical to today.

## Out of scope

The 3D-view fix, the live meshing log, and mesh/case rename remain separate. No per-patch
"disable layers" for cfMesh; no inherit/override model for snappy layers; no new global params.
