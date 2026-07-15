// Objective extraction for the diameter-optimization sweep: inject the total-
// pressure functionObjects into a case's controlDict, then read the mass-flow-
// averaged total pressure at the inlet/outlet from the run's postProcessing output
// to compute the pressure drop (the "water loss") the sweep minimises.
//
// The functionObject recipe mirrors the DIVE team's proven controlDict template
// (the shipped system/controlDict): a `pressure` FO computes total pressure
// (kinematic, so this assumes an INCOMPRESSIBLE solver — simpleFoam/pimpleFoam,
// where p is p/rho), and two `surfaceFieldValue` FOs take its phi-weighted
// (mass-flow) average over the inlet and outlet patches. Injection is idempotent
// (a marked region), and the pure text/parse helpers are unit-testable.
//
// SIGN/UNITS to verify on the OpenFOAM box (cannot run here): the drop is measured
// as |pTotInlet - pTotOutlet| (a passive pipe loses total pressure downstream, so
// the magnitude is the loss); for a compressible solver p is already in Pa and the
// densityKgM3 multiply would be wrong — v1 targets incompressible pipe flow.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StudyMetrics } from '@dive/shared';

/** Standard gravity, for head loss in metres of fluid column. */
const GRAVITY = 9.81;

// FO + result-field names, namespaced so they never clash with a case's own FOs.
// The surfaceFieldValue FOs write postProcessing/<name>/<time>/surfaceFieldValue.dat.
const INLET_FO = 'diveObjInlet';
const OUTLET_FO = 'diveObjOutlet';
const PTOTAL_RESULT = 'divePTot';
const MARKER_START = '// <<< dive-optimisation objective (auto-generated) >>>';
const MARKER_END = '// <<< /dive-optimisation objective >>>';

/** A surfaceFieldValue probe of the total-pressure field over one patch. */
function probe(name: string, patch: string): string {
  return (
    `    ${name}\n    {\n` +
    `        type        surfaceFieldValue;\n` +
    `        libs        (fieldFunctionObjects);\n` +
    `        regionType  patch;\n` +
    `        name        ${patch};\n` +
    `        operation   weightedAverage;\n` +
    `        weightField phi;\n` +
    `        fields      (${PTOTAL_RESULT});\n` +
    `        writeFields false;\n` +
    `        log         true;\n` +
    `        writeControl    timeStep;\n` +
    `        writeInterval   1;\n` +
    `    }\n`
  );
}

/** The full objective block (total-pressure FO + inlet/outlet probes), marked. */
function objectiveBlock(inletPatch: string, outletPatch: string): string {
  return (
    `    ${MARKER_START}\n` +
    `    diveObjPTotal\n    {\n` +
    `        type    pressure;\n` +
    `        libs    (fieldFunctionObjects);\n` +
    `        field   p;\n` +
    `        mode    total;\n` +
    `        rho     rhoInf;\n` +
    `        rhoInf  1;\n` +
    `        result  ${PTOTAL_RESULT};\n` +
    `        executeControl  timeStep;\n` +
    `        executeInterval 1;\n` +
    `        writeControl    writeTime;\n` +
    `    }\n` +
    probe(INLET_FO, inletPatch) +
    probe(OUTLET_FO, outletPatch) +
    `    ${MARKER_END}\n`
  );
}

/**
 * Inject (or replace) the objective functionObjects in a controlDict, keyed to the
 * inlet/outlet patches. Idempotent: re-injecting replaces the previously-marked
 * region. Inserts into an existing functions{} dictionary, or adds one when absent.
 */
