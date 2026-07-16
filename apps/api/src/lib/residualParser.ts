// Pure parser for an OpenFOAM solver log, turning the per-iteration residual
// block into a compact time series plus convergence/divergence signals. Used by
// the run service for both the live stream (parse the tailed log) and the
// catch-up fetch (parse the whole persisted log) — same parser, so a reload
// reconstructs exactly what the live view showed.
//
// simpleFoam prints, per iteration:
//   Time = 142
//   smoothSolver:  Solving for Ux, Initial residual = 0.000843, Final residual = 7.1e-06, ...
//   GAMG:          Solving for p,  Initial residual = 0.0231,   Final residual = 8.8e-04, ...
//   ...
// We key a record on the "Time =" header and collect each field's INITIAL
// residual (the convergence metric; Final is the inner linear-solver detail).
import type { ResidualSample } from '@dive/shared';

/** A "Time = <n>" iteration header (the whole line). */
const TIME_RE = /^\s*Time\s*=\s*([0-9.eE+-]+)\s*$/;
// "Solving for <field>, Initial residual = <value>" (tolerant of the solver
// prefix). The value stops at the first whitespace OR comma so the trailing
// ", Final residual = ..." is never swept into the captured number.
const FIELD_RE = /Solving for (\w+),\s+Initial residual\s*=\s*([^\s,]+)/;
// A residual only ever reads as "nan" / "inf" (any case, optionally signed, and
// even nested in a vector token like "(nan nan nan)") when the solution has
// actually blown up. This is the ONLY divergence signal from a residual value —
// a numeric token we merely fail to parse (see below) is NOT divergence.
const NONFINITE_RESIDUAL_RE = /nan|inf/i;
/** The steady-solver convergence banner. */
const CONVERGED_RE = /solution converged in \d+ iterations/i;
/** A FOAM fatal error: bad config, a missing patch or file, a caught exception. */
const FOAM_FATAL_RE = /FOAM FATAL|#0\s+Foam::error/i;
/**
 * A floating-point exception actually FIRING: the signal handler in the stack trace,
 * or the shell's notice when the solver dies on SIGFPE.
 */
const FPE_CRASH_RE = /Foam::sigFpe::sigHandler|floating point exception/i;
/**
 * ...but OpenFOAM announces FPE TRAPPING at startup whenever FOAM_SIGFPE is set (the
 * default), and that banner contains the very same phrase:
 *   "trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE)."
 * It means the trap is ARMED, not that anything went wrong. Matching the bare phrase
 * classified EVERY healthy run as diverged, so the banner must be excluded.
 */
const FPE_BANNER_RE = /trapfpe|trapping enabled/i;

/** Does this line show a floating-point exception that really fired? */
function isFpeCrash(line: string): boolean {
  return FPE_CRASH_RE.test(line) && !FPE_BANNER_RE.test(line);
}

/** Outcome of parsing a (partial or full) solver log. */
export interface ParsedResiduals {
  /** One record per iteration, in order. */
  samples: ResidualSample[];
  /**
   * The solution blew up: the LAST iteration in the log had a nan/inf residual.
   * Judged on the run's final state, not its history, because a blow-up never
   * recovers (nan propagates) while a one-off non-finite residual can appear on an
   * early iteration and clear - typically the 0/0 residual normalisation of a field
   * that starts uniform. A sticky "saw nan once" flag condemned runs that went on to
   * finish perfectly well; see `nonFiniteSeen` for that weaker signal.
   */
  diverged: boolean;
  /** A nan/inf residual appeared at SOME point (even if the run recovered). */
  nonFiniteSeen: boolean;
  /** The solver printed its steady-convergence banner. */
  converged: boolean;
  /** A FOAM fatal error / a floating-point exception that really fired. */
  foamError: boolean;
  /**
   * A floating-point exception FIRED (the solution blew up). False for the harmless
   * "trapping enabled" startup banner, which is present in every run's log.
   */
  fpe: boolean;
  /** The last iteration index seen, or null when none. */
  lastTime: number | null;
}

