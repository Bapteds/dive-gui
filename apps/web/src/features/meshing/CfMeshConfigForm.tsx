import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Layers, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CFMESH_PATCH_TYPES, DEFAULT_CFMESH_CONFIG } from '@/lib/api/types';
import type { CfMeshConfig, CfMeshPatchType, MeshBounds, StlFile } from '@/lib/api/types';

/**
 * CfMeshConfigForm — the cfMesh (cartesianMesh) tunables for one run. Distinct
 * from the snappy form: sizes are ABSOLUTE metres, there is no domain-type /
 * keep-point (cfMesh meshes the volume bounded by the surface), feature edges are
 * extracted from STL into an FMS, and layers use cfMesh's thicknessRatio /
 * maxFirstLayerThickness. `cores` maps to OpenMP threads (cfMesh is multithreaded).
 *
 * Same UX contract as the snappy form: seeds from `initialConfig` on mount, and
 * every edit is autosaved via a debounced `onConfigChange`. `maxCellSize` empty
 * sends null, which the server derives from the STL bounds — but an FMS input has
 * no bounds, so a base size is required there (surfaced inline).
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

/** Clamp a core-count string to the integer range [1, max]. */
function clampCores(value: string, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, max));
}

/** The default cores for a fresh session: half the machine budget, at least 1. */
function defaultCores(max: number): number {
  return Math.max(1, Math.floor(Math.max(1, max) / 2));
}

