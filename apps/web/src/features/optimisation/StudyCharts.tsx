import { useRef } from 'react';
import type { StudyEvaluation, StudyVortexMetric } from '@dive/shared';
import {
  formatValue,
  niceTicks,
  useMeasuredWidth,
} from '@/features/solver/chartUtils';
import { VORTEX_METRIC_LABEL, vortexOf } from './studyFormat';

/**
 * StudyCharts - the Optimisation tab's two hand-made SVG charts (no chart
 * library, like the Solver tab's): the objective per evaluation with the
 * best-so-far line (weighted mode), and head loss against the picked vortex
 * metric with the Pareto front (both modes). Few points, so each carries a
 * direct label or a marker shape (filled = front / converged, hollow = budget
 * hit or dominated: never colour alone), and a collapsible table is the
 * screen-reader source of truth. Tokens only (brain/design/design-system.md
 * section 2); the best design gets the diamond node (section 1), once.
 *
 * Both charts render at their measured container width and a fixed height, so
 * one viewBox unit is one pixel and labels keep their real size at any width.
 */

const HEIGHT = 240;
const PAD = { top: 16, right: 20, bottom: 40, left: 56 };
const plotH = HEIGHT - PAD.top - PAD.bottom;
/** Below this width the chart would crush its labels: it scrolls sideways instead. */
const MIN_WIDTH = 320;

const summaryClass =
  'w-fit cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2';
const th = 'px-2 py-1 font-medium text-text-secondary';

function Axes({
  width,
  yTicks,
  yOf,
  yLabel,
  xLabel,
}: {
  width: number;
  yTicks: number[];
  yOf: (v: number) => number;
  yLabel: string;
  xLabel: string;
}) {
  const plotW = width - PAD.left - PAD.right;
  return (
    <>
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={yOf(t) + 3}
            textAnchor="end"
            className="fill-text-secondary text-[10px] tabular-nums"
          >
            {formatValue(t)}
          </text>
        </g>
      ))}
      <line
        x1={PAD.left}
        x2={width - PAD.right}
        y1={PAD.top + plotH}
        y2={PAD.top + plotH}
        stroke="var(--color-border-strong)"
        strokeWidth={1}
      />
      <text
        x={14}
        y={PAD.top + plotH / 2}
        textAnchor="middle"
        transform={`rotate(-90 14 ${PAD.top + plotH / 2})`}
        className="fill-text-secondary text-[10px]"
      >
        {yLabel}
      </text>
      <text
        x={PAD.left + plotW / 2}
        y={HEIGHT - 6}
        textAnchor="middle"
        className="fill-text-secondary text-[10px]"
      >
        {xLabel}
      </text>
    </>
  );
}

/** Small diamond marker (the logo node) for the best design. */
function DiamondMark({ x, y }: { x: number; y: number }) {
  return (
    <rect
      x={x - 4.5}
      y={y - 4.5}
      width={9}
      height={9}
      transform={`rotate(45 ${x} ${y})`}
      fill="var(--color-primary)"
    />
  );
}

