# cfMesh Per-Patch Local Refinement + Tri-State Inflation Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the cfMesh meshing form, add **per-patch local cell-size refinement** (tick-to-enable, one row per patch) and rework **per-patch inflation layers** into a three-state model — off (no layers) / mirror-global (follows the global block live) / custom (independent values).

**Architecture:** One vertical slice through `@dive/shared` (types) → `@dive/api` Zod schema → the pure `cfMeshDicts` renderer → the `CfMeshConfigForm` React form. Mirrors the established per-patch override pattern (`patchTypes`, `perPatch`): keep the global fields as defaults, add optional per-patch maps/lists keyed by patch name. A patch absent from every new field renders exactly as today, so old saved configs are byte-identical.

**Tech Stack:** TypeScript monorepo — `@dive/shared` (types + Zod-free constants), `@dive/api` (Zod schemas + pure dict renderers, Vitest), `@dive/web` (React + Vite + Tailwind). The OpenFOAM/cfMesh toolchain is never invoked here — the renderer is pure and unit-tested; the form is verified by typecheck/build + a manual browser pass.

**Scope:** cfMesh only. snappyHexMesh (its form, dict renderer, schema) is untouched.

## Global Constraints

- **Byte-identical when no new field is set.** The renderer emits a `localRefinement` block **only** when `config.localRefinement` has entries, and emits `nLayers 0` blocks **only** for `noLayerPatches`. An old config (neither field present) renders exactly as today. Existing `cfMeshDicts.test.ts` cases must stay green unchanged.
- **Keying by patch name** (like the existing `patchTypes` / `perPatch`), sourced from the same `patches: MeshingPatch[]` prop the form already uses.
- **Three layer states resolved from two fields:** `noLayerPatches` (off) and `perPatch` (custom); a patch in neither = mirror-global. `perPatch` wins if a name is ever in both (defensive — the UI never produces that).
- **Global `boundaryCellSize` stays** as the default wall size; per-patch `localRefinement` overrides it for that patch. Nothing about the global sizing fields changes.
- **Refinement is an absolute cell size in metres** (`cellSize`), no levels / no `refinementThickness`.
- **Default tick state when layers are enabled = all patches ticked/mirroring** (untouched patches carry no `noLayerPatches`/`perPatch` entry).
- After editing `@dive/shared`, rebuild it before running api/web typechecks/tests: `npm run build:shared`.
- Spec: `docs/superpowers/specs/2026-08-17-cfmesh-per-patch-refinement-and-layers-design.md`.
- Per repo convention (CLAUDE.md), append a French implementation note to the bottom of `PLAN.md` at the end of the work.

---

### Task 1: Shared model — `CfMeshLocalRefinement`, `localRefinement`, `noLayerPatches`

