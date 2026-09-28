# Per-Patch Boundary Layers — Design Spec

**Date:** 2026-08-11
**Branch:** `feat/chamber-creation`
**Status:** approved (pending user review)

## Problem

Boundary-layer (prism) growth in the meshing tab uses **global** parameters:

- **snappy** (`AddLayersConfig`) already has a per-surface **on/off** list (`surfaces?: string[]`),
  but the **number of layers**, **expansion ratio**, and **final layer thickness** are single
  global values applied to every chosen surface (rendered in `snappyHexMeshDict`:
  `layers { region { nSurfaceLayers N; } }` with one global `N`, plus global `expansionRatio` /
  `finalLayerThickness` / `minThickness` in `addLayersControls`).
- **cfMesh** (`CfMeshLayersConfig`) is fully global — `nLayers` / `thicknessRatio` /
  `maxFirstLayerThickness` applied to **all** boundaries via a single `boundaryLayers` block
  (the code comment says "per-patch layers are a later refinement").

The user wants boundary layers settable **per patch / per STL** — the number of layers, the
growth, and the thickness — for **both** engines.

## Decisions (from brainstorming)

1. **All layer params per-patch, both engines.** Per-patch: layer **count**, **growth**
   (snappy `expansionRatio` / cfMesh `thicknessRatio`), and **thickness** (snappy
   `finalLayerThickness` / cfMesh `maxFirstLayerThickness`), plus on/off.
2. **`relativeSizes` stays global (snappy).** It is a single switch in snappy's
   `addLayersControls` — OpenFOAM does not support it per-region. So whether snappy layer
   thickness is relative (fraction of cell) or absolute (metres) remains one session-wide
   choice. cfMesh has no such switch.
