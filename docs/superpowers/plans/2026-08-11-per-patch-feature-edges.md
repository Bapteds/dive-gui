# Per-Patch Feature-Edge Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make snappyHexMesh feature-edge extraction settable **per STL/patch** — both the `surfaceFeatureExtract` `includedAngle` (default 150°) and the snappy octree feature `level` (default 2) — instead of one global value for every patch. cfMesh stays global (its `featureAngle` default unchanged at 45°).

**Architecture:** One vertical slice through shared model → API Zod schema → snappy dict renderers → web form, snappy only. Mirrors the existing `surfaceRefinements` mechanism exactly: a global default pair plus an optional per-STL override map keyed by file name; a patch absent from the map falls back to the globals so every saved config keeps working.

**Tech Stack:** TypeScript monorepo — `@dive/shared` (types), `@dive/api` (Zod + pure dict renderers, Vitest), `@dive/web` (React + hooks). No OpenFOAM toolchain touched (renderers are pure and unit-tested; the run tests mock the toolchain).

## Global Constraints

- **snappy only.** cfMesh (`CfMeshConfig`, `runCfMeshSchema`, `cfMeshPipeline.ts`, `CfMeshConfigForm.tsx`) is byte-for-byte unchanged; its `featureAngle` default stays **45**.
- **Backward compatible.** A saved `SnappyConfig` without `featureAngle` → Zod default fills `150`; without `featureRefinements` → undefined, every patch uses the globals. With the pre-existing hardcoded angle of 150 and global level default of 2, output is byte-identical to today for any config that does not set per-patch overrides.
- **Mirror `surfaceRefinements`.** Same shape (`Record<string, …>` optional map + scalar global default), same form pattern (one row per STL seeded from the global default; the scalar global is derived from the first surface). Write **every** current STL into the map on submit, exactly as `surfaceRefinements` does — do not omit equal ones.
- Spec: `docs/superpowers/specs/2026-08-11-per-patch-feature-edges-design.md`.

---

### Task 1: Shared model — `FeatureRefinement`, `featureAngle`, `featureRefinements`

**Files:**
- Modify: `packages/shared/src/index.ts:869-917` (add interface + two `SnappyConfig` fields)
- Modify: `packages/shared/src/index.ts:919-938` (add `featureAngle` to `DEFAULT_SNAPPY_CONFIG`)

**Interfaces:**
- Consumes: existing `SnappyConfig`, `SurfaceRefinement`.
- Produces: `FeatureRefinement { includedAngle: number; level: number }`; `SnappyConfig.featureAngle: number`; `SnappyConfig.featureRefinements?: Record<string, FeatureRefinement>`; `DEFAULT_SNAPPY_CONFIG.featureAngle = 150`.

- [ ] **Step 1: Add the `FeatureRefinement` interface**

In `packages/shared/src/index.ts`, immediately before `export interface SnappyConfig {` (currently line 891), add:

```ts
/**
 * Per-patch feature-edge extraction override (snappy), keyed by STL file name.
 * Absent key => the config's global `featureAngle` / `featureLevel` are used.
 */
export interface FeatureRefinement {
  /** surfaceFeatureExtract includedAngle threshold in degrees (0–180). */
  includedAngle: number;
  /** snappy octree refinement level applied near the extracted edges (int 0–10). */
  level: number;
}

```

- [ ] **Step 2: Add the two fields to `SnappyConfig`**

In `SnappyConfig`, replace the single existing `featureLevel` line (currently `:903-904`):

```ts
  /** Feature-edge (eMesh) refinement level. */
  featureLevel: number;
```

with:

```ts
  /** Global default feature-edge (eMesh) refinement level; per-patch override wins. */
  featureLevel: number;
  /** Global default surfaceFeatureExtract includedAngle (deg); per-patch override wins. */
  featureAngle: number;
  /** Per-STL feature overrides keyed by file name; absent key => the two globals above. */
  featureRefinements?: Record<string, FeatureRefinement>;
```

- [ ] **Step 3: Add `featureAngle` to the default config**

In `DEFAULT_SNAPPY_CONFIG` (currently `:920-938`), add `featureAngle: 150` immediately after the `featureLevel: 2,` line:

```ts
  featureLevel: 2,
  featureAngle: 150,
```

- [ ] **Step 4: Build shared to verify the types compile**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared"
```

(PowerShell tool.) Expected: tsc emits with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(meshing): shared per-patch feature-edge model (featureAngle + featureRefinements)"
```

