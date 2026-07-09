import { useId, useMemo, useState } from 'react';
import { ArrowDownToLine, Calculator, Check, ChevronDown, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { getCaseFileContent } from '@/lib/api/projects';
import { TURBULENCE_APPROACHES, TURBULENCE_MODELS } from '@/lib/api/types';
import { insertFoamField, setFoamValue } from '@/features/projects/foamModel';
import { useCaseFilesQuery, useSaveCaseFile } from '@/features/projects/useCaseFiles';

/**
 * TurbulenceCalculator - a project tab tool that estimates the RANS seed values
 * (k, epsilon, omega) from three flow inputs (velocity U, characteristic length Dh,
 * kinematic viscosity nu) plus a turbulent intensity I. Each value carries a copy
 * button, and "Write to case" splices `internalField uniform <value>` into the
 * case 0/ fields: k into 0/k, and the second field into whichever of 0/omega /
 * 0/epsilon the case actually carries (k-omega models keep omega, k-epsilon keep
 * epsilon).
 *
 * Formulas (see documents/calculator/turbulence_cfd_notes.md):
 *   Re      = U * Dh / nu
 *   k       = 3/2 * (U * I)^2
 *   L       = 0.07 * Dh
 *   epsilon = k^1.5 / (Cmu^0.75 * L)          with Cmu = 0.09
 *   omega   = k^0.5 / (Cmu^0.75 * L) = epsilon / k
 *
 * A turbulence-model selector highlights the fields that model actually reads
 * (kOmegaSST -> k, omega; kEpsilon -> k, epsilon) and dims the rest.
 */

/** Cmu^0.75 - the coefficient shared by the epsilon and omega length-scale terms. */
const CMU_075 = Math.pow(0.09, 0.75);

interface Seeds {
  re: number;
  k: number;
  length: number;
  epsilon: number;
  omega: number;
}

/** Parse a numeric field; returns null for empty / non-finite / non-positive input. */
function positive(raw: string): number | null {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Compute the seed values, or null when the required inputs are not all valid. */
function computeSeeds(uRaw: string, dhRaw: string, nuRaw: string, iRaw: string): Seeds | null {
  const u = positive(uRaw);
  const dh = positive(dhRaw);
  const nu = positive(nuRaw);
  const iPct = Number.parseFloat(iRaw);
  if (u == null || dh == null || nu == null || !Number.isFinite(iPct) || iPct < 0) return null;

  const intensity = iPct / 100;
  const k = 1.5 * (u * intensity) ** 2;
  const length = 0.07 * dh;
  const epsilon = k > 0 ? k ** 1.5 / (CMU_075 * length) : 0;
  const omega = Math.sqrt(k) / (CMU_075 * length);
  return { re: (u * dh) / nu, k, length, epsilon, omega };
}

/** Trim trailing zeros left by toPrecision ("0.06000" -> "0.06", "1500" -> "1500"). */
function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Format for display (4 sig figs) or copy (6 sig figs), switching to scientific at the extremes. */
function formatNumber(value: number, sig: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e5) return value.toExponential(sig - 1);
  return trimZeros(value.toPrecision(sig));
}

/**
 * TurbulenceCalculatorDialog - the calculator inside a modal overlay, opened from
 * the Case files toolbar (next to "Edit files") rather than a dedicated tab. The
 * content wrapper drops its own card chrome (the dialog surface provides it) and
 * scrolls internally within a bounded height.
 */
export function TurbulenceCalculatorDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
        {/* The calculator's own header carries the visible title; this hidden one
            gives the dialog its accessible name (Radix requires a DialogTitle). */}
        <DialogTitle className="sr-only">Turbulence calculator</DialogTitle>
        <TurbulenceCalculator projectId={projectId} bare />
      </DialogContent>
    </Dialog>
  );
}

