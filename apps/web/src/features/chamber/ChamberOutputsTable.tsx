import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import chamberDimensionsImg from './assets/chamber-dimensions.png';
import {
  CHAMBER_DIMENSION_MAX_MM,
  CHAMBER_PERMANENT_RELATION_KEYS,
  type ChamberSpiralSummary,
} from '@dive/shared';
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

// Small (12px) text: the orange must be accent-strong — accent/accent-hover
// sit below AA 4.5:1 at this size on white and on the tint.
const CONF_STYLES: Record<ChamberConfidence, string> = {
  Good: 'bg-success-tint text-success',
  High: 'bg-success-tint text-success',
  Moderate: 'bg-bg text-text-secondary border border-border',
  Low: 'bg-accent-tint text-accent-strong',
};

const STATUS_STYLES: Record<ChamberStatus, string> = {
  'within range': 'text-text-secondary',
  'set exact': 'text-primary',
  'capped at max': 'text-accent-strong',
  'raised to min': 'text-accent-strong',
  '! min>max': 'text-danger',
  'from relation': 'text-primary',
  'from spiral': 'text-primary',
};

/**
 * A read-only cell where Min / Max / Exact do not apply: a spiral-derived row, or
 * BF1 / BF2, which always equal LF1 / LF2 (spec 2026-09-29-corner-chamfer-45).
 */
