import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Layers, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { DEFAULT_SNAPPY_CONFIG } from '@/lib/api/types';
import type { DomainType, MeshBounds, SnappyConfig, StlFile, SurfaceRefinement } from '@/lib/api/types';

/**
 * SnappyConfigForm - the snappyHexMesh tunables for one run. Surface refinement
 * is set PER STL surface; an Advanced disclosure reveals the keep-point,
 * background padding, feature level, CPU cores and boundary (prism) layers. One
 * orange CTA runs it.
 *
 * The form seeds from `initialConfig` (the session's autosaved config, else its
 * last run) so every setting survives a reload. Any edit is autosaved via a
 * debounced `onConfigChange`, so manual values persist even before a run — the
 * seed happens on mount only, so autosave never fights the cursor.
 *
 * `baseCellSize` empty and the manual keep-point off both send `null`, which the
 * server resolves from the STL bounds. When the bounds are known we mirror that
 * derivation here so the placeholders show the value the server will use. `cores`
 * is 1 (serial) up to `maxCores`; more cores run snappyHexMesh in parallel (MPI).
 */

/** Round for display without scientific notation. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Number(n.toPrecision(4)).toString();
}

/** Bounding-box diagonal length. */
function diagonalOf(b: MeshBounds): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The keep-point the server would derive (bbox centre / padded-box corner). */
function autoLocation(b: MeshBounds, domainType: DomainType, marginFactor: number): [number, number, number] {
  if (domainType === 'internal') {
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  }
  const pad = Math.max(0, marginFactor) * (diagonalOf(b) || 1);
  return [b.min[0] - pad * 0.99, b.min[1] - pad * 0.99, b.min[2] - pad * 0.99];
}

/** Clamp a core-count string to the integer range [1, max] (mirrors the solver panel). */
function clampCores(value: string, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, max));
}

/** The default cores for a fresh session: half the machine budget, at least 1. */
function defaultCores(max: number): number {
  return Math.max(1, Math.floor(Math.max(1, max) / 2));
}

/** Editable refinement (strings so a field can be cleared mid-edit). */
type RefinementInput = { min: string; max: string };
type RefinementMap = Record<string, RefinementInput>;

/** Seed the per-surface map from the last run (or defaults), covering every current STL. */
function seedRefinements(stls: StlFile[], initial: SnappyConfig | null): RefinementMap {
  const fallback = initial?.surfaceRefinement ?? DEFAULT_SNAPPY_CONFIG.surfaceRefinement;
  const map: RefinementMap = {};
  for (const stl of stls) {
    const r = initial?.surfaceRefinements?.[stl.name] ?? fallback;
    map[stl.name] = { min: String(r.min), max: String(r.max) };
  }
  return map;
}

/**
 * Which surfaces grow boundary layers, one flag per STL. Seeds from the saved
 * `addLayers.surfaces` (a legacy config with none means every surface is on).
 */
function seedLayerSurfaces(stls: StlFile[], initial: SnappyConfig | null): Record<string, boolean> {
  const chosen = initial?.addLayers.surfaces;
  const map: Record<string, boolean> = {};
  for (const stl of stls) {
    map[stl.name] = chosen ? chosen.includes(stl.name) : true;
  }
  return map;
}

