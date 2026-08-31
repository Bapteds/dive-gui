# Per-Patch Boundary Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make boundary-layer (prism) growth settable **per patch/STL** — layer count, growth, and thickness — for **both** meshing engines, keyed by patch/STL name with the current global values as the fallback default.

**Architecture:** Two vertical slices (snappy + cfMesh) through shared model → API Zod schema → dict renderer → web form. Mirrors the established `surfaceRefinements`/`featureRefinements`/`patchTypes` override pattern: keep the global fields as defaults; add an optional per-patch override map. A patch absent from the map uses the globals, so old saved configs render byte-identically.

**Tech Stack:** TypeScript monorepo — `@dive/shared` (types), `@dive/api` (Zod + pure dict renderers, Vitest), `@dive/web` (React). No OpenFOAM toolchain touched (renderers are pure and unit-tested; run tests mock the toolchain).

## Global Constraints

- **`relativeSizes` stays global (snappy).** It is a single `addLayersControls` switch — OpenFOAM has no per-region equivalent. Only count / expansion / final-thickness go per-surface for snappy.
- **Byte-identical when no override.** The snappy renderer emits the extra per-region keys (`expansionRatio` / `finalLayerThickness`) **only for a surface that has a `perSurface` entry**; a surface without one renders exactly as today (`{ nSurfaceLayers N; }`). The cfMesh renderer emits a `patchBoundaryLayers` block **only when `perPatch` has entries**. An old saved config (no `perSurface`/`perPatch`) is unchanged.
- **Keying:** snappy `perSurface` is keyed by STL file name (like `surfaceRefinements`); cfMesh `perPatch` is keyed by patch name (like `patchTypes`).
- **On/off unchanged (snappy):** the existing `addLayers.surfaces[]` list still gates which surfaces grow layers; `perSurface` only carries the values.
- Spec: `docs/superpowers/specs/2026-08-11-per-patch-layers-design.md`.

---

### Task 1: Shared model — `perSurface` (snappy) + `perPatch` (cfMesh)

**Files:**
- Modify: `packages/shared/src/index.ts:869-889` (`AddLayersConfig` + new `SurfaceLayerSpec`)
- Modify: `packages/shared/src/index.ts:954-969` (`CfMeshLayersConfig` + new `CfMeshPatchLayerSpec`, update the "later refinement" comment)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SurfaceLayerSpec { nLayers; expansionRatio; finalLayerThickness }`; `AddLayersConfig.perSurface?: Record<string, SurfaceLayerSpec>`. `CfMeshPatchLayerSpec { nLayers; thicknessRatio; maxFirstLayerThickness: number | null }`; `CfMeshLayersConfig.perPatch?: Record<string, CfMeshPatchLayerSpec>`. Defaults unchanged (no map keys).

- [ ] **Step 1: Add `SurfaceLayerSpec` + `perSurface` to snappy layers**

In `packages/shared/src/index.ts`, replace the `AddLayersConfig` interface (`:869-889`):

```ts
/** Boundary-layer (prism) growth controls for the surfaces. */
export interface AddLayersConfig {
  enabled: boolean;
  /**
   * The STL surfaces (by file name) on which to grow layers — the boundaries the
   * prism layers attach to. Omitted or empty means every surface (legacy default),
   * so an old config keeps working; the UI lists one checkbox per surface.
   */
  surfaces?: string[];
  /** Number of prism layers grown on the surfaces. */
  nLayers: number;
  /**
   * When true, `finalLayerThickness` is a fraction of the local cell size;
   * when false it is an absolute length (metres). Maps to snappy `relativeSizes`.
   */
  relativeSizes: boolean;
  /** Thickness of the layer nearest the surface (relative or absolute per `relativeSizes`). */
  finalLayerThickness: number;
  /** Growth ratio between successive layers (>= 1). */
  expansionRatio: number;
}
```

with:

```ts
/**
 * Per-surface boundary-layer override (snappy), keyed by STL file name. Absent key
 * => the config's global nLayers / expansionRatio / finalLayerThickness are used.
 * `relativeSizes` is NOT here: it is a single addLayersControls switch with no
 * per-region equivalent in OpenFOAM, so it stays global on AddLayersConfig.
 */
export interface SurfaceLayerSpec {
  /** Number of prism layers on this surface (>= 1). */
  nLayers: number;
  /** Growth ratio between successive layers (>= 1). */
  expansionRatio: number;
  /** Near-wall layer thickness (relative or absolute per the global relativeSizes). */
  finalLayerThickness: number;
}

/** Boundary-layer (prism) growth controls for the surfaces. */
export interface AddLayersConfig {
  enabled: boolean;
  /**
   * The STL surfaces (by file name) on which to grow layers — the boundaries the
   * prism layers attach to. Omitted or empty means every surface (legacy default),
   * so an old config keeps working; the UI lists one checkbox per surface.
   */
  surfaces?: string[];
  /** Global default number of prism layers (per-surface override wins). */
  nLayers: number;
  /**
   * When true, `finalLayerThickness` is a fraction of the local cell size;
   * when false it is an absolute length (metres). Maps to snappy `relativeSizes`.
   * GLOBAL only — OpenFOAM has no per-region relativeSizes.
   */
  relativeSizes: boolean;
  /** Global default near-wall layer thickness (per-surface override wins). */
  finalLayerThickness: number;
  /** Global default growth ratio between successive layers (>= 1) (per-surface override wins). */
  expansionRatio: number;
  /** Per-surface overrides keyed by STL file name; absent key => the globals above. */
  perSurface?: Record<string, SurfaceLayerSpec>;
}
```

- [ ] **Step 2: Add `CfMeshPatchLayerSpec` + `perPatch` to cfMesh layers**

In `packages/shared/src/index.ts`, replace the `CfMeshLayersConfig` block (`:954-969`):

```ts
/**
 * cfMesh (cartesianMesh) boundary-layer controls. cfMesh sizes are ABSOLUTE
 * lengths and use a different vocabulary from snappy: growth is `thicknessRatio`
 * and the near-wall layer is capped by `maxFirstLayerThickness` (rather than
 * snappy's relativeSizes / finalLayerThickness / expansionRatio). Applied to all
 * boundaries (per-patch layers are a later refinement).
 */
