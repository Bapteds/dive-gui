# Per-Patch Override Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the per-patch controls a real "off/inherit" state. (A) cfMesh per-patch layers become Inherit-vs-Custom — an un-overridden patch falls back to the global block. (B) snappy per-surface feature edges get an on/off toggle — an off surface is excluded from extraction AND refinement.

**Architecture:** Part A is web-only (`CfMeshConfigForm.tsx`) — the cfMesh renderer already inherits-on-absence, so the fix is to stop the form writing every patch. Part B mirrors the boundary-layer `surfaces[]` gate for feature edges: a new optional `SnappyConfig.featureSurfaces` list flows shared → schema → both snappy renderer sites → the snappy form.

**Tech Stack:** TypeScript monorepo — `@dive/shared` (types), `@dive/api` (Zod + pure dict renderers, Vitest), `@dive/web` (React). No OpenFOAM toolchain touched.

## Global Constraints

- **cfMesh layers = two states only:** Inherit (no `perPatch` entry) or Custom (entry written). No per-patch "disable layers" — the global "Add boundary layers" checkbox still governs layering. Default for a row = Inherit.
- **snappy feature edges OFF = no feature edges at all:** an off surface is excluded from `surfaceFeatureExtractDict` (no block, no eMesh) AND from the `snappyHexMeshDict` `features` list. `featureSurfaces` omitted/empty ⇒ EVERY surface on (legacy default) ⇒ dicts byte-identical to today.
- **snappy per-surface layers unchanged** — do not touch `surfaces[]`, `perSurface`, or the layers table.
- Keying: `featureSurfaces` by STL file name (like `addLayers.surfaces`); cfMesh `perPatch` by patch name (unchanged).
- Spec: `docs/superpowers/specs/2026-08-11-per-patch-toggles-design.md`.

---

### Task 1: Shared — `SnappyConfig.featureSurfaces`

**Files:**
- Modify: `packages/shared/src/index.ts` (add `featureSurfaces?` to `SnappyConfig`, next to `featureRefinements`)

**Interfaces:**
- Produces: `SnappyConfig.featureSurfaces?: string[]`. `DEFAULT_SNAPPY_CONFIG` unchanged (no key ⇒ all surfaces on).

- [ ] **Step 1: Add the field**

In `packages/shared/src/index.ts`, find the `featureRefinements` field on `SnappyConfig`:

```ts
  /** Per-STL feature overrides keyed by file name; absent key => the two globals above. */
  featureRefinements?: Record<string, FeatureRefinement>;
```

and add immediately after it:

```ts
  /**
   * STL surfaces (by file name) whose feature edges are extracted + refined. Omitted
   * or empty means EVERY surface (legacy default), so an old config keeps working. A
   * surface not in this list is excluded from surfaceFeatureExtractDict AND from the
   * snappyHexMeshDict `features` list — its edges are not captured.
   */
  featureSurfaces?: string[];
```

- [ ] **Step 2: Build shared**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared"
```

(PowerShell tool.) Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(meshing): shared featureSurfaces on/off gate for snappy feature edges"
```

---

### Task 2: API schema — `featureSurfaces`