**Files:**
- Modify: `packages/shared/src/index.ts` (`CfMeshLayersConfig` ~:1000-1010; new `CfMeshLocalRefinement` interface; `CfMeshConfig` ~:1035-1058)
- Modify: `apps/web/src/lib/api/types.ts:810-832` (re-export `CfMeshLocalRefinement`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CfMeshLocalRefinement { cellSize: number }`
  - `CfMeshConfig.localRefinement?: Record<string, CfMeshLocalRefinement>`
  - `CfMeshLayersConfig.noLayerPatches?: string[]`
  - `DEFAULT_CFMESH_CONFIG` unchanged (neither key present).

- [ ] **Step 1: Add `noLayerPatches` to `CfMeshLayersConfig`**

In `packages/shared/src/index.ts`, inside `interface CfMeshLayersConfig`, add the field after `perPatch`:

```ts
  /** Per-patch overrides keyed by patch name; absent key => the globals above. */
  perPatch?: Record<string, CfMeshPatchLayerSpec>;
  /**
   * Patches that grow NO boundary layers, keyed by patch name. Rendered as a
   * `patchBoundaryLayers { "<patch>" { nLayers 0; } }` entry. Absent or empty =>
   * no patch is force-disabled (every patch inherits the global block unless it
   * has a `perPatch` custom override). A name in both `perPatch` and here is
   * treated as custom (perPatch wins).
   */
  noLayerPatches?: string[];
```

- [ ] **Step 2: Add the `CfMeshLocalRefinement` interface**

In `packages/shared/src/index.ts`, directly ABOVE `export interface CfMeshConfig {`, add:

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

- [ ] **Step 3: Add `localRefinement` to `CfMeshConfig`**

In `interface CfMeshConfig`, add the field after `patchTypes`:

```ts
  patchTypes?: Record<string, CfMeshPatchType>;
  /**
   * Per-patch local cell-size refinement keyed by patch name; absent key => the
   * patch uses the global sizing. Rendered as a meshDict `localRefinement` block.
   */
  localRefinement?: Record<string, CfMeshLocalRefinement>;
```

Leave `DEFAULT_CFMESH_CONFIG` exactly as-is (no new keys).

- [ ] **Step 4: Re-export the new type for the web contract**

In `apps/web/src/lib/api/types.ts`, add `CfMeshLocalRefinement` to the `export type { … } from '@dive/shared'` block that already lists `CfMeshLayersConfig`, `CfMeshPatchLayerSpec`:

```ts
  CfMeshConfig,
  CfMeshLayersConfig,
  CfMeshPatchLayerSpec,
  CfMeshLocalRefinement,
  CfMeshPatchType,
```

- [ ] **Step 5: Build shared + typecheck**

Run: `npm run build:shared && npm run typecheck -w @dive/api && npm run typecheck -w @dive/web`
Expected: PASS (no type errors; the new optional fields are additive).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts apps/web/src/lib/api/types.ts
git commit -m "feat(meshing): shared model for cfMesh local refinement + layer off-list"
```

---

### Task 2: API Zod schema + schema tests

**Files:**
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts` (add `cfMeshLocalRefinementSchema` near :94-99; `localRefinement` + `noLayerPatches` in `runCfMeshSchema` :150-171)
- Test: `apps/api/tests/meshing.test.ts` (new describe block after the existing `per-patch boundary layers — schema` block, ~:682)

**Interfaces:**
- Consumes: `runCfMeshSchema` from Task 1's shapes.
- Produces: `runCfMeshSchema` now parses `localRefinement?: Record<string, { cellSize: number }>` (positive `cellSize`) and `addLayers.noLayerPatches?: string[]`.

- [ ] **Step 1: Write the failing schema tests**

In `apps/api/tests/meshing.test.ts`, append a new describe block (the file already imports `runCfMeshSchema`):

```ts
describe('cfMesh — local refinement + layer off-list (schema)', () => {
  const cfBase = { engine: 'cfmesh' };

  it('accepts a per-patch local refinement cell size', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      localRefinement: { blade: { cellSize: 0.002 } },
    });
    expect(parsed.localRefinement?.blade).toEqual({ cellSize: 0.002 });
  });

  it('rejects a non-positive local refinement cell size', () => {
    expect(() =>
      runCfMeshSchema.parse({ ...cfBase, localRefinement: { blade: { cellSize: 0 } } }),
    ).toThrow();
  });

  it('accepts a noLayerPatches list on addLayers', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      addLayers: {
        enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
        noLayerPatches: ['inlet', 'outlet'],
      },
    });
    expect(parsed.addLayers.noLayerPatches).toEqual(['inlet', 'outlet']);
  });

  it('leaves the new fields undefined when omitted', () => {
    const c = runCfMeshSchema.parse({ ...cfBase });
    expect(c.localRefinement).toBeUndefined();
    expect(c.addLayers.noLayerPatches).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:shared && npx vitest run tests/meshing.test.ts -t "local refinement + layer off-list" --dir apps/api` (or from `apps/api`: `npx vitest run tests/meshing.test.ts -t "local refinement + layer off-list"`)
Expected: FAIL — the accept cases keep the fields `undefined`/strip them (Zod drops unknown keys), so the `toEqual`/`toBeUndefined` assertions fail.

- [ ] **Step 3: Add the local-refinement item schema**

In `apps/api/src/modules/meshing/meshing.schemas.ts`, after `cfMeshPatchLayerSpecSchema` (~:99), add:

```ts
/** A per-patch local cell-size refinement (cfMesh). */
const cfMeshLocalRefinementSchema = z.object({
  cellSize: z.number().positive(),
});
```

- [ ] **Step 4: Wire the two new fields into `runCfMeshSchema`**

Add `localRefinement` at the top level (after `patchTypes`, ~:159):

```ts
  patchTypes: z.record(z.string(), z.enum(CFMESH_PATCH_TYPES)).optional(),
  // Per-patch local cell-size refinement (patch name -> cellSize in metres); a patch
  // absent uses the global sizing. Written to meshDict as a localRefinement block.
  localRefinement: z.record(z.string(), cfMeshLocalRefinementSchema).optional(),
```

Add `noLayerPatches` inside the `addLayers` object (after `perPatch`, ~:167):

```ts
      // Per-patch layer overrides keyed by patch name; absent key => the globals.
      perPatch: z.record(z.string(), cfMeshPatchLayerSpecSchema).optional(),
      // Patches that grow NO layers (rendered nLayers 0); absent/empty => none off.
      noLayerPatches: z.array(z.string()).optional(),
```

- [ ] **Step 5: Run the schema tests to verify they pass**

Run (from `apps/api`): `npx vitest run tests/meshing.test.ts -t "local refinement + layer off-list"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/meshing/meshing.schemas.ts apps/api/tests/meshing.test.ts
git commit -m "feat(meshing): validate cfMesh localRefinement + noLayerPatches"
```

---

### Task 3: Dict renderer — `localRefinement` block + `nLayers 0` off patches

**Files:**
- Modify: `apps/api/src/lib/cfMeshDicts.ts` (`renderMeshDict` — the `patchBoundaryLayers` loop ~:97-113; new `localRefinement` block near :83)
- Test: `apps/api/tests/cfMeshDicts.test.ts` (append cases to the existing `renderMeshDict` describe)

**Interfaces:**
- Consumes: `CfMeshConfig.localRefinement`, `CfMeshLayersConfig.noLayerPatches` (Task 1).
- Produces: `renderMeshDict` emits `localRefinement { "<patch>" { cellSize X; } }` for each entry, and `patchBoundaryLayers { "<patch>" { nLayers 0; } }` for each `noLayerPatches` name not already a custom `perPatch`.

- [ ] **Step 1: Write the failing renderer tests**

In `apps/api/tests/cfMeshDicts.test.ts`, add inside the `describe('renderMeshDict', …)` block:

```ts
  it('emits a localRefinement block for per-patch cell sizes only', () => {
    const dict = renderMeshDict(
      config({ localRefinement: { blade: { cellSize: 0.002 } } }),
      'constant/triSurface/combined.fms',
      0.4,
    );
    expect(dict).toContain('localRefinement');
    expect(dict).toContain('"blade"');
    expect(dict).toContain('cellSize 0.002;');
  });

  it('omits localRefinement when there are no per-patch sizes', () => {
    const dict = renderMeshDict(config({}), 'x.fms', 0.4);
    expect(dict).not.toContain('localRefinement');
  });

  it('emits nLayers 0 for a noLayerPatches entry', () => {
    const dict = renderMeshDict(
      config({
        addLayers: {
          enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
          noLayerPatches: ['inlet'],
        },
      }),
      'x.fms',
      0.4,
    );
    expect(dict).toContain('patchBoundaryLayers');
    expect(dict).toContain('"inlet"');
    expect(dict).toContain('nLayers 0;');
  });

  it('lets a custom perPatch override win over noLayerPatches for the same patch', () => {
    const dict = renderMeshDict(
      config({
        addLayers: {
          enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
          perPatch: { walls: { nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: null } },
          noLayerPatches: ['walls'],
        },
      }),
      'x.fms',
      0.4,
    );
    // 'walls' renders as the custom block (nLayers 5), NOT nLayers 0.
    expect(dict).toContain('nLayers 5;');
    expect(dict).not.toContain('nLayers 0;');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/api`): `npx vitest run tests/cfMeshDicts.test.ts`
Expected: FAIL — no `localRefinement` block, no `nLayers 0` emitted.

- [ ] **Step 3: Render the off patches inside `patchBoundaryLayers`**

In `apps/api/src/lib/cfMeshDicts.ts`, replace the per-patch block (the section starting `const perPatch = Object.entries(config.addLayers.perPatch ?? {});` through its closing `}` at ~:97-113) with:

```ts
    // Per-patch overrides: cfMesh's native patchBoundaryLayers sub-block, keyed by
    // patch name. Custom entries carry values; noLayerPatches force nLayers 0 (a
    // patch present in both is treated as custom — perPatch wins).
    const perPatch = Object.entries(config.addLayers.perPatch ?? {});
    const customNames = new Set(perPatch.map(([name]) => name));
    const offPatches = (config.addLayers.noLayerPatches ?? []).filter(
      (name) => !customNames.has(name),
    );
    if (perPatch.length > 0 || offPatches.length > 0) {
      layer.push('    patchBoundaryLayers', '    {');
      for (const [name, spec] of perPatch) {
        layer.push(
          `        "${name}"`,
          '        {',
          `            nLayers ${Math.max(1, Math.round(spec.nLayers))};`,
          `            thicknessRatio ${fmt(Math.max(1, spec.thicknessRatio))};`,
        );
        if (spec.maxFirstLayerThickness && spec.maxFirstLayerThickness > 0) {
          layer.push(`            maxFirstLayerThickness ${fmt(spec.maxFirstLayerThickness)};`);
        }
        layer.push('            allowDiscontinuity 0;', '        }');
      }
      for (const name of offPatches) {
        layer.push(`        "${name}"`, '        {', '            nLayers 0;', '        }');
      }
      layer.push('    }');
    }
```

- [ ] **Step 4: Render the top-level `localRefinement` block**

Still in `renderMeshDict`, after the `boundaryCellSize` block and BEFORE `if (config.addLayers.enabled) {` (~:84), insert:

```ts
  // Per-patch local refinement: cfMesh's localRefinement block, one entry per patch
  // the user gave a target cell size. Only emitted when at least one is set.
  const localRefine = Object.entries(config.localRefinement ?? {});
  if (localRefine.length > 0) {
    const block: string[] = ['localRefinement', '{'];
    for (const [name, spec] of localRefine) {
      block.push(`    "${name}"`, '    {', `        cellSize ${fmt(spec.cellSize)};`, '    }');
    }
    block.push('}');
    lines.push('', ...block);
  }
```

- [ ] **Step 5: Run the renderer tests + the full pure-dict suites**

Run (from `apps/api`): `npx vitest run tests/cfMeshDicts.test.ts tests/snappyDicts.test.ts`
Expected: PASS — the 4 new cases pass AND every pre-existing `cfMeshDicts` case (including "omits patchBoundaryLayers when there are no per-patch overrides") stays green, proving byte-identical output for un-overridden configs.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/cfMeshDicts.ts apps/api/tests/cfMeshDicts.test.ts
git commit -m "feat(meshing): render cfMesh localRefinement + nLayers-0 off patches"
```

---

### Task 4: Web form — per-patch Local refinement fieldset

**Files:**
- Modify: `apps/web/src/features/meshing/CfMeshConfigForm.tsx` (imports; new state + seeding + sync + config assembly; new fieldset in Advanced)

**Interfaces:**
- Consumes: `CfMeshLocalRefinement` type (Task 1); `patches: MeshingPatch[]`, `parseSize`, `boundaryCellSize` (existing in the form).
- Produces: `config.localRefinement` populated from ticked patches with a positive cell size (`undefined` when none).

- [ ] **Step 1: Import the new type**

In `CfMeshConfigForm.tsx`, add `CfMeshLocalRefinement` to the type import from `@/lib/api/types`:

```ts
import type { CfMeshConfig, CfMeshLocalRefinement, CfMeshPatchLayerSpec, CfMeshPatchType, MeshBounds, MeshingPatch, StlFile } from '@/lib/api/types';
```

- [ ] **Step 2: Add local-refinement state + seeding**

After the `patchTypes` state (`const [patchTypes, setPatchTypes] = …`), add:

```ts
  // Per-patch local refinement (cell size in metres). Tick a patch to override the
  // global boundary cell size for it; seeded on iff the saved config had an entry.
  const [patchRefineOn, setPatchRefineOn] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of patches) map[p.name] = !!init.localRefinement?.[p.name];
    return map;
  });
  const [patchRefine, setPatchRefine] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const p of patches) {
      const cell = init.localRefinement?.[p.name]?.cellSize;
      map[p.name] = cell ? String(cell) : '';
    }
    return map;
  });
```

- [ ] **Step 3: Keep the maps in sync with the discovered patches**

Inside the existing `useEffect(() => { … }, [patchKey])` (the one syncing `patchTypes`/`patchLayers`), add two more setters (a new patch defaults to off / empty):

```ts
    setPatchRefineOn((prev) => {
      const next: Record<string, boolean> = {};
      for (const p of patches) next[p.name] = prev[p.name] ?? false;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
    setPatchRefine((prev) => {
      const next: Record<string, string> = {};
      for (const p of patches) next[p.name] = prev[p.name] ?? '';
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 4: Assemble `localRefinement` in the `config` memo**

Inside the `config = useMemo<CfMeshConfig>(…)` body, before the `return {`, add:

```ts
    // Per-patch local refinement: ticked patches with a positive cell size only.
    const localRefinement: Record<string, CfMeshLocalRefinement> = {};
    for (const p of patches) {
      if (!patchRefineOn[p.name]) continue;
      const size = parseSize(patchRefine[p.name]);
      if (size == null) continue;
      localRefinement[p.name] = { cellSize: size };
    }
```

Add the field to the returned object (after `patchTypes: …`):

```ts
      patchTypes: Object.keys(chosenPatchTypes).length > 0 ? chosenPatchTypes : undefined,
      localRefinement: Object.keys(localRefinement).length > 0 ? localRefinement : undefined,
```

Add `patchRefineOn, patchRefine` to the memo's dependency array.

- [ ] **Step 5: Render the fieldset (inside Advanced, under the cell-size grid)**

In the Advanced disclosure, immediately AFTER the `<div className="grid gap-4 sm:grid-cols-2">…</div>` holding Min/Boundary cell size (before the CPU threads `Field`), insert:

```tsx
            {patches.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium text-text">Local refinement (per patch)</legend>
                <p className="text-xs text-text-secondary">
                  Tick a patch to set its own cell size (m); it overrides the global boundary
                  cell size for that patch only. Unticked patches use the global sizing.
                </p>
                <div className="flex flex-col gap-2">
                  {patches.map((patch) => {
                    const on = patchRefineOn[patch.name] ?? false;
                    const size = patchRefine[patch.name] ?? '';
                    return (
                      <div key={patch.name} className="flex flex-wrap items-center gap-2">
                        <label
                          className="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm text-text"
                          title={patch.name}
                          translate="no"
                        >
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                            checked={on}
                            onChange={(e) => setPatchRefineOn((prev) => ({ ...prev, [patch.name]: e.target.checked }))}
                          />
                          <span className="min-w-0 truncate">{patch.name}</span>
                        </label>
                        <Input
                          type="number" min="0" step="any" className="w-28"
                          placeholder="cell size (m)"
                          disabled={!on}
                          aria-label={`${patch.name} local cell size in metres`}
                          value={size}
                          onChange={(e) => setPatchRefine((prev) => ({ ...prev, [patch.name]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            )}
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run build:shared && npm run typecheck -w @dive/web && npm run build -w @dive/web`
Expected: PASS (no type/build errors).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/meshing/CfMeshConfigForm.tsx
git commit -m "feat(meshing): cfMesh per-patch local refinement UI"
```

---

### Task 5: Web form — tri-state per-patch inflation layers

**Files:**
- Modify: `apps/web/src/features/meshing/CfMeshConfigForm.tsx` (replace `patchLayerOn` state with `patchLayerEnabled` + `patchLayerCustom`; update seeding, sync, config assembly, and the per-patch layers table JSX)

**Interfaces:**
- Consumes: `patchLayers`, global `nLayers` / `thicknessRatio` / `maxFirstLayer` state, `patches` (existing); `noLayerPatches` (Task 1).
- Produces: `config.addLayers.noLayerPatches` (off patches) + `config.addLayers.perPatch` (custom patches). Mirror patches appear in neither.

- [ ] **Step 1: Replace the `patchLayerOn` state with two flags**

In `CfMeshConfigForm.tsx`, replace the `patchLayerOn` state block:

```ts
  // Which patches use a CUSTOM per-patch layer override (vs inherit the global block).
  // Seeds on iff the saved config carried a perPatch entry for the patch.
  const [patchLayerOn, setPatchLayerOn] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of patches) map[p.name] = !!init.addLayers.perPatch?.[p.name];
    return map;
  });
```

with:

```ts
  // Per-patch layer state is tri-state: enabled (checkbox) × custom (Customize toggle).
  //  - enabled=false            → no layers on this patch (goes to noLayerPatches).
  //  - enabled=true, custom=false → mirror the global block (rendered as nothing).
  //  - enabled=true, custom=true  → independent values (goes to perPatch).
  // Default enabled=true (mirror), so an old config's un-overridden patches keep layers.
  const [patchLayerEnabled, setPatchLayerEnabled] = useState<Record<string, boolean>>(() => {
    const off = new Set(init.addLayers.noLayerPatches ?? []);
    const map: Record<string, boolean> = {};
    for (const p of patches) map[p.name] = !off.has(p.name);
    return map;
  });
  const [patchLayerCustom, setPatchLayerCustom] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of patches) map[p.name] = !!init.addLayers.perPatch?.[p.name];
    return map;
  });
```

- [ ] **Step 2: Update the patchKey sync effect**

In the `[patchKey]` effect, replace the `setPatchLayerOn((prev) => {…})` block with two blocks (new patch → enabled, not custom):

```ts
    setPatchLayerEnabled((prev) => {
      const next: Record<string, boolean> = {};
      for (const p of patches) next[p.name] = prev[p.name] ?? true;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
    setPatchLayerCustom((prev) => {
      const next: Record<string, boolean> = {};
      for (const p of patches) next[p.name] = prev[p.name] ?? false;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 3: Rewrite the layer assembly in the `config` memo**

Replace the current perPatch-building loop:

```ts
    const perPatch: Record<string, CfMeshPatchLayerSpec> = {};
    for (const p of patches) {
      if (!patchLayerOn[p.name]) continue;
      const s = patchLayers[p.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
      perPatch[p.name] = {
        nLayers: Math.max(1, Math.round(Number(s.n) || DEFAULT_CFMESH_CONFIG.addLayers.nLayers)),
        thicknessRatio: Math.max(1, Number(s.ratio) || DEFAULT_CFMESH_CONFIG.addLayers.thicknessRatio),
        maxFirstLayerThickness: parseSize(s.maxFirst),
      };
    }
```

with (off patches → `noLayerPatches`; custom patches → `perPatch`; mirror → neither):

```ts
    const perPatch: Record<string, CfMeshPatchLayerSpec> = {};
    const noLayerPatches: string[] = [];
    for (const p of patches) {
      if (!patchLayerEnabled[p.name]) {
        noLayerPatches.push(p.name);
        continue;
      }
      if (!patchLayerCustom[p.name]) continue; // mirror the global block
      const s = patchLayers[p.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
      perPatch[p.name] = {
        nLayers: Math.max(1, Math.round(Number(s.n) || DEFAULT_CFMESH_CONFIG.addLayers.nLayers)),
        thicknessRatio: Math.max(1, Number(s.ratio) || DEFAULT_CFMESH_CONFIG.addLayers.thicknessRatio),
        maxFirstLayerThickness: parseSize(s.maxFirst),
      };
    }
```

In the returned `addLayers` object, add `noLayerPatches` next to `perPatch`:

```ts
        perPatch: Object.keys(perPatch).length > 0 ? perPatch : undefined,
        noLayerPatches: noLayerPatches.length > 0 ? noLayerPatches : undefined,
```

Update the memo dependency array: replace `patchLayerOn` with `patchLayerEnabled, patchLayerCustom` (leave `patchLayers`, `nLayers`, `thicknessRatio`, `maxFirstLayer` as-is — the mirror rows read them).

- [ ] **Step 4: Rewrite the per-patch layers table JSX**

Replace the whole `patches.length > 0 && ( <fieldset> … Per-patch layers … </fieldset> )` block with the tri-state table below. Mirror rows show the global values (disabled); custom rows are editable; each row carries a Customize / reset-to-global affordance:

```tsx
                  {patches.length > 0 && (
                    <fieldset className="flex flex-col gap-2">
                      <legend className="text-sm font-medium text-text">Per-patch layers</legend>
                      <p className="text-xs text-text-secondary">
                        Untick a patch for no layers on it. Ticked patches follow the global
                        values above; hit <span className="font-medium">Customize</span> to give a
                        patch its own count · thickness ratio · max first-layer.
                      </p>
                      <div className="flex flex-col gap-2">
                        {patches.map((patch) => {
                          const enabled = patchLayerEnabled[patch.name] ?? true;
                          const custom = patchLayerCustom[patch.name] ?? false;
                          const s = patchLayers[patch.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
                          // Mirror rows display the current GLOBAL values (read-only).
                          const shown = custom ? s : { n: nLayers, ratio: thicknessRatio, maxFirst: maxFirstLayer };
                          return (
                            <div key={patch.name} className="flex flex-wrap items-center gap-2">
                              <label
                                className="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm text-text"
                                title={patch.name}
                                translate="no"
                              >
                                <input
                                  type="checkbox"
                                  className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                                  checked={enabled}
                                  onChange={(e) => setPatchLayerEnabled((prev) => ({ ...prev, [patch.name]: e.target.checked }))}
                                />
                                <span className="min-w-0 truncate">{patch.name}</span>
                              </label>
                              {enabled && (
                                <div className="flex items-center gap-1.5">
                                  <Input
                                    type="number" min="1" step="1" className="w-16"
                                    disabled={!custom}
                                    aria-label={`${patch.name} number of layers`}
                                    value={shown.n}
                                    onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...s, n: e.target.value } }))}
                                  />
                                  <Input
                                    type="number" min="1" step="any" className="w-16"
                                    disabled={!custom}
                                    aria-label={`${patch.name} thickness ratio`}
                                    value={shown.ratio}
                                    onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...s, ratio: e.target.value } }))}
                                  />
                                  <Input
                                    type="number" min="0" step="any" className="w-20"
                                    placeholder="auto"
                                    disabled={!custom}
                                    aria-label={`${patch.name} max first layer thickness`}
                                    value={shown.maxFirst}
                                    onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...s, maxFirst: e.target.value } }))}
                                  />
                                  {custom ? (
                                    <button
                                      type="button"
                                      className="rounded-sm px-1.5 text-xs font-medium text-text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                                      onClick={() => setPatchLayerCustom((prev) => ({ ...prev, [patch.name]: false }))}
                                    >
                                      Reset to global
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="rounded-sm px-1.5 text-xs font-medium text-cta hover:text-cta-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                                      onClick={() =>
                                        setPatchLayerCustom((prev) => {
                                          // Seed the custom fields from the current globals on first customize.
                                          setPatchLayers((pl) => ({
                                            ...pl,
                                            [patch.name]: { n: nLayers, ratio: thicknessRatio, maxFirst: maxFirstLayer },
                                          }));
                                          return { ...prev, [patch.name]: true };
                                        })
                                      }
                                    >
                                      Customize
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
```

> Note: verify `cta-hover` is a defined token in this repo's Tailwind config; if not, reuse the same hover class the form's other accent buttons use (e.g. `hover:text-primary`). Do not introduce a hard-coded color.

- [ ] **Step 5: Remove the now-dead `patchLayerOn` references**

Grep the file for `patchLayerOn` — there must be **zero** remaining references (state, setter, sync, memo dep, JSX). Run: `grep -n "patchLayerOn" apps/web/src/features/meshing/CfMeshConfigForm.tsx` → expected: no output.

- [ ] **Step 6: Typecheck + build**

Run: `npm run build:shared && npm run typecheck -w @dive/web && npm run build -w @dive/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/meshing/CfMeshConfigForm.tsx
git commit -m "feat(meshing): tri-state per-patch inflation layers (off/mirror/custom)"
```

---

### Task 6: Full gate + manual browser verification + PLAN.md note

**Files:**
- Modify: `PLAN.md` (append a French implementation note at the bottom, matching the existing entries' style)

- [ ] **Step 1: Run the touched api suites + full typecheck**

Run (from repo root): `npm run build:shared && npx vitest run tests/cfMeshDicts.test.ts tests/meshing.test.ts tests/snappyPipeline.test.ts tests/snappyDicts.test.ts --dir apps/api && npm run typecheck && npm run lint`
Expected: all green; lint clean on the touched files.

- [ ] **Step 2: Manual browser pass (user runs the app)**

Open a **cfMesh** meshing session with ≥ 2 patches and confirm:
- Advanced → **Local refinement**: tick a patch, enter a cell size, save, reload → the row stays ticked with its size; untick → the size input disables and the value drops from the saved config.
- **Add boundary layers** on → each patch row starts ticked (mirror), inputs disabled and showing the global numbers; change a global number → mirror rows update live.
- **Untick** a patch → its inputs disappear (no layers).
- **Customize** a patch → inputs become editable, values independent of the global; **Reset to global** → back to disabled/mirroring.
- Click **Generate mesh** → the run starts (returns 200/202); if the OpenFOAM toolchain is present, the generated `system/meshDict` contains a `localRefinement` block for the refined patch, `nLayers 0` for the unticked patch, and a custom `patchBoundaryLayers` entry for the customized patch.

- [ ] **Step 3: Append the PLAN.md implementation note**

Add a `#### Feature — Meshing (cfMesh) : …` paragraph at the bottom of `PLAN.md` summarizing: per-patch `localRefinement` (cellSize m) + tri-state layers (`noLayerPatches` off / mirror / `perPatch` custom), shared+schema+renderer+form, backward-compat (old configs byte-identical), and the gates run.

- [ ] **Step 4: Commit**

```bash
git add PLAN.md
git commit -m "docs(meshing): note cfMesh per-patch refinement + tri-state layers in PLAN.md"
```

---

## Self-Review

**Spec coverage:**
- Per-patch local refinement (cell size, tick, `localRefinement` block, in Advanced under the sizing grid) → Tasks 1, 2, 3, 4. ✓
- Global `boundaryCellSize` retained → unchanged (Task 4 only adds overrides). ✓
- Tri-state layers (off `nLayers 0` / mirror / custom) with tick + Customize + reset-to-global → Tasks 1, 2, 3, 5. ✓
- Default tick state = all mirroring; old configs byte-identical → seeding in Task 5 Step 1 + renderer byte-identical test in Task 3 Step 5. ✓
- Data model `CfMeshLocalRefinement`, `localRefinement`, `noLayerPatches` → Task 1. ✓
- Validation (`cellSize` positive, `noLayerPatches` string array) → Task 2. ✓
- Testing (renderer unit, schema, no-regression, browser) → Tasks 2, 3, 6. ✓
- Out of scope (snappy, levels/thickness, removing globals) → respected; no task touches them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; the one advisory note (Task 5 Step 4) names a concrete fallback rather than leaving it open.

**Type consistency:** `CfMeshLocalRefinement { cellSize }`, `localRefinement?: Record<string, CfMeshLocalRefinement>`, `noLayerPatches?: string[]` used identically across shared (Task 1), schema (Task 2), renderer (Task 3), and form (Tasks 4–5). Form state names `patchRefineOn` / `patchRefine` / `patchLayerEnabled` / `patchLayerCustom` are consistent within Tasks 4–5, and `patchLayerOn` is fully removed (Task 5 Step 5).