3. **Mirror the established override pattern:** keep the current global fields as the
   **defaults**, add an optional per-patch override map keyed by patch / STL file name (like
   `surfaceRefinements`, `featureRefinements`, and cfMesh's existing `patchTypes`). A patch
   absent from the map uses the globals → every saved config stays byte-identical to today.

## Architecture

Two vertical slices (snappy + cfMesh) through shared model → API schema → dict renderer →
web form:

```
packages/shared/src/index.ts              AddLayersConfig: + perSurface; CfMeshLayersConfig: + perPatch
apps/api/src/modules/meshing/
  meshing.schemas.ts                        Zod: snappy perSurface, cfMesh perPatch
apps/api/src/lib/snappyDicts.ts             per-region nSurfaceLayers + expansionRatio + finalLayerThickness
apps/api/src/lib/cfMeshDicts.ts             patchBoundaryLayers block for overridden patches
apps/web/src/features/meshing/
  SnappyConfigForm.tsx                       per-surface layers table (on/off + count + growth + thickness)
  CfMeshConfigForm.tsx                       per-patch layers table (count + ratio + max first thickness)
```

No change to the meshing service/controller/routes, storage, or the chamber/shared model
beyond the two layer interfaces.

## Data model

### snappy (`AddLayersConfig`)

```ts
/** Per-surface boundary-layer override (snappy), keyed by STL file name. */
export interface SurfaceLayerSpec {
  /** Number of prism layers on this surface (>= 1). */
  nLayers: number;
  /** Growth ratio between successive layers (>= 1). */
  expansionRatio: number;
  /** Thickness of the layer nearest the surface (relative or absolute per the GLOBAL relativeSizes). */
  finalLayerThickness: number;
}

export interface AddLayersConfig {
  enabled: boolean;
  /** Surfaces (STL file names) that grow layers; omitted/empty => every surface. Unchanged. */
  surfaces?: string[];
  /** Global default layer count (used where no per-surface override). */
  nLayers: number;
  /** GLOBAL: relative vs absolute thickness. OpenFOAM addLayersControls switch — cannot be per-region. */
  relativeSizes: boolean;
  /** Global default near-wall layer thickness. */
  finalLayerThickness: number;
  /** Global default growth ratio. */
  expansionRatio: number;
  /** Per-surface overrides keyed by STL file name; absent key => the globals above. NEW. */
  perSurface?: Record<string, SurfaceLayerSpec>;
}
```

`DEFAULT_ADD_LAYERS` / `DEFAULT_SNAPPY_CONFIG.addLayers` unchanged (no `perSurface` key).

### cfMesh (`CfMeshLayersConfig`)

```ts
/** Per-patch boundary-layer override (cfMesh), keyed by patch name (STL solid / FMS patch). */
export interface CfMeshPatchLayerSpec {
  nLayers: number;
  /** Growth ratio (cfMesh thicknessRatio, >= 1). */
  thicknessRatio: number;
  /** Cap on the first (near-wall) layer thickness in metres; null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
}

export interface CfMeshLayersConfig {
  enabled: boolean;
  nLayers: number;                 // global default
  thicknessRatio: number;          // global default
  maxFirstLayerThickness: number | null;  // global default
  /** Per-patch overrides keyed by patch name; absent key => the globals above. NEW. */
  perPatch?: Record<string, CfMeshPatchLayerSpec>;
}
```

`DEFAULT_CFMESH_CONFIG.addLayers` unchanged (no `perPatch` key).

## Validation (`meshing.schemas.ts`)

- snappy: add a `surfaceLayerSpecSchema = z.object({ nLayers: int 1–20, expansionRatio: 1–5,
  finalLayerThickness: positive })`; add `perSurface: z.record(z.string(), surfaceLayerSpecSchema).optional()`
  inside the existing `addLayers` object.
- cfMesh: add `cfmeshPatchLayerSpecSchema = z.object({ nLayers: int 1–20, thicknessRatio: 1–5,
  maxFirstLayerThickness: positive nullable })`; add `perPatch: z.record(...).optional()` inside
  the cfMesh `addLayers` object.

Ranges match the existing global fields so per-patch values can't exceed what the globals allow.

## Dict rendering

### snappy (`snappyDicts.ts`)

The per-region `layers { … }` block currently emits only `nSurfaceLayers` from the global.
Change it to emit the full per-region spec, falling back to the globals:

```
${region}
{
    nSurfaceLayers      <perSurface[file]?.nLayers ?? nLayers>;
    expansionRatio      <perSurface[file]?.expansionRatio ?? expansionRatio>;
    finalLayerThickness <perSurface[file]?.finalLayerThickness ?? finalLayerThickness>;
}
```

`relativeSizes` and the top-level `expansionRatio` / `finalLayerThickness` / `minThickness`
stay in `addLayersControls` as the global fallback (OpenFOAM applies the per-region values as
overrides). `minThickness` continues to derive from the global `finalLayerThickness`
(`minLayerThickness`) — unchanged. The `surfaces[]` on/off gate is unchanged (a surface not in
the chosen set gets no layer entry).

### cfMesh (`cfMeshDicts.ts`)

Keep the global `boundaryLayers { nLayers; thicknessRatio; maxFirstLayerThickness; }` block as
today (the default for un-overridden patches). When `perPatch` has entries, append a
`patchBoundaryLayers` sub-block inside `boundaryLayers`:

```
boundaryLayers
{
    nLayers <global>;
    thicknessRatio <global>;
    maxFirstLayerThickness <global?>;   // if set
    patchBoundaryLayers
    {
        "<patch>"
        {
            nLayers <spec.nLayers>;
            thicknessRatio <spec.thicknessRatio>;
            maxFirstLayerThickness <spec.maxFirstLayerThickness>;  // if set
            allowDiscontinuity 0;
        }
        …
    }
    allowDiscontinuity 0;
    optimiseLayer 1;
}
```

This is cfMesh's native per-patch layer mechanism, keyed by patch name exactly like the
existing `renameBoundary`/`patchTypes` block.

## UI

### snappy (`SnappyConfigForm.tsx`)

The existing "Grow layers on" per-surface checkbox list becomes a **per-surface table**: each
STL row has the on/off checkbox plus three inputs — layers count, expansion ratio, final
thickness — prefilled from the globals. The existing global inputs (count / expansion / final
thickness / relativeSizes) stay above the table as the **defaults** applied to any surface the
user does not override. On submit, every current STL is written into `perSurface` (mirroring
`surfaceRefinements`); the on/off checkbox still drives `surfaces[]`.

### cfMesh (`CfMeshConfigForm.tsx`)

Add a **per-patch layers table** under the existing global layer fields: one row per known
patch (same patch-name source as the per-patch types table already in this form) with count /
thickness ratio / max first-layer thickness inputs, prefilled from the globals and written to
`perPatch` on submit.

## Backward compatibility

- A saved config without `perSurface` / `perPatch` → undefined → every patch uses the globals.
  Rendered dicts are byte-identical to today (snappy's per-region block gains `expansionRatio`
  / `finalLayerThickness` lines that equal the global values, which OpenFOAM treats as a no-op
  override; cfMesh gains no `patchBoundaryLayers` block at all).
- `relativeSizes` semantics unchanged.

## Testing

- **snappyDicts unit tests:** a `perSurface` override for one STL renders that region's
  `nSurfaceLayers` / `expansionRatio` / `finalLayerThickness` from the override and the others
  from the globals; no `perSurface` renders every region at the globals.
- **cfMeshDicts unit tests:** a `perPatch` override emits a `patchBoundaryLayers` block with
  the patch's values; no `perPatch` emits no such block (byte-identical to today).
- **schema tests:** `perSurface` / `perPatch` validate their ranges; out-of-range rejected;
  absent → undefined.
- **No-regression:** existing `meshing.test.ts` stays green (toolchain mocked).
- **Browser:** snappy per-surface table + cfMesh per-patch table render, values persist on
  save/reload, and a run with per-patch overrides returns 200.

## Out of scope

The 3D-view fix, live meshing log, and mesh/case rename are separate specs. Per-patch
`relativeSizes` is excluded (OpenFOAM constraint). No new global layer params.