**Files:**
- Modify: `apps/api/src/modules/meshing/meshing.schemas.ts` (add `featureSurfaces` to `runSnappySchema`, next to `featureRefinements`)
- Test: `apps/api/tests/meshing.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `runSnappySchema.featureSurfaces` — `z.array(z.string()).optional()`.

- [ ] **Step 1: Write the failing test**

In `apps/api/tests/meshing.test.ts`, append:

```ts
describe('runSnappySchema — feature surfaces gate', () => {
  const base = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };

  it('accepts a featureSurfaces list', () => {
    const parsed = runSnappySchema.parse({ ...base, featureSurfaces: ['rotor.stl'] });
    expect(parsed.featureSurfaces).toEqual(['rotor.stl']);
  });

  it('leaves featureSurfaces undefined when omitted', () => {
    expect(runSnappySchema.parse(base).featureSurfaces).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'feature surfaces gate'"
```

(PowerShell tool.) Expected: FAIL — the accept case gets `featureSurfaces: undefined` (unknown key stripped).

- [ ] **Step 3: Add the schema field**

In `apps/api/src/modules/meshing/meshing.schemas.ts`, find in `runSnappySchema`:

```ts
  featureRefinements: z.record(z.string(), featureRefinementSchema).optional(),
```

and add immediately after it:

```ts
  // Surfaces (STL file names) whose feature edges are extracted+refined; omitted/empty ⇒ all.
  featureSurfaces: z.array(z.string()).optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- meshing.test.ts -t 'feature surfaces gate'"
```

(PowerShell tool.) Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/meshing/meshing.schemas.ts apps/api/tests/meshing.test.ts
git commit -m "feat(meshing): validate snappy featureSurfaces gate"
```

---

### Task 3: snappy renderers gate both feature sites on `featureSurfaces`

**Files:**
- Modify: `apps/api/src/lib/snappyDicts.ts` (add a `featureEdgesOn` helper; gate `renderSurfaceFeatureExtractDict` blocks and `renderSnappyHexMeshDict` features list)
- Test: `apps/api/tests/snappyDicts.test.ts`

**Interfaces:**
- Consumes: `SnappyConfig.featureSurfaces` (Task 1).
- Produces: a surface absent from `featureSurfaces` (when the list is non-empty) is excluded from both the extraction dict and the `features` eMesh list. Empty/absent list ⇒ every surface included (unchanged).

- [ ] **Step 1: Write the failing tests**

In `apps/api/tests/snappyDicts.test.ts`, append inside `describe('dict renderers', …)`:

```ts
  it('excludes a surface turned off in featureSurfaces from the extraction dict', () => {
    const dict = renderSurfaceFeatureExtractDict(
      ['rotor.stl', 'stator.stl'],
      config({ featureSurfaces: ['rotor.stl'] }),
    );
    expect(dict).toContain('rotor.stl');
    expect(dict).not.toContain('stator.stl');
  });

  it('excludes an off surface from the snappy features list', () => {
    const dict = renderSnappyHexMeshDict(
      ['rotor.stl', 'stator.stl'],
      domain,
      config({ featureSurfaces: ['rotor.stl'] }),
    );
    expect(dict).toContain('file "rotor.eMesh"');
    expect(dict).not.toContain('stator.eMesh');
  });

  it('includes every surface when featureSurfaces is empty (legacy default)', () => {
    const dict = renderSurfaceFeatureExtractDict(['rotor.stl', 'stator.stl'], config({ featureSurfaces: [] }));
    expect(dict).toContain('rotor.stl');
    expect(dict).toContain('stator.stl');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts -t 'featureSurfaces\|off surface\|turned off'"
```

(PowerShell tool.) Expected: FAIL — both renderers currently emit every surface, so the `not.toContain('stator…')` assertions fail.

- [ ] **Step 3: Add the `featureEdgesOn` helper**

In `apps/api/src/lib/snappyDicts.ts`, immediately after the `minLayerThickness` helper (ends around line 18), add:

```ts
/** Whether a surface's feature edges are extracted + refined. An omitted or empty
 *  featureSurfaces list means every surface (legacy default). */
function featureEdgesOn(config: SnappyConfig, file: string): boolean {
  const chosen = config.featureSurfaces;
  return !chosen || chosen.length === 0 || chosen.includes(file);
}
```

- [ ] **Step 4: Gate the extraction dict**

In `renderSurfaceFeatureExtractDict`, change the `.map(` chain to filter first. Replace:

```ts
  const blocks = stlNames
    .map((name) => {
      const angle = config.featureRefinements?.[name]?.includedAngle ?? config.featureAngle;
```

with:

```ts
  const blocks = stlNames
    .filter((name) => featureEdgesOn(config, name))
    .map((name) => {
      const angle = config.featureRefinements?.[name]?.includedAngle ?? config.featureAngle;
```

- [ ] **Step 5: Gate the snappy features list**

In `renderSnappyHexMeshDict`, replace the `features` builder:

```ts
  const features = regions
    .map((r) => {
      const level = config.featureRefinements?.[r.file]?.level ?? config.featureLevel;
      return `        { file "${r.emesh}"; level ${level}; }`;
    })
    .join('\n');
```

with:

```ts
  const features = regions
    .filter((r) => featureEdgesOn(config, r.file))
    .map((r) => {
      const level = config.featureRefinements?.[r.file]?.level ?? config.featureLevel;
      return `        { file "${r.emesh}"; level ${level}; }`;
    })
    .join('\n');
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run test -w @dive/api -- snappyDicts.test.ts"
```

(PowerShell tool.) Expected: PASS (all snappyDicts tests, incl. the 3 new; the existing all-on tests still pass since absent `featureSurfaces` ⇒ every surface).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/snappyDicts.ts apps/api/tests/snappyDicts.test.ts
git commit -m "feat(meshing): snappy renderers gate feature edges on featureSurfaces"
```

---

### Task 4: snappy web form — per-surface feature on/off

**Files:**
- Modify: `apps/web/src/features/meshing/SnappyConfigForm.tsx`

**Interfaces:**
- Consumes: `SnappyConfig.featureSurfaces` (Task 1).
- Produces: the form writes `featureSurfaces` = the checked feature rows. Off rows disable their angle/level inputs. Backward-compatible seeding (absent/empty ⇒ all on).

- [ ] **Step 1: Add the feature-surface on/off seed helper**

In `SnappyConfigForm.tsx`, immediately after the `seedFeatures` helper (ends line 87), add:

```ts
/** Which surfaces have feature edges ON. Seeds from featureSurfaces (absent/empty ⇒ all on). */
function seedFeatureSurfaces(stls: StlFile[], initial: SnappyConfig | null): Record<string, boolean> {
  const chosen = initial?.featureSurfaces;
  const all = !chosen || chosen.length === 0;
  const map: Record<string, boolean> = {};
  for (const stl of stls) map[stl.name] = all ? true : chosen.includes(stl.name);
  return map;
}
```

- [ ] **Step 2: Add state**

After the `features` state declaration (line 158, `const [features, setFeatures] = …`), add:

```ts
  const [featureSurfaceOn, setFeatureSurfaceOn] = useState<Record<string, boolean>>(() =>
    seedFeatureSurfaces(stls, initialConfig),
  );
```

- [ ] **Step 3: Sync with the STL set**

In the `stlKey` sync effect, immediately after the `setFeatures((prev) => {…})` block (ends line 217), add:

```ts
    // Feature on/off: a new surface defaults to ON (feature edges captured).
    setFeatureSurfaceOn((prev) => {
      const next: Record<string, boolean> = {};
      for (const stl of stls) next[stl.name] = prev[stl.name] ?? true;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 4: Build `featureSurfaces` + add the memo dep**

In the `config` memo's returned object, find:

```ts
      featureRefinements,
      locationInMesh: location && location.every(Number.isFinite) ? location : null,
```

and insert between them:

```ts
      featureRefinements,
      featureSurfaces: stls.map((s) => s.name).filter((name) => featureSurfaceOn[name] ?? true),
      locationInMesh: location && location.every(Number.isFinite) ? location : null,
```

Then add `featureSurfaceOn` to the memo dependency array (line 334, next to `features`):

```ts
    domainType, cellSize, refinements, margin, features, featureSurfaceOn, layersOn, layerSurfaceOn, layerSpecs, nLayers,
```

- [ ] **Step 5: Add the on/off checkbox to each feature row**

In the feature-edges table, replace the row block (lines 497-527, the `{stls.map((stl) => { const f = … return ( <div…> … </div> ); })}`):

```tsx
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
```

with:

```tsx
                    {stls.map((stl) => {
                      const on = featureSurfaceOn[stl.name] ?? true;
                      const f = features[stl.name] ?? { angle: '150', level: '2' };
                      return (
                        <div key={stl.name} className="flex flex-wrap items-center gap-2">
                          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text" title={stl.name}>
                            <input
                              type="checkbox"
                              className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                              checked={on}
                              onChange={(e) =>
                                setFeatureSurfaceOn((prev) => ({ ...prev, [stl.name]: e.target.checked }))
                              }
                            />
                            <span className="min-w-0 truncate">{stl.name}</span>
                          </label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              min="0"
                              max="180"
                              step="any"
                              disabled={!on}
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
                              disabled={!on}
                              aria-label={`${stl.name} feature refinement level`}
                              className="w-20"
                              value={f.level}
                              onChange={(e) => setFeat(stl.name, 'level', e.target.value)}
                            />
                          </div>
                        </div>
                      );
                    })}
```

Update the helper caption (line 531-533) to mention the toggle — replace:

```tsx
                <p className="text-xs text-text-secondary">
                  Angle: sharper-than-this edges are extracted (default 150°). Level: octree refinement near them (default 2).
                </p>
```

with:

```tsx
                <p className="text-xs text-text-secondary">
                  Untick a surface to skip its feature edges entirely. Angle: sharper-than-this edges are
                  extracted (default 150°). Level: octree refinement near them (default 2).
                </p>
```

- [ ] **Step 6: Type-check + build**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build -w @dive/web"
```

(PowerShell tool.) Expected: tsc + Vite build clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/meshing/SnappyConfigForm.tsx
git commit -m "feat(meshing): per-surface feature-edge on/off toggle in the snappy form"
```

---

### Task 5: cfMesh web form — per-patch Inherit vs Custom

**Files:**
- Modify: `apps/web/src/features/meshing/CfMeshConfigForm.tsx`

**Interfaces:**
- Consumes: existing `CfMeshLayersConfig.perPatch` (unchanged). No shared/schema/renderer change — the renderer already inherits the global for patches absent from `perPatch`.
- Produces: the form writes a `perPatch` entry ONLY for patches whose Override checkbox is on; unchecked patches inherit the global block.

- [ ] **Step 1: Add the override-on state**

In `CfMeshConfigForm.tsx`, after the `patchLayers` state (line 133), add:

```ts
  // Which patches use a CUSTOM per-patch layer override (vs inherit the global block).
  // Seeds on iff the saved config carried a perPatch entry for the patch.
  const [patchLayerOn, setPatchLayerOn] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of patches) map[p.name] = !!init.addLayers.perPatch?.[p.name];
    return map;
  });
```

- [ ] **Step 2: Sync with the patch set**

In the `patchKey` sync effect, immediately after the `setPatchLayers((prev) => {…})` block (ends line 163), add:

```ts
    setPatchLayerOn((prev) => {
      const next: Record<string, boolean> = {};
      for (const p of patches) next[p.name] = prev[p.name] ?? false;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
```

- [ ] **Step 3: Gate the `perPatch` build + add the memo dep**

In the `config` memo, replace the `perPatch` build loop (lines 185-193):

```ts
    const perPatch: Record<string, CfMeshPatchLayerSpec> = {};
    for (const p of patches) {
      const s = patchLayers[p.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
      perPatch[p.name] = {
        nLayers: Math.max(1, Math.round(Number(s.n) || DEFAULT_CFMESH_CONFIG.addLayers.nLayers)),
        thicknessRatio: Math.max(1, Number(s.ratio) || DEFAULT_CFMESH_CONFIG.addLayers.thicknessRatio),
        maxFirstLayerThickness: parseSize(s.maxFirst),
      };
    }
```

with:

```ts
    // Only patches with the Override box ticked get a perPatch entry; the rest inherit
    // the global boundaryLayers block (the renderer emits patchBoundaryLayers only for
    // patches present here).
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

Then add `patchLayerOn` to the memo dependency array (line 213, next to `patchLayers`):

```ts
    layersOn, nLayers, thicknessRatio, maxFirstLayer, patchLayers, patchLayerOn, patches, cores, maxCores,
```

- [ ] **Step 4: Add the Override checkbox to each per-patch row + disable inputs when off**

In the Per-patch layers table, replace the row block (lines 436-466, `{patches.map((patch) => { const s = … return ( <div…> … </div> ); })}`):

```tsx
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
```

with:

```tsx
                        {patches.map((patch) => {
                          const on = patchLayerOn[patch.name] ?? false;
                          const s = patchLayers[patch.name] ?? { n: '3', ratio: '1.2', maxFirst: '' };
                          return (
                            <div key={patch.name} className="flex flex-wrap items-center gap-2">
                              <label className="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm text-text" title={patch.name} translate="no">
                                <input
                                  type="checkbox"
                                  className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                                  checked={on}
                                  onChange={(e) => setPatchLayerOn((prev) => ({ ...prev, [patch.name]: e.target.checked }))}
                                />
                                <span className="min-w-0 truncate">{patch.name}</span>
                              </label>
                              <div className="flex items-center gap-1.5">
                                <Input
                                  type="number" min="1" step="1" className="w-16"
                                  disabled={!on}
                                  aria-label={`${patch.name} number of layers`}
                                  value={s.n}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], n: e.target.value } }))}
                                />
                                <Input
                                  type="number" min="1" step="any" className="w-16"
                                  disabled={!on}
                                  aria-label={`${patch.name} thickness ratio`}
                                  value={s.ratio}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], ratio: e.target.value } }))}
                                />
                                <Input
                                  type="number" min="0" step="any" className="w-20"
                                  placeholder="auto"
                                  disabled={!on}
                                  aria-label={`${patch.name} max first layer thickness`}
                                  value={s.maxFirst}
                                  onChange={(e) => setPatchLayers((prev) => ({ ...prev, [patch.name]: { ...prev[patch.name], maxFirst: e.target.value } }))}
                                />
                              </div>
                            </div>
                          );
                        })}
