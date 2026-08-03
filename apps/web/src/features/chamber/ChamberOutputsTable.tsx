import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  ChamberConfidence,
  ChamberConstraint,
  ChamberOutput,
  ChamberOutputKey,
  ChamberStatus,
} from '@/lib/api/types';

/**
 * ChamberOutputsTable - the twelve computed parameters (mm), with the calculator's
 * per-output Min / Max / Exact overrides editable inline. Model is the raw
 * regression value; FINAL applies the clamp; Status explains what happened. The
 * confidence pill carries the leave-one-out CV error. Values are recomputed live
 * by the parent as the inputs or overrides change.
 */

/** Which override field a cell edits. */
type ConstraintField = keyof ChamberConstraint;

const CONF_STYLES: Record<ChamberConfidence, string> = {
  Good: 'bg-success-tint text-success',
  High: 'bg-success-tint text-success',
  Moderate: 'bg-bg text-text-secondary border border-border',
  Low: 'bg-accent-tint text-accent-hover',
};

const STATUS_STYLES: Record<ChamberStatus, string> = {
  'within range': 'text-text-secondary',
  'set exact': 'text-primary',
  'capped at max': 'text-accent-hover',
  'raised to min': 'text-accent-hover',
  '! min>max': 'text-danger',
  '= P11 + P12': 'text-primary',
  '= 2 × P10': 'text-primary',
};

/** Format a millimetre value for display (1 decimal, tabular). */
function mm(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** A compact numeric override cell bound to one constraint field. */
function NumCell({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      step="any"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={value ?? ''}
      placeholder="—"
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') {
          onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        onChange(Number.isFinite(parsed) ? parsed : undefined);
      }}
      className={cn(
        'w-20 rounded-sm border border-border bg-surface px-2 py-1 text-sm tabular-nums text-text',
        'transition-colors duration-fast ease-out hover:border-border-strong',
        'focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring/40',
        'placeholder:text-text-secondary',
      )}
    />
  );
}

export function ChamberOutputsTable({
  outputs,
  constraints,
  onConstraintChange,
}: {
  outputs: ChamberOutput[] | null;
  constraints: Partial<Record<ChamberOutputKey, ChamberConstraint>>;
  onConstraintChange: (key: ChamberOutputKey, field: ConstraintField, value: number | undefined) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-lg font-semibold text-text">Parameters</h2>
        <span className="text-xs text-text-secondary">values in mm</span>
      </div>
      {outputs === null ? (
        <p className="px-5 py-8 text-center text-sm text-text-secondary">
          Enter valid inputs to compute the parameters.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Parameter</TableHead>
              <TableHead className="text-right">Model</TableHead>
              <TableHead>Min</TableHead>
              <TableHead>Max</TableHead>
              <TableHead>Exact</TableHead>
              <TableHead className="text-right">Final</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outputs.map((o) => {
              const con = constraints[o.key] ?? {};
              // A derived (identity) output — e.g. Height = P11 + P12 — cannot be
              // constrained directly; its Min/Max/Exact cells are read-only.
              const derived = o.form === 'identity';
              return (
                <TableRow key={o.key}>
                  <TableCell className="font-medium text-text">
                    <span className="inline-flex items-center gap-2">
                      {o.label}
                      {o.refined && (
                        <span
                          title="Refined from its partner's known Exact value (interdependency)"
                          className="inline-block rounded-sm bg-primary-tint px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                        >
                          refined
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-text-secondary">{mm(o.model)}</TableCell>
                  {derived ? (
                    <TableCell colSpan={3} className="text-center text-xs text-text-secondary">
                      derived (see Status)
                    </TableCell>
                  ) : (
                    <>
                      <TableCell>
                        <NumCell
                          value={con.min}
                          ariaLabel={`${o.label} minimum`}
                          onChange={(v) => onConstraintChange(o.key, 'min', v)}
                        />
                      </TableCell>
                      <TableCell>
                        <NumCell
                          value={con.max}
                          ariaLabel={`${o.label} maximum`}
                          onChange={(v) => onConstraintChange(o.key, 'max', v)}
                        />
                      </TableCell>
                      <TableCell>
                        <NumCell
                          value={con.exact}
                          ariaLabel={`${o.label} exact`}
                          onChange={(v) => onConstraintChange(o.key, 'exact', v)}
                        />
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right font-semibold text-text">{mm(o.final)}</TableCell>
                  <TableCell>
                    <span className={cn('text-xs', STATUS_STYLES[o.status])}>{o.status}</span>
                  </TableCell>
                  <TableCell>
                    <span
                      title={`Cross-validation error ${o.cvError}%`}
                      className={cn(
                        'inline-block rounded-sm px-2 py-0.5 text-xs font-medium',
                        CONF_STYLES[o.confidence],
                      )}
                    >
                      {o.confidence}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default ChamberOutputsTable;
