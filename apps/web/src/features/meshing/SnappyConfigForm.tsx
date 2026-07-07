import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { DEFAULT_SNAPPY_CONFIG } from '@/lib/api/types';
import type { DomainType, MeshBounds, SnappyConfig } from '@/lib/api/types';

/**
 * SnappyConfigForm - the snappyHexMesh tunables for one run. The simple path
 * (domain type, cell size, surface refinement) covers most cases with sane
 * auto-derived defaults; an Advanced disclosure reveals the keep-point,
 * background padding, feature level and prism layers. One orange CTA runs it.
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

export function SnappyConfigForm({
  bounds,
  disabled,
  running,
  onGenerate,
}: {
  bounds: MeshBounds | null;
  disabled: boolean;
  running: boolean;
  onGenerate: (config: SnappyConfig) => void;
}) {
  const [domainType, setDomainType] = useState<DomainType>(DEFAULT_SNAPPY_CONFIG.domainType);
  const [cellSize, setCellSize] = useState('');
  const [refineMin, setRefineMin] = useState(String(DEFAULT_SNAPPY_CONFIG.surfaceRefinement.min));
  const [refineMax, setRefineMax] = useState(String(DEFAULT_SNAPPY_CONFIG.surfaceRefinement.max));
  const [marginFactor, setMarginFactor] = useState(String(DEFAULT_SNAPPY_CONFIG.marginFactor));
  const [featureLevel, setFeatureLevel] = useState(String(DEFAULT_SNAPPY_CONFIG.featureLevel));
  const [layersOn, setLayersOn] = useState(DEFAULT_SNAPPY_CONFIG.addLayers.enabled);
  const [nLayers, setNLayers] = useState(String(DEFAULT_SNAPPY_CONFIG.addLayers.nLayers));
  const [manualPoint, setManualPoint] = useState(false);
  const [px, setPx] = useState('');
  const [py, setPy] = useState('');
  const [pz, setPz] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const margin = Number(marginFactor) || DEFAULT_SNAPPY_CONFIG.marginFactor;

  // Auto suggestions shown as placeholders / prefills (only when bounds known).
  const autoCell = bounds ? (diagonalOf(bounds) || 1) / 40 : null;
  const autoPoint = useMemo(
    () => (bounds ? autoLocation(bounds, domainType, margin) : null),
    [bounds, domainType, margin],
  );

  const min = Number(refineMin);
  const max = Number(refineMax);
  const refinementError = max < min ? 'The maximum must be greater than or equal to the minimum.' : undefined;

  const canSubmit = !disabled && !running && !refinementError;

  const handleGenerate = () => {
    const parsedCell = cellSize.trim() === '' ? null : Number(cellSize);
    const location: [number, number, number] | null = manualPoint
      ? [Number(px), Number(py), Number(pz)]
      : null;
    const config: SnappyConfig = {
      domainType,
      baseCellSize: parsedCell && parsedCell > 0 ? parsedCell : null,
      marginFactor: margin,
      surfaceRefinement: { min: Math.max(0, Math.round(min)), max: Math.max(0, Math.round(max)) },
      featureLevel: Math.max(0, Math.round(Number(featureLevel) || DEFAULT_SNAPPY_CONFIG.featureLevel)),
      locationInMesh: location && location.every(Number.isFinite) ? location : null,
      addLayers: { enabled: layersOn, nLayers: Math.max(1, Math.round(Number(nLayers) || 3)) },
    };
    onGenerate(config);
  };

  // Prefill the manual keep-point inputs from the auto value when the user turns
  // manual mode on (so they nudge a sensible default rather than start at 0,0,0).
  const enableManualPoint = () => {
    setManualPoint(true);
    if (autoPoint) {
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Base cell size (m)"
          helperText={autoCell ? `Auto: ${fmt(autoCell)} m` : 'Auto (from the surface size)'}
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
        <Field label="Surface refinement" error={refinementError}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="0"
              step="1"
              aria-label="Minimum refinement level"
              value={refineMin}
              onChange={(e) => setRefineMin(e.target.value)}
            />
            <span className="text-sm text-text-secondary">to</span>
            <Input
              type="number"
              min="0"
              step="1"
              aria-label="Maximum refinement level"
              value={refineMax}
              onChange={(e) => setRefineMax(e.target.value)}
            />
          </div>
        </Field>
      </div>

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
            <fieldset className="flex flex-col gap-2">
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
                <Field label="Number of layers" className="max-w-[12rem]">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={nLayers}
                    onChange={(e) => setNLayers(e.target.value)}
                  />
                </Field>
              )}
            </fieldset>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          className={cn('w-full sm:w-auto sm:self-start')}
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