/** Parse residuals and convergence signals from a solver log (or a chunk of it). */
export function parseResiduals(log: string): ParsedResiduals {
  const lines = log.split(/\r?\n/);
  const samples: ResidualSample[] = [];
  let current: ResidualSample | null = null;
  let converged = false;
  let foamError = false;
  let fpe = false;
  let lastTime: number | null = null;
  let nonFiniteSeen = false; // a nan/inf residual anywhere in the log
  let currentNonFinite = false; // ... in the iteration being read right now
  let lastNonFinite = false; // ... in the last iteration the log completed

  const flush = (): void => {
    if (!current) return;
    if (Object.keys(current.values).length > 0) {
      samples.push(current);
    }
    // Close this iteration out: only its verdict survives as the run's final state.
    lastNonFinite = currentNonFinite;
  };

  for (const line of lines) {
    const timeMatch = TIME_RE.exec(line);
    if (timeMatch) {
      flush();
      currentNonFinite = false; // a fresh iteration starts clean
      const time = Number(timeMatch[1]);
      const index = Number.isFinite(time) ? time : samples.length + 1;
      current = { time: index, values: {} };
      lastTime = index;
      continue;
    }

    if (CONVERGED_RE.test(line)) converged = true;
    if (isFpeCrash(line)) fpe = true;
    if (FOAM_FATAL_RE.test(line) || isFpeCrash(line)) foamError = true;

    const fieldMatch = FIELD_RE.exec(line);
    if (fieldMatch && current) {
      const raw = fieldMatch[2];
      if (NONFINITE_RESIDUAL_RE.test(raw)) {
        // nan / inf. Only a blow-up that is STILL non-finite on the last iteration
        // counts as divergence, so note it against this iteration and move on.
        // Don't record the point (there is no finite value to chart).
        nonFiniteSeen = true;
        currentNonFinite = true;
        continue;
      }
      // Strip a leading "(" so a vector residual like "(0.012 0.008 0.005)"
      // (some fields on ESI OpenFOAM print U this way) still yields a finite
      // component to chart instead of a NaN.
      const value = Number(raw.replace(/^\(/, ''));
      // A token we can't parse (an unexpected format) is NOT divergence: simply
      // skip it. Flagging it as diverged is what made a run that merely reached
      // its controlDict iteration cap get reported as "diverged".
      if (Number.isFinite(value)) {
        current.values[fieldMatch[1]] = value;
      }
    }
  }
  flush();

  return { samples, diverged: lastNonFinite, converged, foamError, fpe, nonFiniteSeen, lastTime };
}

/** Last-written y+ stats of one wall patch, from the yPlus functionObject's log lines. */
export interface YPlusEntry {
  patch: string;
  min: number;
  max: number;
  avg: number;
}

// "    patch wall y+ : min = 16.54, max = 6121.33, average = 579.84"
const YPLUS_RE =
  /patch\s+(\S+)\s+y\+\s*:\s*min\s*=\s*([\d.eE+-]+),\s*max\s*=\s*([\d.eE+-]+),\s*average\s*=\s*([\d.eE+-]+)/;

/**
 * Extract per-patch y+ from a solver log, when the case runs a yPlus functionObject
 * (nothing is injected - a case without one simply yields []). The LAST occurrence
 * per patch wins (the converged state). Wall functions are valid roughly for
 * 30 < y+ < 300; the caller uses these to flag physics trust, never to fail a run.
 */
export function parseYPlus(log: string): YPlusEntry[] {
  const byPatch = new Map<string, YPlusEntry>();
  for (const line of log.split(/\r?\n/)) {
    const m = YPLUS_RE.exec(line);
    if (!m) continue;
    const [min, max, avg] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(avg)) {
      byPatch.set(m[1], { patch: m[1], min, max, avg });
    }
  }
  return [...byPatch.values()];
}

/**
 * Downsample a residual series to at most `maxPoints`, keeping the most recent
 * points dense and decimating the older history. Residuals read fine coarse on a
 * log axis, so this keeps a long run's payload bounded without hiding the tail.
 */
export function downsampleResiduals(
  samples: ResidualSample[],
  maxPoints = 4000,
): ResidualSample[] {
  if (samples.length <= maxPoints) return samples;
  const keepRecent = Math.floor(maxPoints / 2);
  const recent = samples.slice(samples.length - keepRecent);
  const history = samples.slice(0, samples.length - keepRecent);
  const stride = Math.ceil(history.length / (maxPoints - keepRecent));
  const thinned = history.filter((_, i) => i % stride === 0);
  return [...thinned, ...recent];
}
