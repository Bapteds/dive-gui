# cfMesh Per-Patch Local Refinement + Tri-State Inflation Layers — Design Spec

**Date:** 2026-08-17
**Branch:** `feat/chamber-creation`
**Status:** approved (pending user review)
**Scope:** cfMesh (cartesianMesh) only. snappyHexMesh is untouched.

## Problem

Two issues with the cfMesh meshing config form (`CfMeshConfigForm`):

1. **Refinement is global only.** The user can set `boundaryCellSize` (one cell size at *all*
   walls) and `minCellSize` (a global floor), but there is no way to refine an *individual*
   patch. Turbine cases need a finer cell size on specific patches (e.g. a blade or a throat)
   without refining every wall.

2. **The per-patch inflation-layer semantics are wrong.** Today the per-patch tick means
   "custom override"; an **unticked** patch **inherits the global layer values** — so it still
   grows layers. There is no way to say "this patch gets *no* layers". The user wants a clear
   three-state model per patch:
   - **Unticked → no layers** on that patch.
   - **Ticked (default) → mirror the global block**, live: change the global layer numbers and
     every mirroring patch follows.
   - **Ticked + custom → independent values** that do not follow the global block.

## Decisions (from brainstorming)

1. **cfMesh only.** snappy's forms/dicts/schemas are not changed by this work.
2. **Per-patch local refinement is an absolute cell size (metres),** matching cfMesh's whole
   vocabulary (`maxCellSize`, `minCellSize`, `boundaryCellSize` are all metres). Rendered with
   cfMesh's native `localRefinement { "<patch>" { cellSize X; } }` block. Tick-to-enable, one
   row per discovered patch — the same override pattern as `patchTypes` / per-patch layers.
3. **Global `boundaryCellSize` stays** as the default cell size at un-refined walls; a per-patch
   local refinement overrides it for that patch. (Not removed.)
4. **Inflation layers become tri-state per patch:** off / mirror-global / custom (see the table
   below). Interaction = **tick + a "Customize" toggle** (the checkbox is on/off; when on, the
   values mirror the global block read-only; "Customize" unlocks them, "reset to global"
   relinks).
5. **Default tick state when global layers are enabled = all patches ticked/mirroring.** This
   matches today's behaviour (every un-overridden patch inherited the global block) and keeps
   old saved configs rendering identically. The user unticks inlets/outlets they do not want
   layered.
6. **Mirror the established override pattern** for the data model: keep the current global
   fields as defaults, add optional per-patch maps/lists keyed by patch name. A patch absent
   from every new field behaves exactly as today → old configs stay byte-identical.

## Architecture

One vertical slice through shared model → API schema → dict renderer → web form. No change to
the meshing service/controller/routes, storage, snappy, or the chamber model.

```
packages/shared/src/index.ts               CfMeshConfig: + localRefinement;
                                            CfMeshLayersConfig: + noLayerPatches;
                                            new interface CfMeshLocalRefinement
apps/web/src/lib/api/types.ts               re-export CfMeshLocalRefinement
apps/api/src/modules/meshing/
  meshing.schemas.ts                        Zod: localRefinement record; noLayerPatches array
apps/api/src/lib/cfMeshDicts.ts             render localRefinement block;
                                            render nLayers 0 for off patches in patchBoundaryLayers
apps/web/src/features/meshing/
  CfMeshConfigForm.tsx                       Local refinement fieldset;
                                            tri-state per-patch layers table
```

## Data model (`packages/shared/src/index.ts`)

### Local refinement (new)

```ts
/**
 * Per-patch local cell-size refinement (cfMesh), keyed by patch name. Rendered as a
 * meshDict `localRefinement { "<patch>" { cellSize X; } }` entry. Absent key => the
 * patch uses the global sizing (boundaryCellSize if set, else maxCellSize).
 */
export interface CfMeshLocalRefinement {
  /** Target cell size at this patch, in metres (> 0). */
  cellSize: number;
}
```

`CfMeshConfig` gains:

```ts
export interface CfMeshConfig {
  // …existing fields…
  /** Per-patch local refinement keyed by patch name; absent key => global sizing. NEW. */
  localRefinement?: Record<string, CfMeshLocalRefinement>;
}
```