```

Update the caption (lines 431-434) to describe inherit-vs-custom — replace:

```tsx
                      <p className="text-xs text-text-secondary">
                        Override count · thickness ratio · max first-layer per patch (blank max = auto). Rows left at
                        the defaults above still send those values.
                      </p>
```

with:

```tsx
                      <p className="text-xs text-text-secondary">
                        Tick a patch to override the global layers for it (count · thickness ratio · max first-layer,
                        blank max = auto). Unticked patches inherit the global settings above.
                      </p>
```

- [ ] **Step 5: Type-check + build**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build -w @dive/web"
```

(PowerShell tool.) Expected: tsc + Vite build clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/meshing/CfMeshConfigForm.tsx
git commit -m "feat(meshing): cfMesh per-patch layers Inherit vs Custom toggle"
```

---

### Task 6: Gates, browser verify, PLAN.md changelog

**Files:**
- Read-only verification (no source changes)
- Modify: `PLAN.md` (append changelog entry per CLAUDE.md §0)

**Interfaces:**
- Consumes: Tasks 1–5.

- [ ] **Step 1: Full API test gate**

```bash
wsl.exe -e bash -lc "cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && npm run build:shared && npm run test -w @dive/api -- meshing.test.ts snappyDicts.test.ts cfMeshDicts.test.ts"
```

(PowerShell tool.) Expected: all green — new schema + renderer cases plus every pre-existing test.

- [ ] **Step 2: Browser review**

Ensure the dev server is up (ports 4000/5173); the API `.env` now sets `OPENFOAM_BASHRC`, so any relaunch works. If it must be started, use the PowerShell tool `run_in_background: true`:

```
wsl.exe -e bash -lc "source /usr/lib/openfoam/openfoam2606/etc/bashrc && cd /mnt/c/Users/Hristo.Dimitrov/Desktop/dive-gui && exec npm run dev > /tmp/dive-dev.log 2>&1"
```

Poll `/tmp/dive-dev.log` for `Local: http://localhost:5173/` and `API listening on http://localhost:4000`. (Vite on `/mnt/c` misses file-watch events — if the UI serves stale code, restart the dev tree.) Then, using the Browser tool (log in with `admin@dive-turbinen.de` / `ChangeMe!2026` if prompted):