function ReadOnlyCell({ label }: { label: string }) {
  return (
    <span className="inline-block w-20 px-2 py-1 text-sm text-text-secondary" title={label}>
      <span aria-hidden="true">-</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** One-line spiral summary above the table (spec 2026-09-29-semi-spiral-casing). */
function SpiralNote({ summary }: { summary: ChamberSpiralSummary | null }) {
  if (!summary) {
    return (
      <p className="border-b border-border px-5 py-2 text-sm text-text-secondary" role="status">
        Semi-spiral casing: Length, B1, LT and the corner chamfers come from the spiral and fill in
        after Generate.
      </p>
    );
  }
  const extension = summary.inletExtensionMm ?? 0;
  return (
    <p className="border-b border-border px-5 py-2 text-sm text-text-secondary" role="status">
      Semi-spiral casing: {Math.round(summary.widthMm)} mm wide
      {summary.widthBinding ? ', limited by B Kammer' : ''}
      {summary.lengthBinding ? ', limited by the Length Max' : ''}
      {extension > 0 ? `, inlet channel extended by ${Math.round(extension)} mm` : ''}; worst
      cross-section error {summary.worstAreaErrorM2.toFixed(2)} m² at{' '}
      {Math.round(summary.atPhiDeg)}°.
    </p>
  );
}

/**
 * Status of the semi-spiral Length row (spec 2026-09-30-spiral-length): the
 * typed range first, then what the last build did with it.
 */
function spiralLengthStatus(
  con: ChamberConstraint,
  summary: ChamberSpiralSummary | null,
): ChamberStatus {
  if (con.exact != null) return 'set exact';
  if (con.min != null && con.max != null && con.min > con.max) return '! min>max';
  if (summary?.lengthBinding) return 'capped at max';
  if ((summary?.inletExtensionMm ?? 0) > 0) return 'raised to min';
  return 'from spiral';
}

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
      min={0}
      max={CHAMBER_DIMENSION_MAX_MM}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') {
          onChange(undefined);
          return;
        }
        // Only a real dimension may become a constraint: strictly positive,
        // bounded like the API schema. Anything else clears the field (same
        // as emptying it), so `1e999` or a negative can never reach a build.
        const parsed = Number(raw);
        const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= CHAMBER_DIMENSION_MAX_MM;
        onChange(valid ? parsed : undefined);
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
  spiral,
}: {
  outputs: ChamberOutput[] | null;
  constraints: Partial<Record<ChamberOutputKey, ChamberConstraint>>;
  onConstraintChange: (
    key: ChamberOutputKey,
    field: ConstraintField,
    value: number | undefined,
  ) => void;
  /**
   * Semi-spiral casing state: `on` adds the Length row and the spiral note;
   * `summary` is the current build's spiral (null before Generate). The derived
   * rows themselves arrive with status 'from spiral' in `outputs`. `length` /
   * `onLengthChange` carry the Length Min / Max / Exact (spec
   * 2026-09-30-spiral-length); without a handler the Length row is read-only.
   */
  spiral?: {
    on: boolean;
    summary: ChamberSpiralSummary | null;
    length?: ChamberConstraint;
    onLengthChange?: (field: ConstraintField, value: number | undefined) => void;
  };
}) {
  const [legendOpen, setLegendOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-lg font-semibold text-text">Parameters</h2>
        <span className="text-xs text-text-secondary">
          values in mm · empirical values snap to the 50 mm grid
        </span>
      </div>
      {spiral?.on && outputs !== null && <SpiralNote summary={spiral.summary} />}
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
              <TableHead
                className="text-right"
                title="Model estimates are rounded to the nearest 50 mm. Your Exact values and bitten Min/Max pass through unrounded, and identities (= LF1, = LEB + LEOW, …) propagate them verbatim."
              >
                Final
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outputs.map((o) => {
              const con = constraints[o.key] ?? {};
              const derived = o.status === 'from spiral';
              // Semi-spiral Length: derived by the spiral, but Min / Max / Exact
              // apply (Max limits the spiral, Min extends the inlet channel).
              const lengthCon = spiral?.length ?? {};
              const lengthStatus = spiralLengthStatus(lengthCon, spiral?.summary ?? null);
              const onLength = spiral?.onLengthChange;
              const lengthRow =
                o.key === 'width' && spiral?.on ? (
                  <TableRow key="spiral-length">
                    <TableCell className="font-medium text-text">Length</TableCell>
                    <TableCell className="text-right text-text-secondary">-</TableCell>
                    {(['min', 'max', 'exact'] as const).map((field) => {
                      const name = { min: 'minimum', max: 'maximum', exact: 'exact' }[field];
                      return (
                        <TableCell key={field}>
                          {onLength ? (
                            <NumCell
                              value={lengthCon[field]}
                              ariaLabel={`Length ${name}`}
                              onChange={(v) => onLength(field, v)}
                            />
                          ) : (
                            <ReadOnlyCell label={`Length ${name}: read-only, from the spiral`} />
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right font-semibold text-text">
                      {spiral.summary ? mm(spiral.summary.boxMm.length) : '-'}
                    </TableCell>
                    <TableCell>
                      <span className={cn('text-xs', STATUS_STYLES[lengthStatus])}>
                        {lengthStatus}
                      </span>
                    </TableCell>
                    <TableCell className="text-text-secondary">-</TableCell>
                  </TableRow>
                ) : null;
              // Relation-driven outputs (e.g. Height = LEB + LEOW) default to their
              // derived value but can be overridden with Min/Max/Exact like any other,
              // except the permanent BF1 = LF1 / BF2 = LF2 (45° corners), read-only.
              const locked = CHAMBER_PERMANENT_RELATION_KEYS.includes(o.key);
              const lockedNote = `read-only, always equals ${(o.relationLabel ?? '').replace(/^= /, '')}`;
              if (derived) {
                // Spiral-derived row: read-only, no model or confidence claim.
                const ro = `read-only, from the spiral`;
                return (
                  <TableRow key={o.key}>
                    <TableCell className="font-medium text-text">{o.label}</TableCell>
                    <TableCell className="text-right text-text-secondary">-</TableCell>
                    <TableCell>
                      <ReadOnlyCell label={`${o.label} minimum: ${ro}`} />
                    </TableCell>
                    <TableCell>
                      <ReadOnlyCell label={`${o.label} maximum: ${ro}`} />
                    </TableCell>
                    <TableCell>
                      <ReadOnlyCell label={`${o.label} exact: ${ro}`} />
                    </TableCell>
                    <TableCell className="text-right font-semibold text-text">
                      {Number.isFinite(o.final) ? mm(o.final) : '-'}
                    </TableCell>
                    <TableCell>
                      <span className={cn('text-xs', STATUS_STYLES['from spiral'])}>
                        from spiral
                      </span>
                    </TableCell>
                    <TableCell className="text-text-secondary">-</TableCell>
                  </TableRow>
                );
              }
              return (
                <Fragment key={o.key}>
                  <TableRow>
                    <TableCell className="font-medium text-text">
                      <span className="inline-flex items-center gap-2">
                        {o.label}
                        {o.refined && (
                          <span
                            title="Refined from its partner's known Exact value (interdependency)"
                            className="inline-block rounded-sm bg-primary-tint px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                          >
                            refined
                            <span className="sr-only">
                              : refined from its partner&apos;s known Exact value (interdependency)
                            </span>
                          </span>
                        )}
                        {o.noEffect && (
                          <span
                            title="Not used by the build: H Kammer no longer reads LEOW (it is set Exact, or the H = LEB + LEOW relation is off), and the geometry itself never consumes LEOW directly."
                            className="inline-block rounded-sm border border-border bg-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary"
                          >
                            no effect
                            <span className="sr-only">
                              : not used by the build. H Kammer no longer reads LEOW (it is set
                              Exact, or the H = LEB + LEOW relation is off), and the geometry never
                              consumes LEOW directly
                            </span>
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-text-secondary">{mm(o.model)}</TableCell>
                    {locked ? (
                      <>
                        <TableCell>
                          <ReadOnlyCell label={`${o.label} minimum: ${lockedNote}`} />
                        </TableCell>
                        <TableCell>
                          <ReadOnlyCell label={`${o.label} maximum: ${lockedNote}`} />
                        </TableCell>
                        <TableCell>
                          <ReadOnlyCell label={`${o.label} exact: ${lockedNote}`} />
                        </TableCell>
                      </>
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
                    <TableCell
                      className={cn(
                        'text-right font-semibold',
                        o.final <= 0 && !o.noEffect ? 'text-danger' : 'text-text',
                      )}
                    >
                      {mm(o.final)}
                    </TableCell>
                    <TableCell>
                      {o.final <= 0 && !o.noEffect ? (
                        // A non-positive dimension can never build — the server
                        // refuses it; flag it live, before Generate.
                        <span className="text-xs text-danger">! ≤ 0 mm — not buildable</span>
                      ) : (
                        <span className={cn('text-xs', STATUS_STYLES[o.status])}>
                          {o.status === 'from relation' ? o.relationLabel : o.status}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* The CV error is shown, not hidden in a tooltip — title
                        attributes never reach keyboard/touch/screen-reader users. */}
                      <span
                        title={`Leave-one-out cross-validation error: ${o.cvError}%`}
                        className={cn(
                          'inline-block whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium',
                          CONF_STYLES[o.confidence],
                        )}
                      >
                        {o.confidence} · {o.cvError}%
                      </span>
                    </TableCell>
                  </TableRow>
                  {lengthRow}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Dimension legend: the annotated CAD drawings that define every term in
          the table. Collapsed by default so the tall drawing does not push the
          page; the toggle follows the app's disclosure pattern (chevron button
          with aria-expanded, as in the meshing config forms). */}
      <div className="border-t border-border">
        <button
          type="button"
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          className="flex w-full items-center gap-1.5 px-5 py-3 text-left text-sm font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          {legendOpen ? (
            <ChevronDown className="size-4" strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
          )}
          Dimension reference
        </button>
        {legendOpen && (
          <figure className="px-5 pb-4">
            <figcaption className="mb-3 text-xs text-text-secondary">
              Plan view (left): B Kammer, B1, BF1 / BF2, LF1 / LF2, LT. Section view (right): H
              Kammer, LEB, LEOW, HLE, LE Ø.
            </figcaption>
            <img
              src={chamberDimensionsImg}
              alt="Annotated chamber drawings: a plan view locating B Kammer, B1, BF1, BF2, LF1, LF2 and LT, and a section view locating H Kammer, LEB, LEOW, HLE and LE Ø."
              loading="lazy"
              className="h-auto w-full max-w-[1319px]"
            />
          </figure>
        )}
      </div>
    </div>
  );
}

export default ChamberOutputsTable;