### Layers off-list (new)

`CfMeshLayersConfig` gains one field; `perPatch` keeps its current meaning (custom override):

```ts
export interface CfMeshLayersConfig {
  enabled: boolean;
  nLayers: number;                        // global default
  thicknessRatio: number;                 // global default
  maxFirstLayerThickness: number | null;  // global default
  /** Per-patch CUSTOM overrides keyed by patch name (unchanged). */
  perPatch?: Record<string, CfMeshPatchLayerSpec>;
  /** Patches that grow NO layers (rendered nLayers 0). Absent => none off. NEW. */
  noLayerPatches?: string[];
}
```

**The three states, resolved from these two fields (per patch):**

| State | In `noLayerPatches`? | In `perPatch`? | meshDict output |
|-------|:--:|:--:|-----------------|
| **Off** (unticked) | yes | no | `patchBoundaryLayers { "p" { nLayers 0; } }` |
| **Mirror global** (ticked, not custom) | no | no | *nothing* — inherits the global block |
| **Custom** (ticked + Customize) | no | yes | explicit `patchBoundaryLayers` override |

`perPatch` wins if a name somehow appears in both (defensive; the UI never produces that).

`DEFAULT_CFMESH_CONFIG` is unchanged (no `localRefinement`, no `noLayerPatches`).

## Validation (`meshing.schemas.ts`)

Add to `runCfMeshSchema`:

```ts
/** A per-patch local cell-size refinement (cfMesh). */
const cfMeshLocalRefinementSchema = z.object({
  cellSize: z.number().positive(),
});

// top level, beside patchTypes:
localRefinement: z.record(z.string(), cfMeshLocalRefinementSchema).optional(),

// inside the addLayers object, beside perPatch:
noLayerPatches: z.array(z.string()).optional(),
```

Ranges reuse the existing conventions (`positive()` for a metre size, string arrays for
patch-name lists like `featureSurfaces` / snappy `surfaces`).

## Dict rendering (`cfMeshDicts.ts`, `renderMeshDict`)

### Local refinement block

When `config.localRefinement` has entries, emit a top-level `localRefinement` block (a sibling
of `maxCellSize` / `boundaryLayers` / `renameBoundary`):

```
localRefinement
{
    "<patch>"
    {
        cellSize <fmt(cellSize)>;
    }
    …
}
```

Only patches with an entry appear. No entries → no block (byte-identical to today).

### patchBoundaryLayers — off patches

The global `boundaryLayers { … }` block is unchanged. The `patchBoundaryLayers` sub-block is
emitted when **either** `perPatch` **or** `noLayerPatches` is non-empty. It contains:

- one custom block per `perPatch` entry (exactly as today — `nLayers` / `thicknessRatio` /
  optional `maxFirstLayerThickness` / `allowDiscontinuity 0;`), and
- one `{ nLayers 0; }` block per `noLayerPatches` entry (skipping any name also in `perPatch`):

```
patchBoundaryLayers
{
    "<customPatch>"  { nLayers M; thicknessRatio R; maxFirstLayerThickness T; allowDiscontinuity 0; }
    "<offPatch>"     { nLayers 0; }
}
```

`nLayers 0` is cfMesh's native way to exclude a patch from layer growth. Everything else in the
block is unchanged.

## UI (`CfMeshConfigForm.tsx`)

### Local refinement fieldset

A new fieldset **inside the Advanced disclosure**, directly under the min/boundary cell-size
grid (keeping all sizing knobs together), rendered only when `patches.length > 0`:

- One row per discovered patch: a **checkbox** + patch name, and a **cell size (m)** input
  disabled until the box is ticked.
- Ticked → the size input is enabled; seeded from `boundaryCellSize` (else blank).
- Helper text: overrides the global boundary cell size for that patch.

**State:** `patchRefineOn: Record<string, boolean>` (default false) and
`patchRefine: Record<string, string>` (the cell-size string). Kept in sync with `patchKey` by
the same add/drop effect the form already uses for `patchTypes` / `patchLayers`.

**Config assembly:** `localRefinement` gets an entry only for patches that are ticked **and**
have a positive parsed cell size; `undefined` when empty (so the field is omitted).

