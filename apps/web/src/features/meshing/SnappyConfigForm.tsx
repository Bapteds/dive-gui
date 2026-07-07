import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { DEFAULT_SNAPPY_CONFIG } from '@/lib/api/types';
import type { DomainType, MeshBounds, SnappyConfig, StlFile, SurfaceRefinement } from '@/lib/api/types';

/**
 * SnappyConfigForm - the snappyHexMesh tunables for one run. Surface refinement
 * is set PER STL surface; an Advanced disclosure reveals the keep-point,
 * background padding, feature level and boundary (prism) layers. One orange CTA
 * runs it. The form seeds from the session's last run so a manual keep-point (and
 * every other setting) survives a reload; a manual keep-point once typed is kept.
 *
 * `baseCellSize` empty and the manual keep-point off both send `null`, which the
 * server resolves from the STL bounds. When the bounds are known we mirror that
 * derivation here so the placeholders show the value the server will use.
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

export function SnappyConfigForm({
  stls,
  bounds,
  disabled,
  running,
  initialConfig,
  onGenerate,
}: {
  stls: StlFile[];
  bounds: MeshBounds | null;
  disabled: boolean;
  running: boolean;
  initialConfig: SnappyConfig | null;
  onGenerate: (config: SnappyConfig) => void;
}) {
  const init = initialConfig ?? DEFAULT_SNAPPY_CONFIG;

  const [domainType, setDomainType] = useState<DomainType>(init.domainType);
  const [cellSize, setCellSize] = useState(init.baseCellSize ? String(init.baseCellSize) : '');
  const [refinements, setRefinements] = useState<RefinementMap>(() => seedRefinements(stls, initialConfig));
  const [marginFactor, setMarginFactor] = useState(String(init.marginFactor));
  const [featureLevel, setFeatureLevel] = useState(String(init.featureLevel));
  const [layersOn, setLayersOn] = useState(init.addLayers.enabled);
  const [nLayers, setNLayers] = useState(String(init.addLayers.nLayers));
  const [relativeSizes, setRelativeSizes] = useState(init.addLayers.relativeSizes);
  const [finalThickness, setFinalThickness] = useState(String(init.addLayers.finalLayerThickness));
  const [expansionRatio, setExpansionRatio] = useState(String(init.addLayers.expansionRatio));
  const [manualPoint, setManualPoint] = useState(init.locationInMesh != null);
  const [px, setPx] = useState(init.locationInMesh ? fmt(init.locationInMesh[0]) : '');
  const [py, setPy] = useState(init.locationInMesh ? fmt(init.locationInMesh[1]) : '');
  const [pz, setPz] = useState(init.locationInMesh ? fmt(init.locationInMesh[2]) : '');
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const handleGenerate = () => {
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

    const config: SnappyConfig = {
      domainType,
      baseCellSize: parsedCell && parsedCell > 0 ? parsedCell : null,
      marginFactor: margin,
      surfaceRefinement,
      surfaceRefinements,
      featureLevel: Math.max(0, Math.round(Number(featureLevel) || DEFAULT_SNAPPY_CONFIG.featureLevel)),
      locationInMesh: location && location.every(Number.isFinite) ? location : null,
      addLayers: {
        enabled: layersOn,
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        relativeSizes,
        finalLayerThickness: Math.max(1e-6, Number(finalThickness) || 0.5),
        expansionRatio: Math.max(1, Number(expansionRatio) || 1.2),
      },
    };
    onGenerate(config);
  };

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