/** Parse a size input: a positive number, else null ("auto / unset"). */
function parseSize(value: string): number | null {
  const n = Number(value);
  return value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

export function CfMeshConfigForm({
  stls,
  bounds,
  patches,
  disabled,
  running,
  initialConfig,
  maxCores,
  onGenerate,
  onConfigChange,
}: {
  stls: StlFile[];
  bounds: MeshBounds | null;
  /** Boundary patch names discovered from the input surface (for the type editor). */
  patches: string[];
  disabled: boolean;
  running: boolean;
  initialConfig: CfMeshConfig | null;
  maxCores: number;
  onGenerate: (config: CfMeshConfig) => void;
  onConfigChange?: (config: CfMeshConfig) => void;
}) {
  const init = initialConfig ?? DEFAULT_CFMESH_CONFIG;

  const [maxCellSize, setMaxCellSize] = useState(init.maxCellSize ? String(init.maxCellSize) : '');
  const [minCellSize, setMinCellSize] = useState(init.minCellSize ? String(init.minCellSize) : '');
  const [boundaryCellSize, setBoundaryCellSize] = useState(
    init.boundaryCellSize ? String(init.boundaryCellSize) : '',
  );
  const [extractFeatures, setExtractFeatures] = useState(init.extractFeatures);
  const [featureAngle, setFeatureAngle] = useState(String(init.featureAngle));
  const [layersOn, setLayersOn] = useState(init.addLayers.enabled);
  const [nLayers, setNLayers] = useState(String(init.addLayers.nLayers));
  const [thicknessRatio, setThicknessRatio] = useState(String(init.addLayers.thicknessRatio));
  const [maxFirstLayer, setMaxFirstLayer] = useState(
    init.addLayers.maxFirstLayerThickness ? String(init.addLayers.maxFirstLayerThickness) : '',
  );
  const [cores, setCores] = useState(() =>
    initialConfig?.cores ? clampCores(String(initialConfig.cores), maxCores) : defaultCores(maxCores),
  );
  // Per-patch boundary type; '' means "keep the FMS/cfMesh default" (not written).
  const [patchTypes, setPatchTypes] = useState<Record<string, CfMeshPatchType | ''>>(
    () => init.patchTypes ?? {},
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setCores((current) => Math.min(current, Math.max(1, maxCores)));
  }, [maxCores]);

  const autoCell = bounds ? (diagonalOf(bounds) || 1) / 40 : null;
  // An FMS input has no bounds, so cartesianMesh cannot derive a base size.
  const needsCellSize = !bounds && parseSize(maxCellSize) == null;
  const canSubmit = !disabled && !running && !needsCellSize;

  // Only patches with a concrete (non-empty) type are sent; the rest keep their default.
  const chosenPatchTypes = useMemo(() => {
    const out: Record<string, CfMeshPatchType> = {};
    for (const name of patches) {
      const type = patchTypes[name];
      if (type) out[name] = type;
    }
    return out;
  }, [patches, patchTypes]);

  const config = useMemo<CfMeshConfig>(
    () => ({
      engine: 'cfmesh',
      maxCellSize: parseSize(maxCellSize),
      minCellSize: parseSize(minCellSize),
      boundaryCellSize: parseSize(boundaryCellSize),
      extractFeatures,
      featureAngle: Math.min(180, Math.max(0, Number(featureAngle) || DEFAULT_CFMESH_CONFIG.featureAngle)),
      patchTypes: Object.keys(chosenPatchTypes).length > 0 ? chosenPatchTypes : undefined,
      addLayers: {
        enabled: layersOn,
        nLayers: Math.max(1, Math.round(Number(nLayers) || 3)),
        thicknessRatio: Math.max(1, Number(thicknessRatio) || 1.2),
        maxFirstLayerThickness: parseSize(maxFirstLayer),
      },
      cores: clampCores(String(cores), maxCores),
    }),
    [
      maxCellSize, minCellSize, boundaryCellSize, extractFeatures, featureAngle, chosenPatchTypes,
      layersOn, nLayers, thicknessRatio, maxFirstLayer, cores, maxCores,
    ],
  );

  const handleGenerate = () => onGenerate(config);

  // Debounced autosave, keyed on the serialized config (a value, not a reference)
  // so a re-render from the save's cache update never re-triggers it. Skips the
  // initial seeded value.
  const serialized = useMemo(() => JSON.stringify(config), [config]);
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    if (!onConfigChange) return;
    const handle = setTimeout(() => onConfigChange(JSON.parse(serialized) as CfMeshConfig), 800);
    return () => clearTimeout(handle);
  }, [serialized, onConfigChange]);

  const hasFms = stls.some((s) => s.name.toLowerCase().endsWith('.fms'));

  return (
    <div className="flex flex-col gap-5 rounded-md border border-border bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text">Mesh settings</h3>
        <p className="text-sm text-text-secondary">
          cfMesh cartesianMesh builds a hex-dominant volume mesh inside the surface.
        </p>
      </div>

      <Field
        label="Base cell size (m)"
        helperText={
          autoCell
            ? `Auto: ${fmt(autoCell)} m`
            : 'Required for an FMS input (no bounds to derive it from).'
        }
        error={needsCellSize ? 'Set a base cell size to mesh an FMS input.' : undefined}
        className="sm:max-w-xs"
      >
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder={autoCell ? fmt(autoCell) : 'e.g. 0.01'}
          value={maxCellSize}
          onChange={(e) => setMaxCellSize(e.target.value)}
        />
      </Field>

      {/* Feature edges: extract from STL into an FMS (ignored when the input is FMS). */}
      {!hasFms && (
        <fieldset className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm font-medium text-text">
            <input
              type="checkbox"
              className="size-4 rounded-sm border-border-strong text-cta focus-visible:ring-2 focus-visible:ring-focus-ring"
              checked={extractFeatures}
              onChange={(e) => setExtractFeatures(e.target.checked)}
            />
            Extract feature edges
          </label>
          <p className="text-xs text-text-secondary">
            Captures sharp edges (surfaceFeatureEdges → FMS) before meshing. Recommended for CAD
            surfaces.
          </p>
          {extractFeatures && (
            <Field label="Feature angle (°)" helperText="Edges sharper than this are kept." className="sm:max-w-xs">
              <Input
                type="number"
                min="0"
                max="180"
                step="1"
                value={featureAngle}
                onChange={(e) => setFeatureAngle(e.target.value)}
              />
            </Field>
          )}
        </fieldset>
      )}

      {/* Boundary types: one OpenFOAM patch type per discovered boundary. */}
      {patches.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text">Boundary types</legend>
          <p className="text-xs text-text-secondary">
            The type each patch gets in the mesh. “Keep” leaves the surface&apos;s own type.
          </p>
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
            {patches.map((name) => (
              <div key={name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-text" title={name} translate="no">
                  {name}
                </span>
                <PatchTypeSelect
                  patch={name}
                  value={patchTypes[name] ?? ''}
                  onChange={(type) => setPatchTypes((prev) => ({ ...prev, [name]: type }))}
                />
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {/* Advanced: refinement sizes, CPU threads, boundary layers. */}
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
              <Field label="Min cell size (m)" helperText="Refinement floor; blank = none.">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="none"
                  value={minCellSize}
                  onChange={(e) => setMinCellSize(e.target.value)}
                />
              </Field>
              <Field label="Boundary cell size (m)" helperText="Cell size at the wall; blank = base.">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="base"
                  value={boundaryCellSize}
                  onChange={(e) => setBoundaryCellSize(e.target.value)}
                />
              </Field>
            </div>

            {/* CPU threads (OpenMP). */}
            <Field
              label="CPU cores (threads)"
              helperText={`cfMesh is multithreaded (OpenMP). ${maxCores} available.`}
              className="sm:max-w-xs"
            >
              <div className="flex items-center gap-2">
                <Cpu className="size-4 shrink-0 text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
                <Input
                  type="number"
                  min="1"
                  max={maxCores}
                  step="1"
                  aria-label="Number of CPU threads for the mesh run"
                  value={cores}
                  onChange={(e) => setCores(clampCores(e.target.value, maxCores))}
                />
              </div>
            </Field>

            {/* Boundary (prism) layers. */}
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
          <p className="text-xs text-text-secondary">
            Upload at least one STL surface (or an FMS) to enable meshing.
          </p>
        )}
      </div>
    </div>
  );
}

/** A styled native <select> for one patch's boundary type ('' = keep the default). */
function PatchTypeSelect({
  patch,
  value,
  onChange,
}: {
  patch: string;
  value: CfMeshPatchType | '';
  onChange: (value: CfMeshPatchType | '') => void;
}) {
  return (
    <div className="relative">
      <select
        aria-label={`Boundary type for ${patch}`}
        value={value}
        onChange={(e) => onChange(e.target.value as CfMeshPatchType | '')}
        className={cn(
          'h-9 w-40 appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-text',
          'transition-colors duration-fast ease-out hover:border-border-strong',
          'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        )}
      >
        <option value="">Keep (default)</option>
        {CFMESH_PATCH_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </div>
  );
}

export default CfMeshConfigForm;