1. **snappy** session (≥1 STL) → Advanced → the feature-edges table now shows an on/off checkbox per surface. Untick one surface; its angle/level inputs disable. Autosave `PUT /meshing/:id/config` 200; body's `featureSurfaces` omits the unticked surface.
2. Reload → the unticked surface stays off.
3. **cfMesh** session (discovered patches) → Advanced → enable layers → the Per-patch layers rows each have an Override checkbox, default UNticked, value inputs disabled. Tick one patch, set values; autosave body's `addLayers.perPatch` contains ONLY that patch. Untick it → `perPatch` becomes `undefined` (or omits it).
4. Reload → the ticked patch persists as custom; the rest inherit. No console errors from either form (a `/mesh/manifest` 502 from the pyvista-less 3D viewer is pre-existing and unrelated).

- [ ] **Step 3: Stop the dev server (only if this task started it)**

If Step 2 started the dev server, stop that background task; else leave it.

- [ ] **Step 4: Append the PLAN.md changelog entry**

Append at the end of `PLAN.md`, matching the French, bolded-label style:

```markdown

#### Feature — Meshing : bascules d'override par patch (cfMesh inherit/custom, snappy feature edges on/off) [ts] (2026-08-11)
Demande user : (A) sur cfMesh, pouvoir **retirer l'override local** d'un patch pour que le **global reprenne la main** (les deux — global + local — coexistaient sans moyen d'hériter) ; (B) sur snappy, pouvoir **cocher/décocher les feature edges par surface**. Spec+plan : `docs/superpowers/specs/2026-08-11-per-patch-toggles-design.md`, `docs/superpowers/plans/2026-08-11-per-patch-toggles.md`. **Décisions** (brainstorming) : cfMesh = 2 états par ligne **Inherit / Custom** (pas de « désactiver les couches » par patch) ; snappy feature edges OFF = **aucune** arête (exclue de l'extraction ET du raffinement) ; couches snappy inchangées. **Part A (cfMesh, web-only)** : le renderer héritait déjà le global pour un patch absent de `perPatch` ; le défaut était que le formulaire écrivait TOUS les patchs. `CfMeshConfigForm.tsx` : case **Override** par ligne (défaut décochée = inherit), inputs désactivés si décochée, `perPatch` ne reçoit que les lignes cochées (`Object.keys(perPatch).length>0 ? … : undefined`). Aucun changement shared/schema/renderer. **Part B (snappy)** : nouveau `SnappyConfig.featureSurfaces?: string[]` (omis/vide ⇒ toutes, rétro-compat). `meshing.schemas.ts` : `featureSurfaces` (array optionnel). `snappyDicts.ts` : helper `featureEdgesOn(config,file)` ; `renderSurfaceFeatureExtractDict` filtre ses blocs, la liste `features` de `renderSnappyHexMeshDict` filtre ses entrées eMesh — une surface OFF n'a ni bloc d'extraction ni raffinement. `SnappyConfigForm.tsx` : case on/off par ligne de la table feature edges (défaut ON), inputs angle/level désactivés si OFF, écrit `featureSurfaces`. **Rétro-compat** : `featureSurfaces` absent ⇒ dicts byte-identiques ; anciens configs cfMesh (perPatch pour tous) se seedent en « custom » égal au global → maillage identique jusqu'à re-save. **Gates** : `meshing.test.ts` + `snappyDicts.test.ts` + `cfMeshDicts.test.ts` verts. **Vérifié navigateur** : snappy — décocher une surface l'exclut de `featureSurfaces` (autosave 200) et persiste ; cfMesh — cocher un patch l'ajoute seul à `perPatch`, décocher le retire (inherit), persistant. **Note infra (hors feature)** : `OPENFOAM_BASHRC` renseigné dans `apps/api/.env` (`/usr/lib/openfoam/openfoam2606/etc/bashrc`) pour que le runner source OpenFOAM quel que soit le shell de lancement (corrige les `spawn … ENOENT` blockMesh/surfaceFeatureEdges). Non commité en attente de revue app.
```