export function SnappyConfigForm({
  stls,
  bounds,
  disabled,
  running,
  initialConfig,
  maxCores,
  onGenerate,
  onConfigChange,
}: {
  stls: StlFile[];
  bounds: MeshBounds | null;
  disabled: boolean;
  running: boolean;
  initialConfig: SnappyConfig | null;
  /** Max cores a run may request (the machine's core budget). */
  maxCores: number;
  onGenerate: (config: SnappyConfig) => void;
  /** Debounced autosave of the current config (persist without running). */
  onConfigChange?: (config: SnappyConfig) => void;
}) {
  const init = initialConfig ?? DEFAULT_SNAPPY_CONFIG;

  const [domainType, setDomainType] = useState<DomainType>(init.domainType);
  const [cellSize, setCellSize] = useState(init.baseCellSize ? String(init.baseCellSize) : '');
  const [refinements, setRefinements] = useState<RefinementMap>(() => seedRefinements(stls, initialConfig));
  const [marginFactor, setMarginFactor] = useState(String(init.marginFactor));
  const [featureLevel, setFeatureLevel] = useState(String(init.featureLevel));
  const [layersOn, setLayersOn] = useState(init.addLayers.enabled);
  const [layerSurfaceOn, setLayerSurfaceOn] = useState<Record<string, boolean>>(() =>
    seedLayerSurfaces(stls, initialConfig),
  );
  const [nLayers, setNLayers] = useState(String(init.addLayers.nLayers));
  const [relativeSizes, setRelativeSizes] = useState(init.addLayers.relativeSizes);
  const [finalThickness, setFinalThickness] = useState(String(init.addLayers.finalLayerThickness));
  const [expansionRatio, setExpansionRatio] = useState(String(init.addLayers.expansionRatio));
  const [manualPoint, setManualPoint] = useState(init.locationInMesh != null);
  const [px, setPx] = useState(init.locationInMesh ? fmt(init.locationInMesh[0]) : '');
  const [py, setPy] = useState(init.locationInMesh ? fmt(init.locationInMesh[1]) : '');
  const [pz, setPz] = useState(init.locationInMesh ? fmt(init.locationInMesh[2]) : '');
  // Seed cores from the saved config (a pre-cores config has none -> half budget).
  const [cores, setCores] = useState(() =>
    initialConfig?.cores ? clampCores(String(initialConfig.cores), maxCores) : defaultCores(maxCores),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Keep the chosen cores within the current budget (it may shrink at runtime).
  useEffect(() => {
    setCores((current) => Math.min(current, Math.max(1, maxCores)));
  }, [maxCores]);

  // Keep the per-surface map in sync with the current STL set: add a default row
  // for a new surface, drop a removed one, keep existing edits untouched.
  const stlKey = useMemo(() => stls.map((s) => s.name).join('|'), [stls]);
  useEffect(() => {
    const fallback = DEFAULT_SNAPPY_CONFIG.surfaceRefinement;
    setRefinements((prev) => {
      const next: RefinementMap = {};
      for (const stl of stls) {
        next[stl.name] = prev[stl.name] ?? { min: String(fallback.min), max: String(fallback.max) };
      }
      const sameKeys =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return sameKeys ? prev : next;
    });
    // Same sync for the per-surface layer flags: a new surface defaults to "on".
    setLayerSurfaceOn((prev) => {
      const next: Record<string, boolean> = {};
      for (const stl of stls) next[stl.name] = prev[stl.name] ?? true;
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stlKey]);

  const margin = Number(marginFactor) || DEFAULT_SNAPPY_CONFIG.marginFactor;

  const autoCell = bounds ? (diagonalOf(bounds) || 1) / 40 : null;
  const autoPoint = useMemo(
    () => (bounds ? autoLocation(bounds, domainType, margin) : null),
    [bounds, domainType, margin],
  );

  // A surface whose max < min is invalid; block the run and flag it inline.
  const invalidSurface = stls.find((s) => {
    const r = refinements[s.name];
    return r && Number(r.max) < Number(r.min);
  });
  const refinementError = invalidSurface ? 'Each surface needs max >= min refinement.' : undefined;

  const canSubmit = !disabled && !running && !refinementError;

  const setRef = (name: string, key: 'min' | 'max', value: string) => {
    setRefinements((prev) => ({ ...prev, [name]: { ...prev[name], [key]: value } }));
  };

  // The assembled config, shared by the run CTA and the debounced autosave. A
  // stable reference while the inputs are unchanged (so autosave does not loop).
  const config = useMemo<SnappyConfig>(() => {
    const parsedCell = cellSize.trim() === '' ? null : Number(cellSize);
    const location: [number, number, number] | null = manualPoint
      ? [Number(px), Number(py), Number(pz)]
      : null;

    const surfaceRefinements: Record<string, SurfaceRefinement> = {};
    for (const stl of stls) {
      const r = refinements[stl.name] ?? { min: '1', max: '2' };
      surfaceRefinements[stl.name] = {
        min: Math.max(0, Math.round(Number(r.min) || 0)),
        max: Math.max(0, Math.round(Number(r.max) || 0)),
      };
    }
    // A sensible scalar fallback (first surface, else the default).
    const firstName = stls[0]?.name;
    const surfaceRefinement =
      (firstName && surfaceRefinements[firstName]) || DEFAULT_SNAPPY_CONFIG.surfaceRefinement;

    return {
      engine: 'snappy',
      domainType,
      baseCellSize: parsedCell && parsedCell > 0 ? parsedCell : null,
      marginFactor: margin,
      surfaceRefinement,
      surfaceRefinements,
      featureLevel: Math.max(0, Math.round(Number(featureLevel) || DEFAULT_SNAPPY_CONFIG.featureLevel)),
      locationInMesh: location && location.every(Number.isFinite) ? location : null,
      addLayers: {
        enabled: layersOn,
        // The surfaces (boundaries) the layers grow on — the checked STL surfaces.
        surfaces: stls.map((s) => s.name).filter((name) => layerSurfaceOn[name] ?? true),
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        relativeSizes,
        finalLayerThickness: Math.max(1e-6, Number(finalThickness) || 0.5),
        expansionRatio: Math.max(1, Number(expansionRatio) || 1.2),
      },
      cores: clampCores(String(cores), maxCores),
    };
  }, [
    domainType, cellSize, refinements, margin, featureLevel, layersOn, layerSurfaceOn, nLayers,
    relativeSizes, finalThickness, expansionRatio, manualPoint, px, py, pz, cores, maxCores, stls,
  ]);

  const handleGenerate = () => onGenerate(config);

  // Debounced autosave: persist the config whenever it changes, so manual values
  // survive a reload even without a run. Keyed on the SERIALIZED config (a value,
  // not a reference) so a re-render from the save's cache update never re-triggers
  // it — otherwise autosave would loop. Skips the initial (seeded) value and any
  // invalid refinement (max < min), which the server would reject.
  const serialized = useMemo(() => JSON.stringify(config), [config]);
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    if (!onConfigChange || refinementError) return;
    const handle = setTimeout(() => onConfigChange(JSON.parse(serialized) as SnappyConfig), 800);
    return () => clearTimeout(handle);
  }, [serialized, onConfigChange, refinementError]);

  // Prefill the manual keep-point from the auto value ONLY when the fields are
  // empty, so turning the toggle off and on never wipes values the user typed.
  const enableManualPoint = () => {
    setManualPoint(true);
    if (autoPoint && px.trim() === '' && py.trim() === '' && pz.trim() === '') {
      setPx(fmt(autoPoint[0]));
      setPy(fmt(autoPoint[1]));
      setPz(fmt(autoPoint[2]));
    }
  };

  return (
    <div className="flex flex-col gap-5 rounded-md border border-border bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text">Mesh settings</h3>
        <p className="text-sm text-text-secondary">
          snappyHexMesh builds a hex-dominant volume mesh from the surface(s).
        </p>
      </div>

      {/* Domain type: which side of the surface the mesh keeps. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text">Flow domain</legend>
        <SegmentedRadioGroup
          name="domainType"
          value={domainType}
          onChange={(value) => setDomainType(value)}
          ariaLabel="Flow domain"
          stretch
          options={[
            { value: 'internal', label: 'Internal (inside)' },
            { value: 'external', label: 'External (around)' },
          ]}
        />
        <p className="text-xs text-text-secondary">
          {domainType === 'internal'
            ? 'Meshes the fluid volume enclosed by the surface (e.g. a pipe bore).'
            : 'Meshes the volume around the surface, inside a background box (flow past a body).'}
        </p>
      </fieldset>

      <Field
        label="Base cell size (m)"
        helperText={autoCell ? `Auto: ${fmt(autoCell)} m` : 'Auto (from the surface size)'}
        className="sm:max-w-xs"
      >
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder={autoCell ? fmt(autoCell) : 'auto'}
          value={cellSize}
          onChange={(e) => setCellSize(e.target.value)}
        />
      </Field>

      {/* Per-surface refinement: one row per STL. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text">Surface refinement</legend>
        {stls.length === 0 ? (
          <p className="text-xs text-text-secondary">Upload a surface to set its refinement.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {stls.map((stl) => {
              const r = refinements[stl.name] ?? { min: '1', max: '2' };
              const bad = Number(r.max) < Number(r.min);
              return (
                <div key={stl.name} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-text" title={stl.name}>
                    {stl.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      aria-label={`${stl.name} minimum refinement level`}
                      aria-invalid={bad || undefined}
                      className="w-20"
                      value={r.min}
                      onChange={(e) => setRef(stl.name, 'min', e.target.value)}
                    />
                    <span className="text-sm text-text-secondary">to</span>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      aria-label={`${stl.name} maximum refinement level`}
                      aria-invalid={bad || undefined}
                      className="w-20"
                      value={r.max}
                      onChange={(e) => setRef(stl.name, 'max', e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {refinementError && (
          <p className="text-xs text-danger" role="alert">
            {refinementError}
          </p>
        )}
      </fieldset>

      {/* Advanced disclosure: keep-point, padding, feature level, prism layers. */}
      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center gap-1.5 rounded-md px-3 py-2.5 text-left text-sm font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          {advancedOpen ? (
            <ChevronDown className="size-4" strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
          )}
          Advanced
        </button>
        {advancedOpen && (
          <div className="flex flex-col gap-4 border-t border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Background padding" helperText="Fraction of the surface size (e.g. 0.1).">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={marginFactor}
                  onChange={(e) => setMarginFactor(e.target.value)}
                />
              </Field>
              <Field label="Feature-edge level" helperText="Refinement on sharp edges.">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={featureLevel}
                  onChange={(e) => setFeatureLevel(e.target.value)}
                />
              </Field>
            </div>

            {/* CPU cores: 1 = serial, more = parallel snappyHexMesh (MPI). */}
            <Field
              label="CPU cores"
              helperText={
                cores > 1
                  ? `Runs snappyHexMesh in parallel across ${cores} cores. ${maxCores} available.`
                  : `Serial (single core). Raise to mesh in parallel (${maxCores} available).`
              }
              className="sm:max-w-xs"
            >
              <div className="flex items-center gap-2">
                <Cpu className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
                <Input
                  type="number"
                  min="1"
                  max={maxCores}
                  step="1"
                  aria-label="Number of CPU cores for the mesh run"
                  value={cores}
                  onChange={(e) => setCores(clampCores(e.target.value, maxCores))}
                />
              </div>
            </Field>

            {/* Keep-point (locationInMesh): auto by default, editable when manual. */}
            <fieldset className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm font-medium text-text">
                <input
                  type="checkbox"
                  className="size-4 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                  checked={manualPoint}
                  onChange={(e) => (e.target.checked ? enableManualPoint() : setManualPoint(false))}
                />
                Set keep-point manually
              </label>
              <p className="text-xs text-text-secondary">
                The point that marks the fluid side. Auto:{' '}
                {autoPoint ? `(${fmt(autoPoint[0])}, ${fmt(autoPoint[1])}, ${fmt(autoPoint[2])})` : 'from the surface'}.
              </p>
              {manualPoint && (
                <div className="grid grid-cols-3 gap-2">
                  <Input type="number" step="any" aria-label="Keep-point X" value={px} onChange={(e) => setPx(e.target.value)} />
                  <Input type="number" step="any" aria-label="Keep-point Y" value={py} onChange={(e) => setPy(e.target.value)} />
                  <Input type="number" step="any" aria-label="Keep-point Z" value={pz} onChange={(e) => setPz(e.target.value)} />
                </div>
              )}
            </fieldset>

            {/* Prism (boundary) layers. */}
            <fieldset className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm font-medium text-text">
                <input
                  type="checkbox"
                  className="size-4 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                  checked={layersOn}
                  onChange={(e) => setLayersOn(e.target.checked)}
                />
                <Layers className="size-4 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
                Add boundary layers
              </label>
              {layersOn && (
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Number of layers">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={nLayers}
                        onChange={(e) => setNLayers(e.target.value)}
                      />
                    </Field>
                    <Field label="Expansion ratio" helperText="Growth between successive layers (>= 1).">
                      <Input
                        type="number"
                        min="1"
                        step="any"
                        value={expansionRatio}
                        onChange={(e) => setExpansionRatio(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Final layer thickness"
                      helperText={relativeSizes ? 'Fraction of the local cell size.' : 'Absolute length (m).'}
                    >
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={finalThickness}
                        onChange={(e) => setFinalThickness(e.target.value)}
                      />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      className="size-4 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                      checked={relativeSizes}
                      onChange={(e) => setRelativeSizes(e.target.checked)}
                    />
                    Thickness relative to the local cell size
                  </label>

                  {/* Which surfaces (boundaries) the layers grow on. */}
                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-sm font-medium text-text">Grow layers on</legend>
                    {stls.length === 0 ? (
                      <p className="text-xs text-text-secondary">
                        Upload a surface to choose where layers grow.
                      </p>
                    ) : (
                      <>
                        <div className="flex flex-col gap-1.5">
                          {stls.map((stl) => (
                            <label
                              key={stl.name}
                              className="flex items-center gap-2 text-sm text-text"
                              title={stl.name}
                            >
                              <input
                                type="checkbox"
                                className="size-4 shrink-0 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
                                checked={layerSurfaceOn[stl.name] ?? true}
                                onChange={(e) =>
                                  setLayerSurfaceOn((prev) => ({ ...prev, [stl.name]: e.target.checked }))
                                }
                              />
                              <span className="min-w-0 truncate">{stl.name}</span>
                            </label>
                          ))}
                        </div>
                        {stls.every((s) => !(layerSurfaceOn[s.name] ?? true)) && (
                          <p
                            className="rounded-md bg-accent-tint px-2.5 py-1.5 text-xs text-text"
                            role="status"
                          >
                            No surface selected, so no layers will be grown.
                          </p>
                        )}
                      </>
                    )}
                  </fieldset>
                </div>
              )}
            </fieldset>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          className="w-full sm:w-auto sm:self-start"
          onClick={handleGenerate}
          loading={running}
          disabled={!canSubmit}
        >
          <Wand2 strokeWidth={1.75} aria-hidden="true" />
          Generate mesh
        </Button>
        {disabled && !running && (
          <p className="text-xs text-text-secondary">Upload at least one STL surface to enable meshing.</p>
        )}
      </div>
    </div>
  );
}

export default SnappyConfigForm;