export interface CfMeshLayersConfig {
  enabled: boolean;
  /** Number of prism layers. */
  nLayers: number;
  /** Growth ratio between successive layers (>= 1). Maps to cfMesh thicknessRatio. */
  thicknessRatio: number;
  /** Cap on the first (near-wall) layer thickness in metres; null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
}
```

with:

```ts
/**
 * Per-patch boundary-layer override (cfMesh), keyed by patch name (STL solid / FMS
 * patch). Absent key => the config's global cfMesh layer values are used. Rendered
 * as a `patchBoundaryLayers` sub-block, cfMesh's native per-patch mechanism.
 */
export interface CfMeshPatchLayerSpec {
  /** Number of prism layers on this patch (>= 1). */
  nLayers: number;
  /** Growth ratio (cfMesh thicknessRatio, >= 1). */
  thicknessRatio: number;
  /** Cap on the first (near-wall) layer thickness in metres; null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
}

/**
 * cfMesh (cartesianMesh) boundary-layer controls. cfMesh sizes are ABSOLUTE
 * lengths and use a different vocabulary from snappy: growth is `thicknessRatio`
 * and the near-wall layer is capped by `maxFirstLayerThickness` (rather than
 * snappy's relativeSizes / finalLayerThickness / expansionRatio). The global
 * fields are the default; `perPatch` overrides them for named patches.
 */
export interface CfMeshLayersConfig {
  enabled: boolean;
  /** Global default number of prism layers. */
  nLayers: number;
  /** Global default growth ratio (>= 1). Maps to cfMesh thicknessRatio. */
  thicknessRatio: number;
  /** Global default cap on the first-layer thickness (m); null => cfMesh decides. */
  maxFirstLayerThickness: number | null;
  /** Per-patch overrides keyed by patch name; absent key => the globals above. */
  perPatch?: Record<string, CfMeshPatchLayerSpec>;
}
```

- [ ] **Step 3: Build shared**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared"
```

(PowerShell tool.) Expected: tsc emits with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(meshing): shared per-patch boundary-layer model (perSurface + perPatch)"
```

---

### Task 2: API schema — validate `perSurface` + `perPatch`

**Files:**
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts:88-104` (snappy `addLayers` gains `perSurface`)
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts:136-143` (cfMesh `addLayers` gains `perPatch`)
- Test: `apps/api/tests/meshing.test.ts` (append cases near the feature-edge schema tests)

**Interfaces:**
- Consumes: `SurfaceLayerSpec`, `CfMeshPatchLayerSpec` (Task 1).
- Produces: `runSnappySchema.addLayers.perSurface` (optional record of `{ nLayers int 1–20, expansionRatio 1–5, finalLayerThickness positive }`); `runCfMeshSchema.addLayers.perPatch` (optional record of `{ nLayers int 1–20, thicknessRatio 1–5, maxFirstLayerThickness positive nullable }`).

- [ ] **Step 1: Write the failing schema tests**

In `apps/api/tests/meshing.test.ts`, append (`runSnappySchema` is already imported from the feature-edge task; also import `runCfMeshSchema` from the same module if not already):

```ts
describe('per-patch boundary layers — schema', () => {
  const snappyBase = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };
  const cfBase = { engine: 'cfmesh' };

  it('snappy accepts a per-surface layer override', () => {
    const parsed = runSnappySchema.parse({
      ...snappyBase,
      addLayers: {
        enabled: true, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2,
        perSurface: { 'rotor.stl': { nLayers: 6, expansionRatio: 1.3, finalLayerThickness: 0.4 } },
      },
    });
    expect(parsed.addLayers.perSurface?.['rotor.stl']).toEqual({
      nLayers: 6, expansionRatio: 1.3, finalLayerThickness: 0.4,
    });
  });

  it('cfMesh accepts a per-patch layer override', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      addLayers: {
        enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
        perPatch: { walls: { nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: 0.01 } },
      },
    });
    expect(parsed.addLayers.perPatch?.walls).toEqual({
      nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: 0.01,
    });
  });

  it('leaves the maps undefined when omitted', () => {
    const s = runSnappySchema.parse({
      ...snappyBase,
      addLayers: { enabled: false, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2 },
    });
    expect(s.addLayers.perSurface).toBeUndefined();
    const c = runCfMeshSchema.parse({ ...cfBase });
    expect(c.addLayers.perPatch).toBeUndefined();
  });

  it('rejects an out-of-range per-surface layer count', () => {
    expect(() =>
      runSnappySchema.parse({
        ...snappyBase,
        addLayers: {
          enabled: true, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2,
          perSurface: { 'r.stl': { nLayers: 99, expansionRatio: 1.2, finalLayerThickness: 0.5 } },
        },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'per-patch boundary layers'"
```

(PowerShell tool.) Expected: FAIL — `perSurface` / `perPatch` are stripped (unknown keys), so the overrides come back `undefined`.

- [ ] **Step 3: Add the snappy `perSurface` schema**

In `apps/api/src/modules/meshing/meshing.schemas.ts`, inside `runSnappySchema`'s `addLayers` object, add `perSurface` right after the `expansionRatio` line (`:96`):

```ts
      expansionRatio: z.number().min(1).max(5).default(1.2),
      // Per-surface layer overrides keyed by STL file name; absent key => the globals.
      perSurface: z
        .record(
          z.string(),
          z.object({
            nLayers: z.number().int().min(1).max(20),
            expansionRatio: z.number().min(1).max(5),
            finalLayerThickness: z.number().positive(),
          }),
        )
        .optional(),
```

- [ ] **Step 4: Add the cfMesh `perPatch` schema**

In `runCfMeshSchema`'s `addLayers` object, add `perPatch` right after the `maxFirstLayerThickness` line (`:141`):

```ts
      maxFirstLayerThickness: z.number().positive().nullable().default(null),
      // Per-patch layer overrides keyed by patch name; absent key => the globals.
      perPatch: z
        .record(
          z.string(),
          z.object({
            nLayers: z.number().int().min(1).max(20),
            thicknessRatio: z.number().min(1).max(5),
            maxFirstLayerThickness: z.number().positive().nullable().default(null),
          }),
        )
        .optional(),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'per-patch boundary layers'"
```

(PowerShell tool.) Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/meshing/meshing.schemas.ts apps/api/tests/meshing.test.ts
git commit -m "feat(meshing): validate per-patch layer overrides (snappy perSurface, cfMesh perPatch)"
```

---

### Task 3: snappy renderer — per-surface layer values

**Files:**
- Modify: `apps/api/src/lib/snappyDicts.ts:287-294` (per-region `layers` block)
- Test: `apps/api/tests/snappyDicts.test.ts` (append a per-surface case)

**Interfaces:**
- Consumes: `AddLayersConfig.perSurface` (Task 1). `fmt` is already defined in `snappyDicts.ts`.
- Produces: a region with a `perSurface` entry renders `{ nSurfaceLayers n; expansionRatio e; finalLayerThickness f; }`; a region without one renders `{ nSurfaceLayers <global>; }` exactly as today.

- [ ] **Step 1: Write the failing test**

In `apps/api/tests/snappyDicts.test.ts`, append inside the `describe('dict renderers', …)` block:

```ts
  it('applies a per-surface layer override, others at the global count', () => {
    const dict = renderSnappyHexMeshDict(
      ['rotor.stl', 'stator.stl'],
      domain,
      config({
        addLayers: {
          enabled: true, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2,
          perSurface: { 'rotor.stl': { nLayers: 6, expansionRatio: 1.3, finalLayerThickness: 0.4 } },
        },
      }),
    );
    // rotor carries its own count + growth + thickness…
    expect(dict).toContain('rotor { nSurfaceLayers 6; expansionRatio 1.3; finalLayerThickness 0.4; }');
    // …stator keeps the plain global-count form (byte-identical to today).
    expect(dict).toContain('stator { nSurfaceLayers 3; }');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts -t 'per-surface layer override'"
```

(PowerShell tool.) Expected: FAIL — every region currently renders `{ nSurfaceLayers <global>; }`, so the rotor override line is absent.

- [ ] **Step 3: Emit per-surface values in the layers block**

In `apps/api/src/lib/snappyDicts.ts`, replace the `layers` builder (`:292-294`):

```ts
  const layers = layerRegions
    .map((r) => `        ${r.region} { nSurfaceLayers ${config.addLayers.nLayers}; }`)
    .join('\n');
```

with:

```ts
  const layers = layerRegions
    .map((r) => {
      // A per-surface override carries its own count + growth + thickness; without
      // one, keep the plain global-count form so an un-overridden dict is unchanged.
      const spec = config.addLayers.perSurface?.[r.file];
      if (!spec) return `        ${r.region} { nSurfaceLayers ${config.addLayers.nLayers}; }`;
      return `        ${r.region} { nSurfaceLayers ${spec.nLayers}; expansionRatio ${fmt(spec.expansionRatio)}; finalLayerThickness ${fmt(spec.finalLayerThickness)}; }`;
    })
    .join('\n');
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts"
```

(PowerShell tool.) Expected: PASS (all snappyDicts tests, including the new per-surface case; the existing layer test still matches its substrings).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/snappyDicts.ts apps/api/tests/snappyDicts.test.ts
git commit -m "feat(meshing): snappy renders per-surface layer count/growth/thickness"
```

---

### Task 4: cfMesh renderer — `patchBoundaryLayers` block

**Files:**
- Modify: `apps/api/src/lib/cfMeshDicts.ts:85-98` (boundary-layer block)
- Test: `apps/api/tests/cfMeshDicts.test.ts` (append a per-patch case)

**Interfaces:**
- Consumes: `CfMeshLayersConfig.perPatch` (Task 1). `fmt` is already defined in `cfMeshDicts.ts`.
- Produces: when `perPatch` has entries, a `patchBoundaryLayers { "<patch>" { nLayers; thicknessRatio; maxFirstLayerThickness?; allowDiscontinuity 0; } }` sub-block inside `boundaryLayers`; when empty/absent, no such block (byte-identical to today).

- [ ] **Step 1: Write the failing test**

In `apps/api/tests/cfMeshDicts.test.ts`, append inside `describe('renderMeshDict', …)`:

```ts
  it('emits a patchBoundaryLayers block for per-patch overrides only', () => {
    const dict = renderMeshDict(
      config({
        addLayers: {
          enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
          perPatch: { walls: { nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: 0.01 } },
        },
      }),
      'constant/triSurface/combined.fms',
      0.4,
    );
    expect(dict).toContain('patchBoundaryLayers');
    expect(dict).toContain('"walls"');
    expect(dict).toContain('nLayers 5;');
    expect(dict).toContain('thicknessRatio 1.4;');
    expect(dict).toContain('maxFirstLayerThickness 0.01;');
  });

  it('omits patchBoundaryLayers when there are no per-patch overrides', () => {
    const dict = renderMeshDict(
      config({ addLayers: { enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null } }),
      'x.fms',
      0.4,
    );
    expect(dict).toContain('boundaryLayers');
    expect(dict).not.toContain('patchBoundaryLayers');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- cfMeshDicts.test.ts -t 'patchBoundaryLayers'"
```

(PowerShell tool.) Expected: FAIL on the first case (no `patchBoundaryLayers` emitted yet); the "omits" case passes already.

- [ ] **Step 3: Emit the per-patch block**

In `apps/api/src/lib/cfMeshDicts.ts`, replace the boundary-layer block (`:85-98`):

```ts
  if (config.addLayers.enabled) {
    const layer: string[] = [
      'boundaryLayers',
      '{',
      `    nLayers ${Math.max(1, Math.round(config.addLayers.nLayers))};`,
      `    thicknessRatio ${fmt(Math.max(1, config.addLayers.thicknessRatio))};`,
    ];
    if (config.addLayers.maxFirstLayerThickness && config.addLayers.maxFirstLayerThickness > 0) {
      layer.push(`    maxFirstLayerThickness ${fmt(config.addLayers.maxFirstLayerThickness)};`);
    }
    // Smooth the layer over the whole boundary; standard cfMesh tutorial setting.
    layer.push('    allowDiscontinuity 0;', '    optimiseLayer 1;', '}');
    lines.push('', ...layer);
  }
```

with:

```ts
  if (config.addLayers.enabled) {
    const layer: string[] = [
      'boundaryLayers',
      '{',
      `    nLayers ${Math.max(1, Math.round(config.addLayers.nLayers))};`,
      `    thicknessRatio ${fmt(Math.max(1, config.addLayers.thicknessRatio))};`,
    ];
    if (config.addLayers.maxFirstLayerThickness && config.addLayers.maxFirstLayerThickness > 0) {
      layer.push(`    maxFirstLayerThickness ${fmt(config.addLayers.maxFirstLayerThickness)};`);
    }
    // Per-patch overrides: cfMesh's native patchBoundaryLayers sub-block, keyed by
    // patch name. Only emitted when the user set at least one override.
    const perPatch = Object.entries(config.addLayers.perPatch ?? {});
    if (perPatch.length > 0) {
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
      layer.push('    }');
    }
    // Smooth the layer over the whole boundary; standard cfMesh tutorial setting.
    layer.push('    allowDiscontinuity 0;', '    optimiseLayer 1;', '}');
    lines.push('', ...layer);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- cfMeshDicts.test.ts"
```

(PowerShell tool.) Expected: PASS (all cfMeshDicts tests, including the two new cases; the existing global-layer test is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/cfMeshDicts.ts apps/api/tests/cfMeshDicts.test.ts
git commit -m "feat(meshing): cfMesh renders patchBoundaryLayers for per-patch overrides"
```

---

### Task 5: snappy web form — per-surface layer table

**Files:**
- Modify: `apps/web/src/lib/api/types.ts:810-826` (re-export `SurfaceLayerSpec`)
- Modify: `apps/web/src/features/meshing/SnappyConfigForm.tsx`

**Interfaces:**
- Consumes: `SurfaceLayerSpec`, `AddLayersConfig.perSurface`, `DEFAULT_SNAPPY_CONFIG.addLayers` (Task 1).
- Produces: on submit the form writes `addLayers.perSurface` (every current STL → `{ nLayers, expansionRatio, finalLayerThickness }`, seeded from the globals). The on/off `surfaces[]` list is unchanged.

- [ ] **Step 1: Re-export `SurfaceLayerSpec` for the web**

In `apps/web/src/lib/api/types.ts`, add `SurfaceLayerSpec` to the `export type { … } from '@dive/shared'` block (after `AddLayersConfig`, `:821`):

```ts
  AddLayersConfig,
  SurfaceLayerSpec,
```

- [ ] **Step 2: Import the type + add the layer-spec map type/seed**

In `SnappyConfigForm.tsx`, add `SurfaceLayerSpec` to the `@/lib/api/types` import. Then, immediately after the existing `seedLayerSurfaces` helper (`:81-88`), add:

```ts
type LayerSpecInput = { n: string; exp: string; final: string };
type LayerSpecMap = Record<string, LayerSpecInput>;

/** Seed the per-surface layer values from the saved config (or the globals). */
function seedLayerSpecs(stls: StlFile[], initial: SnappyConfig | null): LayerSpecMap {
  const g = initial?.addLayers ?? DEFAULT_SNAPPY_CONFIG.addLayers;
  const map: LayerSpecMap = {};
  for (const stl of stls) {
    const s = initial?.addLayers.perSurface?.[stl.name];
    map[stl.name] = {
      n: String(s?.nLayers ?? g.nLayers),
      exp: String(s?.expansionRatio ?? g.expansionRatio),
      final: String(s?.finalLayerThickness ?? g.finalLayerThickness),
    };
  }
  return map;
}
```

- [ ] **Step 3: Add the layer-spec state + sync + updater**

After the `layerSurfaceOn` state declaration (`:119-121`), add:

```ts
  const [layerSpecs, setLayerSpecs] = useState<LayerSpecMap>(() => seedLayerSpecs(stls, initialConfig));
```

In the `stlKey` sync effect, after the `setLayerSurfaceOn((prev) => {…})` block (the third sync added for features stays as-is; add a fourth), before the closing `}, [stlKey]);` insert:

```ts
    // Per-surface layer values: a new surface defaults to the current globals.
    setLayerSpecs((prev) => {
      const g = DEFAULT_SNAPPY_CONFIG.addLayers;
      const next: LayerSpecMap = {};
      for (const stl of stls) {
        next[stl.name] =
          prev[stl.name] ?? { n: String(g.nLayers), exp: String(g.expansionRatio), final: String(g.finalLayerThickness) };
      }
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

After the `setFeat` helper (added by the feature-edge task), add:

```ts
  const setLayerSpec = (name: string, key: keyof LayerSpecInput, value: string) => {
    setLayerSpecs((prev) => ({ ...prev, [name]: { ...prev[name], [key]: value } }));
  };
```

- [ ] **Step 4: Build `perSurface` in the config memo**

In the `config` memo, replace the `addLayers` object (`:219-227`):

```ts
      addLayers: {
        enabled: layersOn,
        // The surfaces (boundaries) the layers grow on — the checked STL surfaces.
        surfaces: stls.map((s) => s.name).filter((name) => layerSurfaceOn[name] ?? true),
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        relativeSizes,
        finalLayerThickness: Math.max(1e-6, Number(finalThickness) || 0.5),
        expansionRatio: Math.max(1, Number(expansionRatio) || 1.2),
      },
```

with:

```ts
      addLayers: {
        enabled: layersOn,
        // The surfaces (boundaries) the layers grow on — the checked STL surfaces.
        surfaces: stls.map((s) => s.name).filter((name) => layerSurfaceOn[name] ?? true),
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        relativeSizes,
        finalLayerThickness: Math.max(1e-6, Number(finalThickness) || 0.5),
        expansionRatio: Math.max(1, Number(expansionRatio) || 1.2),
        perSurface,
      },
```

and, immediately before the `return {` in that memo (right after the `featureScalar` block from the feature-edge task), add:

```ts
    // Per-surface layer values, one entry per current STL (mirrors surfaceRefinements).
    const perSurface: Record<string, SurfaceLayerSpec> = {};
    for (const stl of stls) {
      const s = layerSpecs[stl.name] ?? { n: '3', exp: '1.2', final: '0.5' };
      perSurface[stl.name] = {
        nLayers: Math.max(1, Math.round(Number(s.n) || DEFAULT_SNAPPY_CONFIG.addLayers.nLayers)),
        expansionRatio: Math.max(1, Number(s.exp) || DEFAULT_SNAPPY_CONFIG.addLayers.expansionRatio),
        finalLayerThickness: Math.max(1e-6, Number(s.final) || DEFAULT_SNAPPY_CONFIG.addLayers.finalLayerThickness),
      };
    }
```

Add `layerSpecs` to the memo dependency array (`:230-233`), next to `layerSurfaceOn`.

- [ ] **Step 5: Render per-surface value inputs in the "Grow layers on" rows**

In `SnappyConfigForm.tsx`, replace the per-surface checkbox row (`:602-618`, the `{stls.map((stl) => ( <label…>…</label> ))}` block) with a row that adds the three value inputs when the surface is on:

```tsx
                          {stls.map((stl) => {
                            const on = layerSurfaceOn[stl.name] ?? true;
                            const s = layerSpecs[stl.name] ?? { n: '3', exp: '1.2', final: '0.5' };
                            return (
                              <div key={stl.name} className="flex flex-wrap items-center gap-2">
                                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text" title={stl.name}>
                                  <input
                                    type="checkbox"
                                    className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                                    checked={on}
                                    onChange={(e) =>
                                      setLayerSurfaceOn((prev) => ({ ...prev, [stl.name]: e.target.checked }))
                                    }
                                  />
                                  <span className="min-w-0 truncate">{stl.name}</span>
                                </label>
                                {on && (
                                  <div className="flex items-center gap-1.5">
                                    <Input
                                      type="number" min="1" step="1" className="w-16"
                                      aria-label={`${stl.name} number of layers`}
                                      value={s.n}
                                      onChange={(e) => setLayerSpec(stl.name, 'n', e.target.value)}
                                    />
                                    <Input
                                      type="number" min="1" step="any" className="w-16"
                                      aria-label={`${stl.name} expansion ratio`}
                                      value={s.exp}
                                      onChange={(e) => setLayerSpec(stl.name, 'exp', e.target.value)}
                                    />
                                    <Input
                                      type="number" min="0" step="any" className="w-20"
                                      aria-label={`${stl.name} final layer thickness`}
                                      value={s.final}
                                      onChange={(e) => setLayerSpec(stl.name, 'final', e.target.value)}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
```

Update the fieldset's legend/help so the columns are labelled — replace the legend line (`:594`):

```tsx
                    <legend className="text-sm font-medium text-text">Grow layers on</legend>
```

with:

```tsx
                    <legend className="text-sm font-medium text-text">Grow layers on</legend>
                    <p className="text-xs text-text-secondary">
                      Per surface: on/off, then layers · expansion · final thickness (blank rows use the defaults above).
                    </p>
```

- [ ] **Step 6: Type-check + build the web app**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build -w @dive/web"
```

(PowerShell tool.) Expected: `tsc` + Vite build succeed, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/meshing/SnappyConfigForm.tsx apps/web/src/lib/api/types.ts
git commit -m "feat(meshing): per-surface layer inputs (count/expansion/thickness) in the snappy form"
```

---

### Task 6: cfMesh web form — per-patch layer table

**Files:**
- Modify: `apps/web/src/lib/api/types.ts:810-826` (re-export `CfMeshPatchLayerSpec`)
- Modify: `apps/web/src/features/meshing/CfMeshConfigForm.tsx`

**Interfaces:**
- Consumes: `CfMeshPatchLayerSpec`, `CfMeshLayersConfig.perPatch`, `DEFAULT_CFMESH_CONFIG.addLayers` (Task 1).
- Produces: on submit the form writes `addLayers.perPatch` (every discovered patch → `{ nLayers, thicknessRatio, maxFirstLayerThickness }`, seeded from the globals) when layers are enabled.

- [ ] **Step 1: Re-export `CfMeshPatchLayerSpec` for the web**

In `apps/web/src/lib/api/types.ts`, add `CfMeshPatchLayerSpec` to the shared `export type` block (after `CfMeshLayersConfig`, `:817`):

```ts
  CfMeshLayersConfig,
  CfMeshPatchLayerSpec,
```

- [ ] **Step 2: Import the type + add the per-patch layer map/seed**

In `CfMeshConfigForm.tsx`, add `CfMeshPatchLayerSpec` to the `@/lib/api/types` import. Then, after the `seedPatchType` helper (`:21`), add:

```ts
type PatchLayerInput = { n: string; ratio: string; maxFirst: string };
type PatchLayerMap = Record<string, PatchLayerInput>;

/** Seed the per-patch layer values from the saved config (or the globals). */
function seedPatchLayers(patches: MeshingPatch[], init: CfMeshConfig): PatchLayerMap {
  const g = init.addLayers;
  const map: PatchLayerMap = {};
  for (const p of patches) {
    const s = init.addLayers.perPatch?.[p.name];
    map[p.name] = {
      n: String(s?.nLayers ?? g.nLayers),
      ratio: String(s?.thicknessRatio ?? g.thicknessRatio),
      maxFirst: s?.maxFirstLayerThickness ? String(s.maxFirstLayerThickness) : '',
    };
  }
  return map;
}
```

- [ ] **Step 3: Add the per-patch layer state + sync + updater**

After the `patchTypes` state block (`:110-114`), add:

```ts
  const [patchLayers, setPatchLayers] = useState<PatchLayerMap>(() => seedPatchLayers(patches, init));
```

In the `patchKey` sync effect (`:125-135`), before the closing `}, [patchKey]);`, add:

```ts
    setPatchLayers((prev) => {
      const g = DEFAULT_CFMESH_CONFIG.addLayers;
      const next: PatchLayerMap = {};
      for (const p of patches) {
        next[p.name] = prev[p.name] ?? { n: String(g.nLayers), ratio: String(g.thicknessRatio), maxFirst: '' };
      }
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 4: Build `perPatch` in the config memo**

In the `config` memo, replace the `addLayers` object (`:162-167`):

```ts
      addLayers: {
        enabled: layersOn,
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        thicknessRatio: Math.max(1, Number(thicknessRatio) || 1.2),
        maxFirstLayerThickness: parseSize(maxFirstLayer),
      },
```

with:

```ts
      addLayers: {
        enabled: layersOn,
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        thicknessRatio: Math.max(1, Number(thicknessRatio) || 1.2),
        maxFirstLayerThickness: parseSize(maxFirstLayer),
        perPatch: Object.keys(perPatch).length > 0 ? perPatch : undefined,
      },
```

and immediately before the `}),` that closes the returned object literal (right after the `addLayers` block, before `cores`), the memo needs `perPatch` computed. Since this memo is an arrow returning an object literal, convert its body to a block that computes `perPatch` first. Replace the memo opening (`:153-154`):

```ts
  const config = useMemo<CfMeshConfig>(
    () => ({
```

with:

```ts
  const config = useMemo<CfMeshConfig>(() => {
    // Per-patch layer values, one entry per discovered patch (mirrors patchTypes).
    const perPatch: Record<string, CfMeshPatchLayerSpec> = {};
    for (const p of patches) {
      const s = patchLayers[p.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
      perPatch[p.name] = {
        nLayers: Math.max(1, Math.round(Number(s.n) || DEFAULT_CFMESH_CONFIG.addLayers.nLayers)),
        thicknessRatio: Math.max(1, Number(s.ratio) || DEFAULT_CFMESH_CONFIG.addLayers.thicknessRatio),
        maxFirstLayerThickness: parseSize(s.maxFirst),
      };
    }
    return {
```

and replace the memo's closing (`:169-174`):

```ts
    }),
    [
      maxCellSize, minCellSize, boundaryCellSize, extractFeatures, featureAngle, chosenPatchTypes,
      layersOn, nLayers, thicknessRatio, maxFirstLayer, cores, maxCores,
    ],
  );
```

with:

```ts
    };
  }, [
    maxCellSize, minCellSize, boundaryCellSize, extractFeatures, featureAngle, chosenPatchTypes,
    layersOn, nLayers, thicknessRatio, maxFirstLayer, patchLayers, patches, cores, maxCores,
  ]);
```

- [ ] **Step 5: Render the per-patch layer table**

In `CfMeshConfigForm.tsx`, inside the layers `fieldset`, after the global `<div className="grid gap-4 sm:grid-cols-3">…</div>` (the block ending at `:386`) and still inside `{layersOn && ( … )}`, the current structure is `{layersOn && ( <div className="grid…3">…</div> )}`. Replace that single-child conditional (`:356-387`):

```tsx
              {layersOn && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Number of layers">
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={nLayers}
                      onChange={(e) => setNLayers(e.target.value)}
                    />
                  </Field>
                  <Field label="Thickness ratio" helperText="Growth per layer (≥ 1).">
                    <Input
                      type="number"
                      min="1"
                      step="any"
                      value={thicknessRatio}
                      onChange={(e) => setThicknessRatio(e.target.value)}
                    />
                  </Field>
                  <Field label="Max first layer (m)" helperText="Blank = auto.">
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      placeholder="auto"
                      value={maxFirstLayer}
                      onChange={(e) => setMaxFirstLayer(e.target.value)}
                    />
                  </Field>
                </div>
              )}
```

with:

```tsx
              {layersOn && (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Number of layers">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={nLayers}
                        onChange={(e) => setNLayers(e.target.value)}
                      />
                    </Field>
                    <Field label="Thickness ratio" helperText="Growth per layer (≥ 1).">
                      <Input
                        type="number"
                        min="1"
                        step="any"
                        value={thicknessRatio}
                        onChange={(e) => setThicknessRatio(e.target.value)}
                      />
                    </Field>
                    <Field label="Max first layer (m)" helperText="Blank = auto.">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        placeholder="auto"
                        value={maxFirstLayer}
                        onChange={(e) => setMaxFirstLayer(e.target.value)}
                      />
                    </Field>
                  </div>
                  {patches.length > 0 && (
                    <fieldset className="flex flex-col gap-2">
                      <legend className="text-sm font-medium text-text">Per-patch layers</legend>
                      <p className="text-xs text-text-secondary">
                        Override count · thickness ratio · max first-layer per patch (blank max = auto). Rows left at
                        the defaults above still send those values.
                      </p>
                      <div className="flex flex-col gap-2">
                        {patches.map((patch) => {
                          const s = patchLayers[patch.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
                          return (
                            <div key={patch.name} className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 flex-1 truncate font-mono text-sm text-text" title={patch.name} translate="no">
                                {patch.name}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Input
                                  type="number" min="1" step="1" className="w-16"
                                  aria-label={`${patch.name} number of layers`}
                                  value={s.n}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], n: e.target.value } }))}
                                />
                                <Input
                                  type="number" min="1" step="any" className="w-16"
                                  aria-label={`${patch.name} thickness ratio`}
                                  value={s.ratio}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], ratio: e.target.value } }))}
                                />
                                <Input
                                  type="number" min="0" step="any" className="w-20"
                                  placeholder="auto"
                                  aria-label={`${patch.name} max first layer thickness`}
                                  value={s.maxFirst}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], maxFirst: e.target.value } }))}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}
                </div>
              )}
```

- [ ] **Step 6: Type-check + build the web app**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build -w @dive/web"
```

(PowerShell tool.) Expected: `tsc` + Vite build succeed, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/meshing/CfMeshConfigForm.tsx apps/web/src/lib/api/types.ts
git commit -m "feat(meshing): per-patch layer inputs (count/ratio/max-first) in the cfMesh form"
```

---

### Task 7: Gates, browser verify, PLAN.md changelog

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: the Definition-of-Done gate.

- [ ] **Step 1: Full API test gate**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshing.test.ts snappyDicts.test.ts cfMeshDicts.test.ts"
```

(PowerShell tool.) Expected: all green — the new schema + renderer cases plus every pre-existing test.

- [ ] **Step 2: Browser review**

Ensure the dev server is up (ports 4000/5173); if not, start it with the PowerShell tool `run_in_background: true`:

```
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && exec npm run dev > /tmp/dive-dev.log 2>&1"
```

Poll `/tmp/dive-dev.log` for `Local: http://localhost:5173/` and `API listening on http://localhost:4000`. Note: Vite on `/mnt/c` may miss file-watch events — if the UI serves stale code, restart the dev tree (kill the `concurrently`/`vite`/`tsx` processes) and relaunch. Then, using the Browser tool (log in with `admin@dive-turbinen.de` / `ChangeMe!2026` if prompted):

1. **snappy** session with ≥1 STL: open the config's Advanced → enable **Add boundary layers** → each surface row shows the on/off checkbox plus count/expansion/final inputs seeded from the globals. Edit one surface (e.g. count 6, expansion 1.3, final 0.4). The debounced autosave (~800 ms) `PUT /meshing/:id/config` returns 200; confirm the body carries `addLayers.perSurface` with the edited surface's values and the others at the globals.
2. Reload → the edited per-surface values persist.
3. **cfMesh** session with discovered patches: Advanced → enable layers → the **Per-patch layers** table lists one row per patch seeded from the globals. Edit one patch (count 5, ratio 1.4, max-first 0.01). Autosave 200; body carries `addLayers.perPatch` with that patch's values.
4. Reload → cfMesh per-patch values persist. No console errors from either form.

- [ ] **Step 3: Stop the dev server (only if this task started it)**

If Step 2 started the dev server, stop that background task (TaskStop). If it was already running, leave it.

- [ ] **Step 4: Append the PLAN.md changelog entry**

Append at the very end of `PLAN.md`, matching the French, bolded-label style:

```markdown

#### Feature — Meshing : couches limites par patch/STL (snappy + cfMesh) [ts] (2026-08-11)
Demande user : rendre l'ajout des couches limites (prism layers) réglable **par patch/STL** (et pas un paramètre global) — **nombre de couches + croissance + épaisseur** — pour **les deux moteurs**. Spec+plan : `docs/superpowers/specs/2026-08-11-per-patch-layers-design.md`, `docs/superpowers/plans/2026-08-11-per-patch-layers.md`. **Décisions** (brainstorming) : tous les paramètres de couche par patch, sur snappy ET cfMesh ; **`relativeSizes` reste global** (switch unique de `addLayersControls`, pas d'équivalent par-région dans OpenFOAM) ; on **calque le motif d'override** (`surfaceRefinements` / `featureRefinements` / `patchTypes`) — globaux = défauts, map d'overrides optionnelle, patch absent → globaux. **Shared** (`index.ts`) : `SurfaceLayerSpec { nLayers; expansionRatio; finalLayerThickness }` + `AddLayersConfig.perSurface?` ; `CfMeshPatchLayerSpec { nLayers; thicknessRatio; maxFirstLayerThickness }` + `CfMeshLayersConfig.perPatch?`. Défauts inchangés. **API** (`meshing.schemas.ts`) : `perSurface` (record `{ nLayers 1–20, expansionRatio 1–5, finalLayerThickness >0 }`) et `perPatch` (record `{ nLayers 1–20, thicknessRatio 1–5, maxFirstLayerThickness >0|null }`), optionnels. **Renderers** : snappy (`snappyDicts.ts`) — le bloc `layers { region { … } }` émet `nSurfaceLayers + expansionRatio + finalLayerThickness` **si** override, sinon `{ nSurfaceLayers <global>; }` (dict inchangé sans override) ; cfMesh (`cfMeshDicts.ts`) — sous-bloc natif `patchBoundaryLayers { "patch" { … } }` **uniquement** si `perPatch` non vide (sinon aucun bloc, inchangé). **Web** : `SnappyConfigForm.tsx` — la liste « Grow layers on » devient une table par surface (on/off + 3 champs, préremplis aux globaux, écrits dans `perSurface`) ; `CfMeshConfigForm.tsx` — nouvelle table « Per-patch layers » (count + ratio + max first, préremplis, écrits dans `perPatch`), clé = nom de patch comme `patchTypes` ; `types.ts` ré-exporte les deux specs. **Rétro-compat** : config sans `perSurface`/`perPatch` → globaux, dict byte-identique ; `relativeSizes` inchangé. **Gates** : `meshing.test.ts` + `snappyDicts.test.ts` + `cfMeshDicts.test.ts` verts (schéma over/undefined/hors-borne ; renderers par-patch + cas sans override inchangés). **Vérifié navigateur** : snappy — table par surface, override transmis dans `perSurface` (autosave 200) et persistant ; cfMesh — table par patch, override dans `perPatch` (autosave 200) et persistant. Non commité en attente de revue app.
```

- [ ] **Step 5: Commit**

```bash
git add PLAN.md
git commit -m "docs(meshing): log per-patch boundary layers in PLAN.md"
```

---

## Self-Review Notes

- **Spec coverage:** data model (`SurfaceLayerSpec`/`perSurface`, `CfMeshPatchLayerSpec`/`perPatch`) → Task 1; validation → Task 2; snappy per-region render → Task 3; cfMesh `patchBoundaryLayers` render → Task 4; snappy per-surface UI → Task 5; cfMesh per-patch UI → Task 6; backward-compat + `relativeSizes`-global + tests → asserted across Tasks 3/4/7. All covered.
- **Type/name consistency:** `SurfaceLayerSpec { nLayers; expansionRatio; finalLayerThickness }` and `CfMeshPatchLayerSpec { nLayers; thicknessRatio; maxFirstLayerThickness }` are used identically in shared, schema, renderers, and both web forms (`perSurface` / `perPatch`). Web state uses the short input shapes `LayerSpecInput {n;exp;final}` / `PatchLayerInput {n;ratio;maxFirst}`, converted to the shared spec in each config memo. `fmt` exists in both renderers already.
- **Placeholder scan:** none — every code step carries the literal diff and every command its expected output.
- **Ordering:** shared (Task 1) precedes schema (2) and renderers (3–4); the web builds (Tasks 5–6 Step 6) catch type drift before the browser gate (Task 7). Task 5 and Task 6 both re-export from `types.ts` and edit different form files — no conflict.
- **Interaction with the feature-edge task already on the branch:** Task 5's memo edits reference the `featureScalar`/`setFeat` additions from the shipped feature-edge feature; the insertion points ("after the `setFeat` helper", "after the `featureScalar` block") are anchored to that code, which is already present on `feat/chamber-creation`.