---

### Task 2: API schema — validate `featureAngle` + `featureRefinements`

**Files:**
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts:64-83` (add feature schema + two fields)
- Test: `apps/api/tests/meshing.test.ts` (add a schema-focused case near the existing snappy run tests)

**Interfaces:**
- Consumes: `FeatureRefinement` (Task 1).
- Produces: `runSnappySchema` accepts `featureAngle` (number 0–180, default 150) and `featureRefinements` (optional record of `{ includedAngle: 0–180, level: int 0–10 }`).

- [ ] **Step 1: Write the failing schema test**

In `apps/api/tests/meshing.test.ts`, add (import `runSnappySchema` from `../src/modules/meshing/meshing.schemas` if not already imported at the top of the file):

```ts
describe('runSnappySchema — per-patch feature edges', () => {
  const base = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };

  it('defaults featureAngle to 150 and leaves featureRefinements undefined', () => {
    const parsed = runSnappySchema.parse(base);
    expect(parsed.featureAngle).toBe(150);
    expect(parsed.featureRefinements).toBeUndefined();
  });

  it('accepts a per-patch feature override', () => {
    const parsed = runSnappySchema.parse({
      ...base,
      featureRefinements: { 'rotor.stl': { includedAngle: 120, level: 4 } },
    });
    expect(parsed.featureRefinements?.['rotor.stl']).toEqual({ includedAngle: 120, level: 4 });
  });

  it('rejects an out-of-range angle and a non-integer level', () => {
    expect(() =>
      runSnappySchema.parse({ ...base, featureRefinements: { 'r.stl': { includedAngle: 200, level: 2 } } }),
    ).toThrow();
    expect(() =>
      runSnappySchema.parse({ ...base, featureRefinements: { 'r.stl': { includedAngle: 90, level: 1.5 } } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'per-patch feature edges'"
```

(PowerShell tool.) Expected: FAIL — `featureAngle` is `undefined` (schema has no such field yet) and the override is stripped.

- [ ] **Step 3: Add the schema fields**

In `apps/api/src/modules/meshing/meshing.schemas.ts`, immediately after the `refinementSchema` definition (ends at `:73`) add:

```ts
/** A per-patch feature-edge override: extraction angle + snappy refinement level. */
const featureRefinementSchema = z.object({
  includedAngle: z.number().min(0).max(180),
  level: z.number().int().min(0).max(10),
});
```

Then in `runSnappySchema`, replace the single existing line (`:83`):

```ts
  featureLevel: z.number().int().min(0).max(10).default(2),
```

with:

```ts
  featureLevel: z.number().int().min(0).max(10).default(2),
  featureAngle: z.number().min(0).max(180).default(150),
  // Per-patch feature overrides keyed by STL file name; absent key => the globals above.
  featureRefinements: z.record(z.string(), featureRefinementSchema).optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'per-patch feature edges'"
```

(PowerShell tool.) Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/meshing/meshing.schemas.ts apps/api/tests/meshing.test.ts
git commit -m "feat(meshing): validate per-patch featureAngle + featureRefinements (snappy)"
```

---

### Task 3: snappy dict renderers read per-patch angle + level

**Files:**
- Modify: `apps/api/src/lib/snappyDicts.ts:236-252` (`renderSurfaceFeatureExtractDict` gains `config`, per-patch `includedAngle`)
- Modify: `apps/api/src/lib/snappyDicts.ts:271-273` (features block per-patch `level`)
- Modify: `apps/api/src/lib/snappyPipeline.ts:58` (pass `config` to the extract-dict renderer)
- Test: `apps/api/tests/snappyDicts.test.ts:64-69` (update signature) + new per-patch cases

**Interfaces:**
- Consumes: `SnappyConfig.featureAngle`, `SnappyConfig.featureRefinements` (Task 1). `SnappyConfig` is already imported by `snappyDicts.ts` (used by `renderSnappyHexMeshDict`).
- Produces: `renderSurfaceFeatureExtractDict(stlNames: string[], config: SnappyConfig): string` — each block's `includedAngle` = `config.featureRefinements?.[name]?.includedAngle ?? config.featureAngle`. `renderSnappyHexMeshDict`'s feature block `level` = `config.featureRefinements?.[r.file]?.level ?? config.featureLevel`.

- [ ] **Step 1: Update the existing extract-dict test call + add per-patch tests**

In `apps/api/tests/snappyDicts.test.ts`, replace the existing `renders one feature-extraction block per STL` test (`:64-69`) with:

```ts
  it('renders one feature-extraction block per STL at the global angle', () => {
    const dict = renderSurfaceFeatureExtractDict(['rotor.stl', 'stator.stl'], config());
    expect(dict).toContain('rotor.stl');
    expect(dict).toContain('stator.stl');
    expect(dict).toContain('extractFromSurface');
    // Global default angle 150 applied to every block.
    expect(dict).toContain('includedAngle 150;');
  });

  it('applies a per-patch includedAngle override, others at the global', () => {
    const dict = renderSurfaceFeatureExtractDict(
      ['rotor.stl', 'stator.stl'],
      config({ featureAngle: 150, featureRefinements: { 'rotor.stl': { includedAngle: 100, level: 2 } } }),
    );
    // rotor block carries 100; the stator block keeps the global 150.
    const rotorBlock = dict.slice(dict.indexOf('rotor.stl'), dict.indexOf('stator.stl'));
    expect(rotorBlock).toContain('includedAngle 100;');
    const statorBlock = dict.slice(dict.indexOf('stator.stl'));
    expect(statorBlock).toContain('includedAngle 150;');
  });

  it('applies a per-patch feature level override in the snappy dict', () => {
    const dict = renderSnappyHexMeshDict(
      ['rotor.stl', 'stator.stl'],
      domain,
      config({ featureLevel: 2, featureRefinements: { 'rotor.stl': { includedAngle: 150, level: 5 } } }),
    );
    expect(dict).toContain('file "rotor.eMesh"; level 5;');
    expect(dict).toContain('file "stator.eMesh"; level 2;');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts"
```

(PowerShell tool.) Expected: FAIL — `renderSurfaceFeatureExtractDict` currently takes one arg (TS/type error or the `config` arg ignored) and the per-patch angle/level are not emitted.

- [ ] **Step 3: Make `renderSurfaceFeatureExtractDict` per-patch**

In `apps/api/src/lib/snappyDicts.ts`, replace the function (`:236-252`):

```ts
/** surfaceFeatureExtractDict: one feature-extraction block per STL region. */
export function renderSurfaceFeatureExtractDict(stlNames: string[]): string {
  const blocks = stlNames
    .map(
      (name) => `${name}
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs { includedAngle 150; }
    subsetFeatures { nonManifoldEdges no; openEdges yes; }
    writeObj no;
}`,
    )
    .join('\n\n');
  return `${foamHeader('dictionary', 'surfaceFeatureExtractDict', 'system')}
${blocks}
${FOOTER}`;
}
```

with:

```ts
/** surfaceFeatureExtractDict: one feature-extraction block per STL region. The
 *  includedAngle is per-patch (featureRefinements) with the global featureAngle
 *  as the fallback for any surface with no override. */
export function renderSurfaceFeatureExtractDict(stlNames: string[], config: SnappyConfig): string {
  const blocks = stlNames
    .map((name) => {
      const angle = config.featureRefinements?.[name]?.includedAngle ?? config.featureAngle;
      return `${name}
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs { includedAngle ${angle}; }
    subsetFeatures { nonManifoldEdges no; openEdges yes; }
    writeObj no;
}`;
    })
    .join('\n\n');
  return `${foamHeader('dictionary', 'surfaceFeatureExtractDict', 'system')}
${blocks}
${FOOTER}`;
}
```

- [ ] **Step 4: Make the features block per-patch level**

In `renderSnappyHexMeshDict`, replace the `features` builder (`:271-273`):

```ts
  const features = regions
    .map((r) => `        { file "${r.emesh}"; level ${config.featureLevel}; }`)
    .join('\n');
```

with:

```ts
  const features = regions
    .map((r) => {
      const level = config.featureRefinements?.[r.file]?.level ?? config.featureLevel;
      return `        { file "${r.emesh}"; level ${level}; }`;
    })
    .join('\n');
```

- [ ] **Step 5: Pass `config` at the pipeline call site**

In `apps/api/src/lib/snappyPipeline.ts`, replace (`:58`):

```ts
      renderSurfaceFeatureExtractDict(stlNames),
```

with:

```ts
      renderSurfaceFeatureExtractDict(stlNames, config),
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts"
```

(PowerShell tool.) Expected: PASS (all dict-renderer tests, including the 3 new/updated feature cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/snappyDicts.ts apps/api/src/lib/snappyPipeline.ts apps/api/tests/snappyDicts.test.ts
git commit -m "feat(meshing): snappy renderers apply per-patch feature angle + level"
```

---

### Task 4: Web form — per-surface feature angle + level table

**Files:**
- Modify: `apps/web/src/features/meshing/SnappyConfigForm.tsx` — add feature map type/seed/state/sync/config-build and swap the single "Feature-edge level" field for a per-surface table.

**Interfaces:**
- Consumes: `SnappyConfig.featureAngle`, `SnappyConfig.featureRefinements`, `FeatureRefinement`, `DEFAULT_SNAPPY_CONFIG.featureAngle` (Task 1).
- Produces: on submit the form writes `featureAngle` (scalar, from the first surface or the default), `featureLevel` (scalar, same), and `featureRefinements` (every current STL → `{ includedAngle, level }`). Mirrors the `surfaceRefinements` build already in this file.

- [ ] **Step 1: Add the feature map type + seed helper**

In `SnappyConfigForm.tsx`, immediately after `type RefinementMap = Record<string, RefinementInput>;` (`:64`) add:

```ts
type FeatureInput = { angle: string; level: string };
type FeatureMap = Record<string, FeatureInput>;

/** Seed the per-surface feature map from the last run (or the global defaults). */
function seedFeatures(stls: StlFile[], initial: SnappyConfig | null): FeatureMap {
  const gAngle = initial?.featureAngle ?? DEFAULT_SNAPPY_CONFIG.featureAngle;
  const gLevel = initial?.featureLevel ?? DEFAULT_SNAPPY_CONFIG.featureLevel;
  const map: FeatureMap = {};
  for (const stl of stls) {
    const f = initial?.featureRefinements?.[stl.name];
    map[stl.name] = { angle: String(f?.includedAngle ?? gAngle), level: String(f?.level ?? gLevel) };
  }
  return map;
}
```

- [ ] **Step 2: Replace the `featureLevel` scalar state with the feature map state**

Replace the state line (`:117`):

```ts
  const [featureLevel, setFeatureLevel] = useState(String(init.featureLevel));
```

with:

```ts
  const [features, setFeatures] = useState<FeatureMap>(() => seedFeatures(stls, initialConfig));
```

- [ ] **Step 3: Keep the feature map in sync with the STL set**

In the `useEffect` keyed on `stlKey` (`:144-166`), immediately after the `setLayerSurfaceOn((prev) => { … })` block and before the closing `}, [stlKey]);`, add a third sync:

```ts
    // Same sync for the per-surface feature map: a new surface defaults to globals.
    setFeatures((prev) => {
      const gAngle = String(DEFAULT_SNAPPY_CONFIG.featureAngle);
      const gLevel = String(DEFAULT_SNAPPY_CONFIG.featureLevel);
      const next: FeatureMap = {};
      for (const stl of stls) next[stl.name] = prev[stl.name] ?? { angle: gAngle, level: gLevel };
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 4: Add a `setFeat` updater next to `setRef`**

Immediately after the `setRef` helper (`:185-187`) add:

```ts
  const setFeat = (name: string, key: 'angle' | 'level', value: string) => {
    setFeatures((prev) => ({ ...prev, [name]: { ...prev[name], [key]: value } }));
  };
```

- [ ] **Step 5: Build `featureRefinements` + scalar globals in the config memo**

In the `config` memo, replace the single line (`:217`):

```ts
      featureLevel: Math.max(0, Math.round(Number(featureLevel) || DEFAULT_SNAPPY_CONFIG.featureLevel)),
```

with:

```ts
      featureLevel: featureScalar.level,
      featureAngle: featureScalar.angle,
      featureRefinements,
```

and, immediately before the `return {` inside that memo (right after the `surfaceRefinement` const at `:207-208`), add:

```ts
    // Per-patch feature overrides, one entry per current STL (mirrors surfaceRefinements).
    const featureRefinements: Record<string, FeatureRefinement> = {};
    for (const stl of stls) {
      const f = features[stl.name] ?? { angle: '150', level: '2' };
      featureRefinements[stl.name] = {
        includedAngle: Math.min(180, Math.max(0, Number(f.angle) || DEFAULT_SNAPPY_CONFIG.featureAngle)),
        level: Math.max(0, Math.round(Number(f.level) || DEFAULT_SNAPPY_CONFIG.featureLevel)),
      };
    }
    // Scalar globals: the first surface's values, else the defaults (like surfaceRefinement).
    const featureScalar = (firstName && featureRefinements[firstName])
      ? featureRefinements[firstName]
      : { includedAngle: DEFAULT_SNAPPY_CONFIG.featureAngle, level: DEFAULT_SNAPPY_CONFIG.featureLevel };
```

Add the `FeatureRefinement` type to the existing `@dive/shared` import at the top of the file (it already imports `SnappyConfig`, `SurfaceRefinement`, `DEFAULT_SNAPPY_CONFIG`).

- [ ] **Step 6: Update the config memo dependency array**

In the memo deps (`:230-233`), replace `featureLevel` with `features`:

```ts
  }, [
    domainType, cellSize, refinements, margin, features, layersOn, layerSurfaceOn, nLayers,
    relativeSizes, finalThickness, expansionRatio, manualPoint, px, py, pz, cores, maxCores, stls,
  ]);
```

- [ ] **Step 7: Swap the single feature field for a per-surface table**

Replace the `Field label="Feature-edge level"` block (`:388-396`):

```tsx
              <Field label="Feature-edge level" helperText="Refinement on sharp edges.">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={featureLevel}
                  onChange={(e) => setFeatureLevel(e.target.value)}
                />
              </Field>
```

with a per-surface table (angle + level per STL):

```tsx
              <fieldset className="flex flex-col gap-2 sm:col-span-2">
                <legend className="text-sm font-medium text-text">Feature edges (per surface)</legend>
                {stls.length === 0 ? (
                  <p className="text-xs text-text-secondary">Upload a surface to set its feature edges.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {stls.map((stl) => {
                      const f = features[stl.name] ?? { angle: '150', level: '2' };
                      return (
                        <div key={stl.name} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-text" title={stl.name}>
                            {stl.name}
                          </span>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min="0"
                              max="180"
                              step="any"
                              aria-label={`${stl.name} feature angle (degrees)`}
                              className="w-20"
                              value={f.angle}
                              onChange={(e) => setFeat(stl.name, 'angle', e.target.value)}
                            />
                            <span className="text-sm text-text-secondary">°, level</span>
                            <Input
                              type="number"
                              min="0"
                              step="1"
                              aria-label={`${stl.name} feature refinement level`}
                              className="w-20"
                              value={f.level}
                              onChange={(e) => setFeat(stl.name, 'level', e.target.value)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-text-secondary">
                  Angle: sharper-than-this edges are extracted (default 150°). Level: octree refinement near them (default 2).
                </p>
              </fieldset>
```

- [ ] **Step 8: Type-check the web app**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build -w @dive/web"
```

(PowerShell tool.) Expected: `tsc` + Vite build succeed with no type errors (in particular no unused `featureLevel`/`setfeatureLevel` and `FeatureRefinement` resolves).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/meshing/SnappyConfigForm.tsx
git commit -m "feat(meshing): per-surface feature angle + level inputs in the snappy form"
```

---

### Task 5: Gates, browser verify, PLAN.md changelog

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the Definition-of-Done gate for the feature.

- [ ] **Step 1: Full API meshing + dict test gate**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshing.test.ts snappyDicts.test.ts"
```

(PowerShell tool.) Expected: all green — the new schema + renderer tests plus all pre-existing ones.

- [ ] **Step 2: Browser review — per-surface feature edges**

If the dev server is not already up (ports 4000/5173), start it via the PowerShell tool with `run_in_background: true`:

```
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && exec npm run dev > /tmp/dive-dev.log 2>&1"
```

Poll `/tmp/dive-dev.log` for `Local: http://localhost:5173/` and `API listening on http://localhost:4000`. Then, using the Browser tool, on a meshing session with the **snappy** engine and at least one STL uploaded (log in with `admin@dive-turbinen.de` / `ChangeMe!2026` if prompted):
1. Open the snappy config's Advanced disclosure → the **Feature edges (per surface)** table lists one row per STL, angle prefilled `150`, level prefilled `2`.
2. Change one surface's angle to `120` and level to `4`; leave the others.
3. Trigger the run/save (the debounced autosave fires ~800 ms after the edit). Confirm the request body carries `featureRefinements` with the edited surface at `{ includedAngle: 120, level: 4 }` (read the `POST /meshing/:id/run` or the autosave `PUT`/`PATCH` request via the browser network tool).
4. Reload the page → the edited values persist (seeded back from the saved config).
5. No console errors.

- [ ] **Step 3: Stop the dev server (only if this task started it)**

If Step 2 started the dev server, stop that background task (TaskStop with its id) and confirm ports 4000/5173 are free. If it was already running from a prior session, leave it.

- [ ] **Step 4: Append the PLAN.md changelog entry**

Append at the very end of `PLAN.md`, matching the file's French, bolded-label style:

```markdown

#### Feature — Meshing (snappy) : extraction des arêtes caractéristiques par patch/STL [ts] (2026-08-11)
Demande user : rendre l'extraction des feature edges réglable **par patch/STL** (et pas un paramètre global unique) — **angle** ET **niveau** ; angle par défaut **150°**, niveau par défaut **2** ; les deux ajustables. cfMesh reste global (son `featureAngle` garde son défaut **45°**). Spec+plan : `docs/superpowers/specs/2026-08-11-per-patch-feature-edges-design.md`, `docs/superpowers/plans/2026-08-11-per-patch-feature-edges.md`. **Décisions** (brainstorming) : snappy par-patch (chaque STL est déjà une région) ; cfMesh reste global (il fusionne les STL en une surface et n'a pas de notion de « level ») en gardant 45° ; on **calque le mécanisme `surfaceRefinements`** (défaut global scalaire + map d'overrides optionnelle `Record<string, …>` clé = nom de fichier STL ; patch absent → les globaux). **Shared** (`index.ts`) : nouvelle interface `FeatureRefinement { includedAngle; level }`, `SnappyConfig` gagne `featureAngle` (défaut 150) et `featureRefinements?`, `DEFAULT_SNAPPY_CONFIG.featureAngle = 150`. **API** (`meshing.schemas.ts`) : `featureAngle` (0–180, défaut 150) + `featureRefinements` (record de `{ includedAngle 0–180, level int 0–10 }`, optionnel). **Renderers** (`snappyDicts.ts`, `snappyPipeline.ts`) : `renderSurfaceFeatureExtractDict(stlNames, config)` — `includedAngle` par patch = `featureRefinements[name]?.includedAngle ?? featureAngle` (remplace le 150 codé en dur) ; le bloc `features { … level N }` de `snappyHexMeshDict` prend le `level` par patch. **Web** (`SnappyConfigForm.tsx`) : le champ unique « Feature-edge level » est remplacé par une **table par surface** (angle + level par STL, préremplis aux globaux), écrite dans `featureRefinements` au submit comme `surfaceRefinements` ; le scalaire global dérive de la première surface. **Rétro-compat** : un config sans `featureAngle` → défaut 150 ; sans `featureRefinements` → globaux ; géométrie identique à aujourd'hui (angle déjà 150, level déjà 2) tant qu'aucun override par patch n'est posé. **Aucun changement** cfMesh. **Gates** : `meshing.test.ts` + `snappyDicts.test.ts` verts (schéma défaut/override/hors-borne ; renderers angle+level par patch). **Vérifié navigateur** : table par surface affichée, override `120°/level 4` transmis dans `featureRefinements` et persistant au reload. Non commité en attente de revue app.
```

- [ ] **Step 5: Commit**

```bash
git add PLAN.md
git commit -m "docs(meshing): log per-patch feature-edge extraction in PLAN.md"
```

---

## Self-Review Notes

- **Spec coverage:** data model (`FeatureRefinement` + two `SnappyConfig` fields + default 150) → Task 1; validation → Task 2; per-patch angle in `surfaceFeatureExtractDict` + per-patch level in `snappyHexMeshDict` → Task 3; per-surface UI table seeded from globals, written like `surfaceRefinements` → Task 4; backward-compat + cfMesh-untouched + tests → asserted across Tasks 2/3/5. cfMesh explicitly out of scope (Global Constraints). All covered.
- **Type/name consistency:** `FeatureRefinement { includedAngle; level }` used identically in shared, schema (`featureRefinementSchema`), renderers (`featureRefinements?.[name]?.includedAngle`/`.level`), and the web build (`featureRefinements: Record<string, FeatureRefinement>`). `featureAngle` scalar default 150 everywhere; `featureLevel` scalar default 2 kept. The web memo introduces `featureRefinements`/`featureScalar` before the `return {` that references them, and swaps the `featureLevel` dep for `features` — no dangling `featureLevel`/`setFeatureLevel` after Step 2/7.
- **Placeholder scan:** none — every code step carries the literal diff and every command its expected output.
- **Ordering:** shared types (Task 1) precede the schema (Task 2) and renderers (Task 3) that consume them; the web build (Task 4 Step 8) catches any type drift before the browser gate (Task 5).