export function TurbulenceCalculator({
  projectId,
  bare = false,
}: {
  projectId: string;
  /** Drop the outer card chrome so the component can fill a dialog surface. */
  bare?: boolean;
}) {
  const [u, setU] = useState('2');
  const [dh, setDh] = useState('0.1');
  // Water at ~20 C. DIVE runs hydro turbines, so water is the sensible default.
  const [nu, setNu] = useState('1e-6');
  const [intensity, setIntensity] = useState('5');
  const [model, setModel] = useState('kOmegaSST');
  const [writing, setWriting] = useState(false);

  const baseId = useId();
  const seeds = useMemo(() => computeSeeds(u, dh, nu, intensity), [u, dh, nu, intensity]);

  const fields = TURBULENCE_MODELS.find((m) => m.id === model)?.fields ?? [];
  const usesEpsilon = fields.includes('epsilon');
  const usesOmega = fields.includes('omega');
  const usesNone = fields.length === 0;

  // Which 0/ turbulence fields the case actually carries. The second field target
  // follows the FILE that exists (omega for k-omega cases, epsilon for k-epsilon),
  // not the model highlighted above - that is only a reading aid.
  const { data: entries } = useCaseFilesQuery(projectId);
  const hasField = (path: string) => !!entries?.some((entry) => entry.path === path);
  const hasK = hasField('0/k');
  const secondField: 'omega' | 'epsilon' | null = hasField('0/omega')
    ? 'omega'
    : hasField('0/epsilon')
      ? 'epsilon'
      : null;
  const targets = [hasK ? '0/k' : null, secondField ? `0/${secondField}` : null].filter(
    (path): path is string => path != null,
  );

  const save = useSaveCaseFile(projectId);

  // Splice `internalField uniform <value>` into one 0/ field, preserving the rest
  // of the file (banner, boundaryField, comments), then persist it.
  const writeField = async (path: string, value: number) => {
    const { content } = await getCaseFileContent(projectId, path);
    const body = `uniform ${formatNumber(value, 6)}`;
    const next =
      setFoamValue(content, ['internalField'], body) ??
      insertFoamField(content, [], 'internalField', body);
    if (next && next !== content) {
      await save.mutateAsync({ path, content: next });
    }
  };

  const writeToCase = async () => {
    if (!seeds || targets.length === 0) return;
    setWriting(true);
    try {
      const written: string[] = [];
      if (hasK) {
        await writeField('0/k', seeds.k);
        written.push('k');
      }
      if (secondField) {
        await writeField(`0/${secondField}`, secondField === 'omega' ? seeds.omega : seeds.epsilon);
        written.push(secondField);
      }
      toast.success(`Wrote internalField for ${written.join(' and ')} to the case.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not write to the case files.');
    } finally {
      setWriting(false);
    }
  };

  return (
    <div
      className={cn(
        'flex w-full flex-col overflow-hidden',
        bare
          ? 'min-h-0 flex-1'
          : 'rounded-md border border-border bg-surface shadow-sm lg:min-h-0 lg:flex-1',
      )}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border p-6 pb-4">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint text-primary"
          aria-hidden="true"
        >
          <Calculator className="size-5" strokeWidth={1.75} />
        </span>
        <div className="flex flex-col">
          <h2 className="text-base font-semibold text-text">Turbulence calculator</h2>
          <p className="text-sm text-text-secondary">
            Estimate the k, epsilon and omega seed values from the inlet flow.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
          {/* Inputs */}
          <section aria-labelledby={`${baseId}-inputs`} className="flex flex-col gap-4">
            <h3 id={`${baseId}-inputs`} className="text-sm font-semibold text-text">
              Flow inputs
            </h3>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <NumberField
                id={`${baseId}-u`}
                label="Velocity"
                symbol="U"
                unit="m/s"
                value={u}
                onChange={setU}
              />
              <NumberField
                id={`${baseId}-dh`}
                label="Characteristic length"
                symbol="Dh"
                unit="m"
                value={dh}
                onChange={setDh}
              />
              <NumberField
                id={`${baseId}-nu`}
                label="Kinematic viscosity"
                symbol="ν"
                unit="m²/s"
                value={nu}
                onChange={setNu}
                helper="Water ~1e-6, air ~1.5e-5."
              />
              <NumberField
                id={`${baseId}-i`}
                label="Turbulent intensity"
                symbol="I"
                unit="%"
                value={intensity}
                onChange={setIntensity}
                helper="Typically around 5%."
              />
            </div>

            <ModelSelect id={`${baseId}-model`} value={model} onChange={setModel} />
          </section>

          {/* Results */}
          <section aria-labelledby={`${baseId}-results`} className="flex flex-col gap-4">
            <h3 id={`${baseId}-results`} className="text-sm font-semibold text-text">
              Computed values
            </h3>

            {seeds ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                  <Derived symbol="Re" label="Reynolds number" value={formatNumber(seeds.re, 4)} />
                  <Derived
                    symbol="L"
                    label="Turbulent length scale"
                    value={formatNumber(seeds.length, 4)}
                    unit="m"
                  />
                </div>

                <dl className="flex flex-col divide-y divide-border rounded-md border border-border bg-bg/40">
                  <SeedRow
                    symbol="k"
                    name="Turbulent kinetic energy"
                    unit="m²/s²"
                    value={seeds.k}
                    used={!usesNone}
                  />
                  <SeedRow
                    symbol="ε"
                    name="Dissipation rate"
                    unit="m²/s³"
                    value={seeds.epsilon}
                    used={usesEpsilon}
                  />
                  <SeedRow
                    symbol="ω"
                    name="Specific dissipation rate"
                    unit="1/s"
                    value={seeds.omega}
                    used={usesOmega}
                  />
                </dl>

                <div className="flex flex-col gap-2 rounded-md border border-border bg-bg/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text">Write to case</span>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={writing}
                      disabled={targets.length === 0}
                      onClick={() => void writeToCase()}
                    >
                      <ArrowDownToLine strokeWidth={1.75} aria-hidden="true" />
                      Write to case
                    </Button>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {targets.length > 0 ? (
                      <>
                        Sets <span className="font-mono text-text" translate="no">internalField</span>{' '}
                        in{' '}
                        <span className="font-mono text-text" translate="no">
                          {targets.join(', ')}
                        </span>
                        . The second field follows the file this case carries (
                        {secondField ?? 'none'}).
                      </>
                    ) : (
                      'No 0/ turbulence fields in this case yet. Set up the solver on the Solver tab first, then write.'
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-text-secondary">
                Enter a positive velocity, length and viscosity to compute the seed values.
              </p>
            )}

            <FormulaReference />
          </section>
        </div>
      </div>
    </div>
  );
}

/** A labelled number input carrying its symbol and unit, matching the boundary-condition form. */
function NumberField({
  id,
  label,
  symbol,
  unit,
  value,
  onChange,
  helper,
}: {
  id: string;
  label: string;
  symbol: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
}) {
  const invalid = value.trim() !== '' && !(Number.parseFloat(value) >= 0);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-xs font-medium text-text-secondary">
        <span>{label}</span>
        <span className="font-mono text-text" translate="no">
          {symbol}
        </span>
        <span className="font-normal text-text-secondary/80" translate="no">
          [{unit}]
        </span>
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        autoComplete="off"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="font-mono tabular-nums"
      />
      {helper && (
        <p id={`${id}-help`} className="text-xs text-text-secondary">
          {helper}
        </p>
      )}
    </div>
  );
}

/** The turbulence-model selector - drives which seed fields are highlighted as "used". */
function ModelSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        Turbulence model
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={cn(
            'h-10 w-full appearance-none rounded-sm border border-border bg-surface pl-3 pr-9 text-sm text-text',
            'transition-colors duration-fast ease-out hover:border-border-strong',
            'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
          )}
        >
          {TURBULENCE_APPROACHES.map((approach) => (
            <optgroup key={approach.id} label={approach.label}>
              {TURBULENCE_MODELS.filter((m) => m.simulationType === approach.id).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
      <p className="text-xs text-text-secondary">Highlights the fields this model needs.</p>
    </div>
  );
}

/** A compact derived-quantity chip (Reynolds, length scale) - informative, no copy. */
function Derived({
  symbol,
  label,
  value,
  unit,
}: {
  symbol: string;
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-xs text-text-secondary" translate="no">
        {symbol}
      </span>
      <span className="sr-only">{label}</span>
      <span className="font-mono text-sm tabular-nums text-text" translate="no">
        {value}
      </span>
      {unit && (
        <span className="font-mono text-xs text-text-secondary" translate="no">
          {unit}
        </span>
      )}
    </div>
  );
}

/** A seed-value row: symbol + name on the left, value + unit + copy on the right. */
function SeedRow({
  symbol,
  name,
  unit,
  value,
  used,
}: {
  symbol: string;
  name: string;
  unit: string;
  value: number;
  used: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const display = formatNumber(value, 4);
  const copyValue = formatNumber(value, 6);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions): the value stays
      // visible for manual copy, so there is nothing to recover from.
    }
  };

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2.5', !used && 'opacity-55')}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn('w-4 font-mono text-sm font-semibold', used ? 'text-primary' : 'text-text-secondary')}
          translate="no"
        >
          {symbol}
        </span>
        <span className="truncate text-xs text-text-secondary">{name}</span>
        {used && (
          <span className="shrink-0 rounded-sm bg-primary-tint px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            used
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="font-mono text-sm tabular-nums text-text" translate="no">
          {display}
        </span>
        <span className="w-12 font-mono text-xs text-text-secondary" translate="no">
          {unit}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-sm text-text-secondary',
            'transition-colors duration-fast ease-out hover:bg-bg hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
          )}
          aria-label={copied ? `Copied ${symbol}` : `Copy ${symbol} value ${copyValue}`}
        >
          {copied ? (
            <Check className="size-4 text-primary" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Copy className="size-4" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? `${symbol} value copied` : ''}
      </span>
    </div>
  );
}

/** A collapsible reference of the equations behind the numbers. */
function FormulaReference() {
  return (
    <details className="group rounded-md border border-border bg-bg/40">
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text-secondary',
          'rounded-md hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset',
        )}
      >
        <ChevronDown
          className="size-4 shrink-0 transition-transform duration-fast ease-out group-open:rotate-180"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        Formulas
      </summary>
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2.5 font-mono text-xs text-text-secondary">
        <span translate="no">Re = U · Dh / ν</span>
        <span translate="no">k = 3/2 · (U · I)²</span>
        <span translate="no">L = 0.07 · Dh</span>
        <span translate="no">ε = k^1.5 / (0.09^0.75 · L)</span>
        <span translate="no">ω = k^0.5 / (0.09^0.75 · L) = ε / k</span>
      </div>
    </details>
  );
}