export function injectObjectiveFunctions(
  controlDict: string,
  inletPatch: string,
  outletPatch: string,
): string {
  const block = objectiveBlock(inletPatch, outletPatch);

  // 1) Replace a previously-injected marked region (with its leading indent + trailing newline).
  const s = controlDict.indexOf(MARKER_START);
  if (s >= 0) {
    const e = controlDict.indexOf(MARKER_END, s);
    if (e >= 0) {
      let start = s;
      while (start > 0 && (controlDict[start - 1] === ' ' || controlDict[start - 1] === '\t')) {
        start -= 1;
      }
      let end = e + MARKER_END.length;
      if (controlDict[end] === '\r') end += 1;
      if (controlDict[end] === '\n') end += 1;
      return controlDict.slice(0, start) + block + controlDict.slice(end);
    }
  }

  // 2) Insert into an existing functions{} dictionary, right after its opening brace.
  const fn = controlDict.match(/functions\s*\{/);
  if (fn && fn.index !== undefined) {
    const at = fn.index + fn[0].length;
    return `${controlDict.slice(0, at)}\n${block}${controlDict.slice(at)}`;
  }

  // 3) No functions{} — add one before the trailing footer (or at EOF).
  const footer = controlDict.lastIndexOf('// *****');
  const at = footer >= 0 ? footer : controlDict.length;
  const fnBlock = `functions\n{\n${block}}\n\n`;
  return controlDict.slice(0, at) + fnBlock + controlDict.slice(at);
}

/** Strip the injected objective functionObjects (leave the case clean after a sweep). */
export function removeObjectiveFunctions(controlDict: string): string {
  const s = controlDict.indexOf(MARKER_START);
  if (s < 0) return controlDict;
  const e = controlDict.indexOf(MARKER_END, s);
  if (e < 0) return controlDict;
  let start = s;
  while (start > 0 && (controlDict[start - 1] === ' ' || controlDict[start - 1] === '\t')) {
    start -= 1;
  }
  let end = e + MARKER_END.length;
  if (controlDict[end] === '\r') end += 1;
  if (controlDict[end] === '\n') end += 1;
  return controlDict.slice(0, start) + controlDict.slice(end);
}

/**
 * Parse a surfaceFieldValue .dat file: return the LAST data row's last column (the
 * final, converged averaged value), or null when the file has no data rows.
 */
export function parseSurfaceFieldValueDat(content: string): number | null {
  let value: number | null = null;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const tokens = t.split(/\s+/);
    const v = Number(tokens[tokens.length - 1]);
    if (Number.isFinite(v)) value = v;
  }
  return value;
}

/** Read the mass-flow-averaged value from a FO's latest postProcessing time folder. */
async function readMassFlowAvg(caseDir: string, foName: string): Promise<number | null> {
  const dir = path.join(caseDir, 'postProcessing', foName);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const times = entries
    .map((e) => ({ e, t: Number(e) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (times.length === 0) return null;
  const latest = times[times.length - 1].e;
  try {
    const dat = await fs.readFile(path.join(dir, latest, 'surfaceFieldValue.dat'), 'utf8');
    return parseSurfaceFieldValueDat(dat);
  } catch {
    return null;
  }
}

/**
 * Turn inlet/outlet total pressures into the loss metrics. The drop is the magnitude
 * of the inlet-minus-outlet total pressure (a passive pipe loses total pressure
 * downstream); pressureDropPa multiplies the kinematic drop by density, head loss
 * divides by g.
 */
export function computeMetrics(
  inletTotal: number,
  outletTotal: number,
  densityKgM3: number,
): StudyMetrics {
  const dpKin = Math.abs(inletTotal - outletTotal); // kinematic drop (m^2/s^2)
  return { pressureDropPa: dpKin * densityKgM3, headLossM: dpKin / GRAVITY };
}

/**
 * Read the sweep objective from a finished run's postProcessing output. Returns null
 * when either probe produced no data (e.g. the FOs did not run / patch mismatch).
 */
export async function readObjective(
  caseDir: string,
  densityKgM3: number,
): Promise<StudyMetrics | null> {
  const inlet = await readMassFlowAvg(caseDir, INLET_FO);
  const outlet = await readMassFlowAvg(caseDir, OUTLET_FO);
  if (inlet === null || outlet === null) return null;
  return computeMetrics(inlet, outlet, densityKgM3);
}