/** Objective per evaluation (weighted mode), best-so-far as a dashed step line. */
export function ObjectiveChart({
  evaluations,
  best,
}: {
  evaluations: StudyEvaluation[];
  best: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = Math.max(MIN_WIDTH, useMeasuredWidth(box, 560));
  const plotW = width - PAD.left - PAD.right;
  const points = evaluations.filter(
    (e): e is StudyEvaluation & { objective: number } =>
      e.status === 'done' && e.objective !== null,
  );
  if (points.length === 0) {
    return (
      <p className="text-sm text-text-secondary">The chart appears once the baseline is done.</p>
    );
  }
  const maxIndex = Math.max(1, ...evaluations.map((e) => e.index));
  // Integer ticks on a regular step: one per evaluation while they fit (about 44 px
  // each), else a nice step (2, 5, 10...) that never runs past the last index.
  const xTicks = niceTicks(
    0,
    maxIndex,
    Math.max(2, Math.min(maxIndex + 1, Math.floor(plotW / 44))),
  ).filter((t) => Number.isInteger(t) && t >= 0 && t <= maxIndex);
  const values = points.map((p) => p.objective);
  const yTicks = niceTicks(Math.min(...values), Math.max(...values), 4);
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];
  const xOf = (i: number) => PAD.left + (i / maxIndex) * plotW;
  const yOf = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  let running = Infinity;
  const bestSoFar = points.map((p) => {
    running = Math.min(running, p.objective);
    return { x: xOf(p.index), y: yOf(running) };
  });
  const step = bestSoFar
    .flatMap((p, i) =>
      i === 0 ? [`${p.x},${p.y}`] : [`${p.x},${bestSoFar[i - 1].y}`, `${p.x},${p.y}`],
    )
    .join(' ');
  const summary = `Objective per evaluation, lower is better (1 = baseline). ${points
    .map((p) => `#${p.index}: ${p.objective.toFixed(3)}`)
    .join(', ')}.${best !== null ? ` Best: #${best}.` : ''}`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div ref={box} className="w-full overflow-x-auto">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block"
          role="img"
          aria-label={summary}
        >
          <Axes width={width} yTicks={yTicks} yOf={yOf} yLabel="Objective J" xLabel="Evaluation" />
          {xTicks.map((i) => (
            <text
              key={i}
              x={xOf(i)}
              y={PAD.top + plotH + 14}
              textAnchor="middle"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {i}
            </text>
          ))}
          {bestSoFar.length > 1 && (
            <polyline
              points={step}
              fill="none"
              stroke="var(--color-text-secondary)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          )}
          {points.map((p) =>
            p.index === best ? (
              <DiamondMark key={p.index} x={xOf(p.index)} y={yOf(p.objective)} />
            ) : (
              <circle
                key={p.index}
                cx={xOf(p.index)}
                cy={yOf(p.objective)}
                r={3.5}
                fill={p.budgetHit ? 'var(--color-surface)' : 'var(--color-primary)'}
                stroke="var(--color-primary)"
                strokeWidth={1.5}
              />
            ),
          )}
        </svg>
      </div>
      <p className="text-xs text-text-secondary">
        Filled: converged. Hollow: stopped on the time budget. Diamond: best design. Dashed: best so
        far.
      </p>
      <details className="text-xs">
        <summary className={summaryClass}>Show objective values</summary>
        <table
          className="mt-2 w-full max-w-sm text-left tabular-nums"
          aria-label="Objective per evaluation"
        >
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Evaluation
              </th>
              <th scope="col" className={`${th} text-right`}>
                Objective
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.index}>
                <th scope="row" className="px-2 py-1 font-normal text-text">
                  #{p.index}
                  {p.index === best ? ' (best)' : ''}
                </th>
                <td className="px-2 py-1 text-right text-text">{p.objective.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Head loss against the picked vortex metric, Pareto front highlighted. */
export function ParetoChart({
  evaluations,
  front,
  metric,
}: {
  evaluations: StudyEvaluation[];
  front: number[];
  metric: StudyVortexMetric;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = Math.max(MIN_WIDTH, useMeasuredWidth(box, 560));
  const plotW = width - PAD.left - PAD.right;
  const points = evaluations.flatMap((e) => {
    const v = vortexOf(e, metric);
    return e.status === 'done' && e.headLoss !== null && v !== null
      ? [{ index: e.index, headLoss: e.headLoss, vortex: v, onFront: front.includes(e.index) }]
      : [];
  });
  const { name, unit } = VORTEX_METRIC_LABEL[metric];
  if (points.length === 0) {
    return (
      <p className="text-sm text-text-secondary">The chart appears once the baseline is done.</p>
    );
  }
  const xTicks = niceTicks(
    Math.min(...points.map((p) => p.headLoss)),
    Math.max(...points.map((p) => p.headLoss)),
    Math.max(3, Math.min(6, Math.floor(plotW / 90))),
  );
  const yTicks = niceTicks(
    Math.min(...points.map((p) => p.vortex)),
    Math.max(...points.map((p) => p.vortex)),
    4,
  );
  const [xMin, xMax] = [xTicks[0], xTicks[xTicks.length - 1]];
  const [yMin, yMax] = [yTicks[0], yTicks[yTicks.length - 1]];
  const xOf = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const yOf = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  const frontLine = points
    .filter((p) => p.onFront)
    .sort((a, b) => a.headLoss - b.headLoss)
    .map((p) => `${xOf(p.headLoss)},${yOf(p.vortex)}`)
    .join(' ');
  const caption = `Head loss against ${name.toLowerCase()}`;
  const summary = `${caption}, both lower is better. Pareto front: ${points
    .filter((p) => p.onFront)
    .map((p) => `#${p.index}`)
    .join(', ')}.`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div ref={box} className="w-full overflow-x-auto">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block"
          role="img"
          aria-label={summary}
        >
          <Axes
            width={width}
            yTicks={yTicks}
            yOf={yOf}
            yLabel={`${name} (${unit})`}
            xLabel="Head loss (m)"
          />
          {xTicks.map((t) => (
            <text
              key={t}
              x={xOf(t)}
              y={PAD.top + plotH + 14}
              textAnchor="middle"
              className="fill-text-secondary text-[10px] tabular-nums"
            >
              {formatValue(t)}
            </text>
          ))}
          {frontLine.includes(' ') && (
            <polyline
              points={frontLine}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={1.25}
            />
          )}
          {points.map((p) => (
            <g key={p.index}>
              <circle
                cx={xOf(p.headLoss)}
                cy={yOf(p.vortex)}
                r={3.5}
                fill={p.onFront ? 'var(--color-primary)' : 'var(--color-surface)'}
                stroke={p.onFront ? 'var(--color-primary)' : 'var(--color-text-secondary)'}
                strokeWidth={1.5}
              />
              <text
                x={xOf(p.headLoss) + 6}
                y={yOf(p.vortex) - 6}
                className="fill-text-secondary text-[10px] tabular-nums"
              >
                #{p.index}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="text-xs text-text-secondary">
        Filled and joined: Pareto front. Hollow: dominated.
      </p>
      <details className="text-xs">
        <summary className={summaryClass}>Show head loss and vortex values</summary>
        <table className="mt-2 w-full max-w-md text-left tabular-nums" aria-label={caption}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Evaluation
              </th>
              <th scope="col" className={`${th} text-right`}>
                Head loss (m)
              </th>
              <th scope="col" className={`${th} text-right`}>
                {name} ({unit})
              </th>
              <th scope="col" className={th}>
                Front
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.index}>
                <th scope="row" className="px-2 py-1 font-normal text-text">
                  #{p.index}
                </th>
                <td className="px-2 py-1 text-right text-text">{formatValue(p.headLoss)}</td>
                <td className="px-2 py-1 text-right text-text">{formatValue(p.vortex)}</td>
                <td className="px-2 py-1 text-text">{p.onFront ? 'Pareto front' : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
