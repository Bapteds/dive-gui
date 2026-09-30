// Pure parser for the WS-G monitor lines of a solver log (spec
// brain/specs/2026-09-30-solver-convergence-vorticity-design.md section 5):
//  - the `surfaceFieldValue inlet_p0_flux / outlet_p0_flux write:` blocks of
//    pressureLossMonitors (weightedAverage(...) of pTotal = v) => one Dp0 per
//    iteration (inlet - outlet, Pa);
//  - the SimplePDropConvergence / convergenceControl progress lines => the latest
//    criterion progress;
//  - the diveVortexMetrics lines => one vortex sample per evaluated time.
// Tolerant regexes: the exact v2406 surfaceFieldValue wording is to validate on
// the server, and when those lines are not recognised the dp0 printed by
// SimplePDropConvergence is used as a fallback source.
import type {
  CriterionProgress,
  PressureDropSample,
  RunMonitors,
  VortexMetricsSample,
} from '@dive/shared';

const NUM = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)';

const TIME_RE = /^\s*Time\s*=\s*([0-9.eE+-]+)\s*$/;
const SFV_HEADER_RE = /^\s*surfaceFieldValue\s+(\S+)\s+write:/;
const PTOTAL_RE = new RegExp(`weighted\\w*\\s*\\([^)]*\\)\\s+(?:of\\s+)?pTotal\\s*=\\s*${NUM}`, 'i');
const FILLING_RE = new RegExp(
  `SimplePDropConvergence:\\s*filling window\\s+(\\d+)\\s*/\\s*(\\d+),\\s*dp0\\s*=\\s*${NUM}`,
);
const SIMPLE_RE = new RegExp(
  `SimplePDropConvergence:\\s*dp0\\s*=\\s*${NUM}\\s*Pa,\\s*mean\\s*=\\s*${NUM}\\s*Pa,\\s*dev\\s*=\\s*${NUM}\\s*%,\\s*consecutive\\s*=\\s*(\\d+)\\s*/\\s*(\\d+)`,
);
const ROBUST_RE = new RegExp(
  `convergenceControl\\s*@\\s*${NUM}\\s*:\\s*drift=${NUM}\\s*Pa\\s+trend=${NUM}\\s*Pa\\s+maxRes=${NUM}\\s+\\[mean:([yn])\\s+slope:([yn])\\s+res:([yn])\\]\\s+pass\\s+(\\d+)\\s*/\\s*(\\d+)`,
);
const VORTEX_RE = new RegExp(
  `diveVortexMetrics:\\s*time=${NUM}\\s+qVolume=${NUM}\\s+maskedQVolume=${NUM}\\s+omegaRms=${NUM}\\s+coreVolume=${NUM}\\s+coreCells=(\\d+)`,
);

/**
 * Downsample a series to at most `maxPoints`, keeping the recent half dense and
 * thinning the older history (same policy as the residual series).
 */
export function downsampleSeries<T>(samples: T[], maxPoints = 4000): T[] {
  if (samples.length <= maxPoints) return samples;
  const keepRecent = Math.floor(maxPoints / 2);
  const recent = samples.slice(samples.length - keepRecent);
  const history = samples.slice(0, samples.length - keepRecent);
  const stride = Math.ceil(history.length / (maxPoints - keepRecent));
  return [...history.filter((_, i) => i % stride === 0), ...recent];
}

/** Parse the monitor lines of a solver log (or a postProcess output). */
export function parseMonitors(log: string, maxPoints = 4000): RunMonitors {
  const lines = log.split(/\r?\n/);
  let time: number | null = null;
  let block: string | null = null;
  // Per-iteration inlet / outlet total pressure (keyed by iteration).
  const inlet = new Map<number, number>();
  const outlet = new Map<number, number>();
  const foDp0 = new Map<number, number>();
  const order: number[] = [];
  const seen = new Set<number>();
  const touch = (t: number) => {
    if (!seen.has(t)) {
      seen.add(t);
      order.push(t);
    }
  };
  let criterion: CriterionProgress | null = null;
  const vortex = new Map<number, VortexMetricsSample>();

  for (const line of lines) {
    const timeMatch = TIME_RE.exec(line);
    if (timeMatch) {
      const t = Number(timeMatch[1]);
      time = Number.isFinite(t) ? t : time;
      block = null;
      continue;
    }

    const header = SFV_HEADER_RE.exec(line);
    if (header) {
      block = header[1];
      continue;
    }
    if (block && time !== null) {
      const value = PTOTAL_RE.exec(line);
      if (value) {
        const v = Number(value[1]);
        if (Number.isFinite(v)) {
          if (block === 'inlet_p0_flux') inlet.set(time, v);
          else if (block === 'outlet_p0_flux') outlet.set(time, v);
          touch(time);
        }
        continue;
      }
      if (line.trim() === '') block = null;
    }

    const filling = FILLING_RE.exec(line);
    if (filling) {
      if (time !== null) {
        foDp0.set(time, Number(filling[3]));
        touch(time);
      }
      criterion = {
        method: 'simplePDrop',
        consecutive: 0,
        required: null,
        devPct: null,
        mean: null,
        filling: { filled: Number(filling[1]), size: Number(filling[2]) },
      };
      continue;
    }
    const simple = SIMPLE_RE.exec(line);
    if (simple) {
      if (time !== null) {
        foDp0.set(time, Number(simple[1]));
        touch(time);
      }
      criterion = {
        method: 'simplePDrop',
        consecutive: Number(simple[4]),
        required: Number(simple[5]),
        devPct: Number(simple[3]),
        mean: Number(simple[2]),
        filling: null,
      };
      continue;
    }
    const robust = ROBUST_RE.exec(line);
    if (robust) {
      criterion = {
        method: 'robust',
        time: Number(robust[1]),
        drift: Number(robust[2]),
        trend: Number(robust[3]),
        maxRes: Number(robust[4]),
        passes: Number(robust[8]),
        required: Number(robust[9]),
        gates: { mean: robust[5] === 'y', slope: robust[6] === 'y', res: robust[7] === 'y' },
      };
      continue;
    }
    const vx = VORTEX_RE.exec(line);
    if (vx) {
      const sample: VortexMetricsSample = {
        time: Number(vx[1]),
        qVolume: Number(vx[2]),
        maskedQVolume: Number(vx[3]),
        omegaRms: Number(vx[4]),
        coreVolume: Number(vx[5]),
        coreCells: Number(vx[6]),
      };
      if (Object.values(sample).every(Number.isFinite)) vortex.set(sample.time, sample);
    }
  }

  // Dp0 from the monitors when both patches were read; else the FO's own dp0.
  const fromMonitors: PressureDropSample[] = [];
  const fromFo: PressureDropSample[] = [];
  for (const t of order) {
    const pin = inlet.get(t);
    const pout = outlet.get(t);
    if (pin !== undefined && pout !== undefined) fromMonitors.push({ time: t, dp0: pin - pout });
    const fo = foDp0.get(t);
    if (fo !== undefined) fromFo.push({ time: t, dp0: fo });
  }
  const pressureDrop = fromMonitors.length > 0 ? fromMonitors : fromFo;

  return {
    pressureDrop: downsampleSeries(pressureDrop, maxPoints),
    criterion,
    vortex: [...vortex.values()].sort((a, b) => a.time - b.time),
  };
}
