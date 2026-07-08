import { useId, useMemo, useState } from 'react';
import { Calculator, Check, ChevronDown, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { TURBULENCE_MODELS } from '@/lib/api/types';

/**
 * TurbulenceCalculator - estimates the RANS seed values (k, epsilon, omega) from
 * three flow inputs (velocity U, characteristic length Dh, kinematic viscosity nu)
 * plus a turbulent intensity I. It computes, it does not write: the values are
 * shown with copy buttons so they can be pasted into the matching 0/ field
 * (internalField / inlet) in the Files step that follows.
 *
 * Formulas (see documents/calculator/turbulence_cfd_notes.md):
 *   Re      = U * Dh / nu
 *   k       = 3/2 * (U * I)^2
 *   L       = 0.07 * Dh
 *   epsilon = k^1.5 / (Cmu^0.75 * L)          with Cmu = 0.09
 *   omega   = k^0.5 / (Cmu^0.75 * L) = epsilon / k
 *
 * The panel ties itself to the picked model: it highlights the fields that model
 * actually reads (kOmegaSST -> k, omega; kEpsilon -> k, epsilon) and dims the rest.
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

export function TurbulenceCalculator({
  turbulence,
  disabled = false,
}: {
  /** The picked model id, so the panel can highlight the fields it reads. */
  turbulence: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [u, setU] = useState('2');
  const [dh, setDh] = useState('0.1');
  // Water at ~20 C. DIVE runs hydro turbines, so water is the sensible default.
  const [nu, setNu] = useState('1e-6');
  const [intensity, setIntensity] = useState('5');

  const panelId = useId();
  const seeds = useMemo(() => computeSeeds(u, dh, nu, intensity), [u, dh, nu, intensity]);

  const fields = TURBULENCE_MODELS.find((m) => m.id === turbulence)?.fields ?? [];
  const usesEpsilon = fields.includes('epsilon');
  const usesOmega = fields.includes('omega');
  const usesNone = fields.length === 0;

  return (
    <section className="overflow-hidden rounded-md border border-border bg-bg/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2.5 text-left',
          'transition-colors duration-fast ease-out hover:bg-bg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset',
        )}
      >
        <span
          className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-tint text-primary"
          aria-hidden="true"
        >
          <Calculator className="size-4" strokeWidth={1.75} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-text">Turbulence value calculator</span>
          <span className="text-xs text-text-secondary">
            Estimate k, epsilon and omega from the inlet flow
          </span>
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-text-secondary transition-transform duration-fast ease-out',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-4 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField
              id={`${panelId}-u`}
              label="Velocity"
              symbol="U"
              unit="m/s"
              value={u}
              onChange={setU}
              disabled={disabled}
            />
            <NumberField
              id={`${panelId}-dh`}
              label="Characteristic length"
              symbol="Dh"
              unit="m"
              value={dh}
              onChange={setDh}
              disabled={disabled}
            />
            <NumberField
              id={`${panelId}-nu`}
              label="Kinematic viscosity"
              symbol="ν"
              unit="m²/s"
              value={nu}
              onChange={setNu}
              disabled={disabled}
            />
            <NumberField
              id={`${panelId}-i`}
              label="Turbulent intensity"
              symbol="I"
              unit="%"
              value={intensity}
              onChange={setIntensity}
              disabled={disabled}
              helper="Typically around 5%."
            />
          </div>

          {seeds ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                <Derived symbol="Re" label="Reynolds" value={formatNumber(seeds.re, 4)} />
                <Derived symbol="L" label="Length scale" value={formatNumber(seeds.length, 4)} unit="m" />
              </div>

              <dl className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
                <SeedRow
                  symbol="k"
                  name="Turbulent kinetic energy"
                  unit="m²/s²"
                  value={seeds.k}
                  used={!usesNone}
                  disabled={disabled}
                />
                <SeedRow
                  symbol="ε"
                  name="Dissipation rate"
                  unit="m²/s³"
                  value={seeds.epsilon}
                  used={usesEpsilon}
                  disabled={disabled}
                />
                <SeedRow
                  symbol="ω"
                  name="Specific dissipation rate"
                  unit="1/s"
                  value={seeds.omega}
                  used={usesOmega}
                  disabled={disabled}
                />
              </dl>

              <p className="text-xs text-text-secondary">
                {usesNone
                  ? 'Laminar uses no turbulence fields. These values apply once you pick a RANS model.'
                  : 'Copy each value into its 0/ field (internalField and the inlet) in the Files step.'}
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-secondary">
              Enter a positive velocity, length and viscosity to compute the seed values.
            </p>
          )}
        </div>
      )}
    </section>
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
  disabled,
  helper,
}: {
  id: string;
  label: string;
  symbol: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
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
        disabled={disabled}
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
  disabled,
}: {
  symbol: string;
  name: string;
  unit: string;
  value: number;
  used: boolean;
  disabled: boolean;
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
    <div className={cn('flex items-center gap-3 px-3 py-2', !used && 'opacity-55')}>
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
        <span className="font-mono text-xs text-text-secondary" translate="no">
          {unit}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={disabled}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-sm text-text-secondary',
            'transition-colors duration-fast ease-out hover:bg-bg hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
            'disabled:cursor-not-allowed disabled:opacity-50',
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
