# Per-Patch Feature-Edge Extraction — Design Spec

**Date:** 2026-08-11
**Branch:** `feat/chamber-creation`
**Status:** approved (pending user review)

## Problem

Feature-edge extraction in the meshing tab is a **global** setting today:

- **snappy** extracts feature edges with a single `includedAngle` (hardcoded `150°` in
  `renderSurfaceFeatureExtractDict`) applied to every STL region, and refines the
  extracted edges with a single global `featureLevel` (default `2`) applied to every
  region in `snappyHexMeshDict`.
- **cfMesh** merges all STLs into one surface and runs `surfaceFeatureEdges -angle X`
  **once** on the combined surface (`extractFeatures` bool + `featureAngle`, default `45°`).

The user wants feature-edge extraction to be settable **per patch / per STL** rather than
one value for all patches at once — both the **angle** and the refinement **level**.

## Decisions (from brainstorming)

1. **snappy is per-patch; cfMesh stays global.** cfMesh architecturally merges every STL
   into one surface and runs a single `surfaceFeatureEdges` invocation, and it has no
   feature-*level* concept at all (that is snappy's octree refinement). Making it per-patch
   would require per-STL extraction + FMS merging — out of scope. cfMesh keeps its single
   merged-surface extraction, and **its `featureAngle` default stays `45°`** (unchanged).
2. **Both the angle and the level are per-patch for snappy.**
   - `includedAngle` (the `surfaceFeatureExtract` threshold): global default **150°**.
   - `featureLevel` (the snappy octree refinement count near the edge): global default **2**
     (unchanged). Sane range `0–10`; `150` would be a non-terminating refinement, so the
     level default stays `2` — only the angle default is `150`.
3. **Mirror the existing `surfaceRefinements` pattern:** a global default pair plus an
   optional per-STL override map keyed by STL file name. A patch absent from the map falls
   back to the globals, so **every existing saved config keeps working unchanged**.

## Architecture

Single vertical slice through the three layers, snappy only:

```
packages/shared/src/index.ts        SnappyConfig: + featureAngle, + featureRefinements
apps/api/src/modules/meshing/
  meshing.schemas.ts                 Zod: + featureAngle, + featureRefinements
apps/api/src/lib/snappyDicts.ts      renderers read per-patch angle + level (fallback globals)
apps/web/src/features/meshing/
  SnappyConfigForm.tsx               per-surface angle + level inputs (seeded from globals)
```

No change to cfMesh (`CfMeshConfig`, `cfMeshPipeline.ts`, `CfMeshConfigForm.tsx`), the
meshing service/controller/routes, storage, or the shared model.

## Data model (`SnappyConfig`)

```ts
/** Per-patch feature-edge extraction override (snappy). Keyed by STL file name. */
export interface FeatureRefinement {
  /** surfaceFeatureExtract includedAngle threshold (deg, 0–180). */
  includedAngle: number;
  /** snappy octree refinement level applied near the extracted edges (int, 0–10). */
  level: number;
}

export interface SnappyConfig {
  // …existing fields…
  /** Global default feature-edge refinement level (used where no per-patch override). */
  featureLevel: number;                 // existing; default stays 2
  /** Global default surfaceFeatureExtract includedAngle (deg); default 150. */
  featureAngle: number;                 // NEW
  /** Per-STL feature overrides keyed by file name; absent key => the two globals. */
  featureRefinements?: Record<string, FeatureRefinement>;  // NEW
  // …existing fields…
}
```

`DEFAULT_SNAPPY_CONFIG` gains `featureAngle: 150` and no `featureRefinements` key (undefined
= all patches use the globals).

### Validation (`meshing.schemas.ts`)

```ts
const featureRefinementSchema = z.object({
  includedAngle: z.number().min(0).max(180),
  level: z.number().int().min(0).max(10),
});
// in the snappy object:
featureLevel: z.number().int().min(0).max(10).default(2),          // existing
featureAngle: z.number().min(0).max(180).default(150),             // NEW
featureRefinements: z.record(z.string(), featureRefinementSchema).optional(),  // NEW
```

## Dict rendering (`snappyDicts.ts`)

Both renderers take the config and resolve each region's values with a global fallback,
exactly like `surfaceRefinements` does for cell refinement:

- `renderSurfaceFeatureExtractDict(stlNames, config)` — signature gains `config`. Each
  block's `includedAngle` = `config.featureRefinements?.[name]?.includedAngle ?? config.featureAngle`.
- `renderSnappyHexMeshDict` — the `features { { file … level N } }` block uses
  `config.featureRefinements?.[name]?.level ?? config.featureLevel` per region.

The `surfaceFeatureExtractCoeffs` structure (`extractionMethod extractFromSurface`,
`subsetFeatures { nonManifoldEdges no; openEdges yes; }`, `writeObj no`) is unchanged apart
from the now-per-patch `includedAngle`.

## UI (`SnappyConfigForm.tsx`)

Under the existing "Feature-edge level" field, replace the single global level input with a
**per-surface table**: one row per STL, columns **Angle (°)** and **Level**, each input
seeded from the global default (150 / 2). A global "default" pair still drives new/absent
patches. On submit, a surface whose two inputs equal the globals is omitted from
`featureRefinements` (keeps the payload and saved config minimal, like the layers list does);
any surface that differs is written into the map. This mirrors the per-surface layers block
already rendered just below.

## Backward compatibility

- Saved configs without `featureAngle` → Zod default fills `150`; without `featureRefinements`
  → undefined, so every patch uses the globals. Geometry identical to today (the hardcoded
  angle was already 150 and the global level was already 2).
- cfMesh configs are untouched.

## Testing

- **snappyDicts unit tests:** a config with a `featureRefinements` override for one STL
  renders that STL's `includedAngle` and `level` from the override and the others from the
  globals; a config without the map renders every region at 150 / 2 (byte-identical to today).
- **schema tests:** `featureAngle` default is 150; `featureRefinements` validates
  angle 0–180 and integer level 0–10; out-of-range rejected.
- **No-regression:** existing `meshing.test.ts` stays green (builder/toolchain mocked).
- **Browser:** snappy config form shows the per-surface angle/level table, values persist on
  save/reload, and a build with a per-patch override returns 200.

## Out of scope

Per-patch layers (next feature), the 3D-view fix, the live meshing log, and mesh/case rename
are separate specs. cfMesh per-patch feature edges (needs per-STL FMS merge) is explicitly
excluded.
