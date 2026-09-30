import type { FreeSurfaceSurfaceStats } from '@dive/shared';

/**
 * ResidualPerIterationChart - the lid residual RMS (mm) per iteration, with the
 * tolerance as a dashed reference line. Hand-made SVG like the solver's
 * ResidualChart (no chart library): a handful of points, so every point carries
 * a direct value label, and a collapsible table is the screen-reader source of
 * truth. Colors from the token scale only (brain/design/design-system.md section 2).
 */

const WIDTH = 480;
const HEIGHT = 180;
const PAD = { top: 20, right: 24, bottom: 30, left: 44 };

export function ResidualPerIterationChart({
  surfaces,
  tolRmsMm,
}: {
  surfaces: FreeSurfaceSurfaceStats[];
  tolRmsMm: number;
}) {
  if (surfaces.length === 0) return null;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const yMax = Math.max(tolRmsMm, ...surfaces.map((s) => s.residualRmsMm)) * 1.15 || 1;
  const xOf = (i: number) =>
    PAD.left + (surfaces.length === 1 ? plotW / 2 : (i / (surfaces.length - 1)) * plotW);
  const yOf = (v: number) => PAD.top + (1 - v / yMax) * plotH;
  const points = surfaces.map((s, i) => ({ x: xOf(i), y: yOf(s.residualRmsMm), s }));
  const tolY = yOf(tolRmsMm);
  const label = (index: number) => (index === 0 ? 'Parent' : `It. ${index}`);
  const summary = `Lid residual RMS per iteration, in mm, lower is better. ${surfaces
    .map((s) => `${label(s.index)}: ${s.residualRmsMm.toFixed(1)}`)
    .join(', ')}. Tolerance ${tolRmsMm.toFixed(1)} mm.`;

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full max-w-xl"
        role="img"
        aria-label={summary}
      >
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="var(--color-border-strong)"
          strokeWidth={1}
        />
        <text
          x={PAD.left - 8}
          y={PAD.top + plotH + 3}
          textAnchor="end"
          className="fill-text-secondary text-[10px]"
        >
          0
        </text>
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={tolY}
          y2={tolY}
          stroke="var(--color-text-secondary)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text
          x={PAD.left - 8}
          y={tolY + 3}
          textAnchor="end"
          className="fill-text-secondary text-[10px] tabular-nums"
        >
          {tolRmsMm.toFixed(1)}
        </text>
        <text
          x={WIDTH - PAD.right}
          y={tolY - 5}
          textAnchor="end"
          className="fill-text-secondary text-[10px]"
        >
          tolerance
        </text>
        {points.length > 1 && (
          <polyline
            points={points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {points.map((p) => (
          <g key={p.s.index}>
            <circle cx={p.x} cy={p.y} r={3} fill="var(--color-primary)" />
            <text
              x={p.x}
              y={p.y - 8}
              textAnchor="middle"
              className="fill-text text-[10px] font-semibold tabular-nums"
            >
              {p.s.residualRmsMm.toFixed(1)}
            </text>
            <text
              x={p.x}
              y={PAD.top + plotH + 16}
              textAnchor="middle"
              className="fill-text-secondary text-[10px]"
            >
              {label(p.s.index)}
            </text>
          </g>
        ))}
        <text
          x={12}
          y={PAD.top + plotH / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}
          className="fill-text-secondary text-[10px]"
        >
          RMS (mm)
        </text>
      </svg>
      <details className="text-xs">
        <summary className="w-fit cursor-pointer rounded-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">
          Show residual values
        </summary>
        <table className="mt-2 w-full max-w-sm text-left tabular-nums">
          <caption className="sr-only">{summary}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-2 py-1 font-medium text-text-secondary">
                Iteration
              </th>
              <th scope="col" className="px-2 py-1 text-right font-medium text-text-secondary">
                Residual RMS (mm)
              </th>
            </tr>
          </thead>
          <tbody>
            {surfaces.map((s) => (
              <tr key={s.index}>
                <th scope="row" className="px-2 py-1 font-normal text-text">
                  {s.index === 0 ? 'Parent' : s.index}
                </th>
                <td className="px-2 py-1 text-right text-text">{s.residualRmsMm.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
