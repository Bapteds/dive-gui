import { useEffect, useState, type RefObject } from 'react';

/**
 * Small helpers shared by the Solver tab's hand-made SVG charts (pressure drop,
 * vortex metrics). The residual chart predates them and keeps its own log-axis
 * code. Charts render at the measured container width and a fixed height, so one
 * viewBox unit is one pixel and text keeps its real size.
 */

/** Track an element's content width (ResizeObserver), starting at `initial`. */
export function useMeasuredWidth(ref: RefObject<HTMLElement>, initial = 680): number {
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** "Nice" evenly spaced ticks covering [min, max] (about `count` of them). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.05 : 1;
    return niceTicks(min - pad, max + pad, count);
  }
  const rough = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** A compact number: 4 significant digits, no float noise ("19700", "2.008"). */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7)) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

/** Integer iteration ticks across [xMin, xMax]. */
export function iterationTicks(xMin: number, xMax: number, count = 5): number[] {
  const n = Math.min(count, Math.max(2, Math.round(xMax - xMin) + 1));
  const ticks = Array.from({ length: n }, (_, i) => Math.round(xMin + ((xMax - xMin) * i) / (n - 1)));
  return [...new Set(ticks)];
}