- [ ] **Step 5: Commit**

```bash
git add PLAN.md
git commit -m "docs(meshing): log per-patch override toggles in PLAN.md"
```

---

## Self-Review Notes

- **Spec coverage:** Part A (cfMesh Inherit/Custom, web-only) → Task 5; Part B model → Task 1, schema → Task 2, both renderer sites → Task 3, form on/off → Task 4; verification/backward-compat → Tasks 3/6. All covered.
- **Type/name consistency:** `featureSurfaces` is `string[]` across shared, schema, renderer (`featureEdgesOn`), and the form (`featureSurfaceOn` state → `featureSurfaces` on submit). cfMesh reuses the existing `perPatch`/`CfMeshPatchLayerSpec` unchanged; only `patchLayerOn` (boolean map) is added.
- **Placeholder scan:** none — every code step has the literal diff and every command its expected output.
- **Ordering:** shared (1) → schema (2) → renderer (3) → snappy form (4); Task 5 (cfMesh) is independent and edits a different file; Task 6 gates everything. The snappy-form and cfMesh-form edits are anchored to the current post-layers-feature code (line numbers verified against the working tree).
- **Backward-compat guard:** Task 3's third test asserts an empty `featureSurfaces` includes every surface, and the absent case is already covered by the existing all-on renderer tests — together they lock the byte-identical-when-unset property.