**Seeding on mount:** `patchRefineOn[p] = !!init.localRefinement?.[p]`;
`patchRefine[p] = String(init.localRefinement?.[p]?.cellSize ?? '')`.

### Tri-state per-patch layers table

Replace the current boolean `patchLayerOn` model with two flags per patch:

- `patchLayerEnabled: Record<string, boolean>` — the on/off checkbox. **Default true** (mirror).
- `patchLayerCustom: Record<string, boolean>` — the "Customize" toggle (only meaningful when
  enabled). Default false.
- `patchLayers: Record<string, PatchLayerInput>` — the custom values (unchanged shape).

Each row:

- **Checkbox** (patchLayerEnabled) + patch name.
- When **unticked**: no inputs (row reads as "no layers").
- When **ticked, not custom**: the three inputs are shown **disabled**, populated from the
  **current global** `nLayers` / `thicknessRatio` / `maxFirstLayer` state (so they update live
  as the global block changes), plus a small **"Customize"** button.
- When **ticked + custom**: the three inputs are **editable** (from `patchLayers`), plus a
  **"reset to global"** link that clears custom (sets `patchLayerCustom[p] = false`).

**Seeding on mount** from the saved config:

- `patchLayerEnabled[p] = !(init.addLayers.noLayerPatches ?? []).includes(p)`  → default true.
- `patchLayerCustom[p] = !!init.addLayers.perPatch?.[p]`.
- `patchLayers[p]` from `perPatch[p]` if present, else the globals (for display).

**Sync effect** (patchKey change): a new patch defaults to enabled=true, custom=false; drop
removed patches; keep existing choices — mirroring the existing effects.

**Config assembly** (inside the `config` memo):

- `noLayerPatches` = patches where `!patchLayerEnabled[p]` (undefined if none).
- `perPatch` = patches where `patchLayerEnabled[p] && patchLayerCustom[p]`, built from
  `patchLayers[p]` (same clamping as today; undefined if none).
- Mirror patches (enabled && !custom) appear in neither.

The global layer inputs (count / thickness ratio / max first) and the `layersOn` master
checkbox are unchanged. The per-patch table only appears when `layersOn` and `patches.length`.

Autosave and the `needsCellSize` guard are unchanged; the new fields flow through the existing
serialized-config autosave.

## Backward compatibility

- A saved cfMesh config without `localRefinement` / `noLayerPatches`:
  - No `localRefinement` block is rendered.
  - `perPatch` still renders custom blocks exactly as today; no `nLayers 0` blocks appear.
  - The dict is **byte-identical** to today.
- On load, an old config's `perPatch` patches seed as **custom** (ticked + Customize); every
  other patch seeds as **mirror** (ticked) — which is what "inherit global" already produced.
  No patch seeds as off, so behaviour is preserved until the user unticks one.

## Testing

- **cfMeshDicts unit tests:**
  - `localRefinement` with one patch renders a `localRefinement { "p" { cellSize X; } }` block;
    empty/absent renders no block.
  - `noLayerPatches` renders a `patchBoundaryLayers` block with `nLayers 0` for that patch;
    combined with a `perPatch` entry, both blocks appear and a name in both yields only the
    custom block.
  - No `perPatch` and no `noLayerPatches` → no `patchBoundaryLayers` block (byte-identical
    to today).
- **schema tests:** `localRefinement` validates a positive `cellSize` and rejects ≤ 0;
  `noLayerPatches` accepts a string array; both absent → undefined.
- **No-regression:** existing `meshing.test.ts` / `snappyPipeline.test.ts` stay green
  (toolchain mocked); snappy dicts unchanged.
- **Browser (cfMesh session):** the Local refinement rows tick/untick and persist a per-patch
  size on save/reload; a layer patch cycles off → mirror → custom, mirror rows track a global
  edit live, custom rows keep their own values, and a run with the new fields returns 200.

## Out of scope

- snappyHexMesh (any form/dict/schema).
- Per-patch `refinementThickness` or level-based refinement (`additionalRefinementLevels`) —
  cell size only, per the brainstorming decision.
- Removing or changing the global `boundaryCellSize` / `minCellSize`.
- The 3D result viewer, run log, and session/case rename (separate specs).
