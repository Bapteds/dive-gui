// Pure renderers for the solver convergence criteria and vortex metrics (WS-G,
// spec brain/specs/2026-09-30-solver-convergence-vorticity-design.md).
//
// The three convergence files are the user's tools (documents/Tools/
// ConvergenceFunctions) kept VERBATIM, with only their USER INPUTS (and, in
// pressureLossMonitors, the patch names and rhoInf; in convergenceControl, the
// kinematic-to-Pa factor that is the same rho) substituted. The tests compare the
// renders byte for byte against those files, so any drift is caught.
// diveVortexMetrics is DIVE's own coded function object reproducing the user's
// VorticityFunction tools (postVorticity.sh + the Q-core RMS method) in one pass,
// with v2406-safe OpenFOAM API only.
//
// Also: the managed `#include` lines inside `functions { }` of system/controlDict,
// and the residualControl comment-out used by the robust criterion.
import type {
  CfdCriteriaSettings,
  ConvergenceSettings,
  VortexMetricsSettings,
} from '@dive/shared';
import { DEFAULT_CFD_CRITERIA } from '@dive/shared';
import { AppError } from './AppError';

/** Function-object files DIVE manages, in include order (monitors first: pTotal). */
export const MANAGED_INCLUDES = [
  'pressureLossMonitors',
  'SimplePDropConvergence',
  'convergenceControl',
  'diveVortexMetrics',
] as const;
export type ManagedInclude = (typeof MANAGED_INCLUDES)[number];

/** Marker of the commented-out residualControl block (robust criterion). */
export const DIVE_RESIDUAL_MARKER = 'DIVE convergence: residualControl disabled (robust criterion)';

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * A C++ scalar literal: integers keep a `.0` (the tools write `50.0`, `1000.0`),
 * small values use the exponent form the tools use (`1e-3`), others plain.
 */
export function cppScalar(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toFixed(1);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-2 || abs >= 1e15)) return value.toExponential().replace('e+', 'e');
  return String(value);
}

/** A C++ label (integer) literal. */
function cppLabel(value: number): string {
  return String(Math.trunc(value));
}

/** A number in an OpenFOAM dictionary (`rhoInf 1000;`). */
function foamNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) return value.toExponential();
  return String(value);
}

/**
 * Replace exactly one occurrence of `from` in `text` (a template placeholder
 * line). Throws when the template drifted, so a bad edit never renders silently.
 */
function substitute(text: string, from: string, to: string, all = false): string {
  const count = text.split(from).length - 1;
  if (count === 0 || (!all && count !== 1)) {
    throw new Error(`cfdCriteria template drift: "${from}" found ${count} times`);
  }
  return all ? text.split(from).join(to) : text.replace(from, to);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** system/pressureLossMonitors: pTotal + inlet/outlet flux-weighted monitors. */
export function renderPressureLossMonitors(c: ConvergenceSettings): string {
  let out = PRESSURE_LOSS_MONITORS_TEMPLATE;
  out = substitute(out, 'name  inlet;', `name  ${c.inletPatch};`, true);
  out = substitute(out, 'name  outlet;', `name  ${c.outletPatch};`, true);
  out = substitute(out, 'rhoInf          1000;', `rhoInf          ${foamNumber(c.rho)};`);
  return out;
}

/** system/SimplePDropConvergence: the simple auto-stop coded function object. */
export function renderSimplePDropConvergence(c: ConvergenceSettings): string {
  let out = SIMPLE_PDROP_CONVERGENCE_TEMPLATE;
  out = substitute(out, 'inletPatch  = "inlet";', `inletPatch  = "${c.inletPatch}";`);
  out = substitute(out, 'outletPatch = "outlet";', `outletPatch = "${c.outletPatch}";`);
  out = substitute(out, 'window = 100;', `window = ${cppLabel(c.simplePDrop.window)};`);
  out = substitute(out, 'devTol = 0.03;', `devTol = ${cppScalar(c.simplePDrop.devTol)};`);
  out = substitute(out, 'nPass  = 100;', `nPass  = ${cppLabel(c.simplePDrop.nPass)};`);
  return out;
}

/**
 * system/convergenceControl: the robust auto-stop coded function object. Besides
 * the USER INPUTS, the kinematic-to-Pa factor `*1000.0` is the density: it takes
 * the project's rho so Dp0 matches pressureLossMonitors (identical at 1000).
 */
export function renderConvergenceControl(c: ConvergenceSettings): string {
  let out = CONVERGENCE_CONTROL_TEMPLATE;
  out = substitute(out, 'inletPatch  = "inlet";', `inletPatch  = "${c.inletPatch}";`);
  out = substitute(out, 'outletPatch = "outlet";', `outletPatch = "${c.outletPatch}";`);
  out = substitute(out, 'W       = 100;', `W       = ${cppLabel(c.robust.W)};`);
  out = substitute(out, 'tolMean = 50.0;', `tolMean = ${cppScalar(c.robust.tolMean)};`);
  out = substitute(out, 'K       = 2;', `K       = ${cppLabel(c.robust.K)};`);
  out = substitute(out, 'resTol  = 1e-3;', `resTol  = ${cppScalar(c.robust.resTol)};`);
  out = substitute(out, '*1000.0;', `*${cppScalar(c.rho)};`);
  return out;
}

/** system/diveVortexMetrics: DIVE's vortex-metrics coded function object. */
export function renderDiveVortexMetrics(v: VortexMetricsSettings): string {
  return DIVE_VORTEX_METRICS_TEMPLATE.replace('__INTERVAL__', cppLabel(v.interval))
    .replace('__VELOCITY__', v.velocityField)
    .replace('__Q_THRESHOLD__', cppScalar(v.qThreshold))
    .replace('__WALL_DISTANCE__', cppScalar(v.wallDistance))
    .replace('__Q_CRIT__', cppScalar(v.qCrit))
    .replace('__V_MIN__', cppScalar(v.vMin))
    .replace('__WRITE_FIELDS__', v.writeFields ? 'true' : 'false');
}

// ---------------------------------------------------------------------------
// Defaults, validation, install plan
// ---------------------------------------------------------------------------

/**
 * Defaults resolved on the mesh patches: `inlet` / `outlet` when present, else the
 * first two `patch`-type patches. When two patches cannot be found, the pressure
 * drop criteria cannot run: the method falls back to `residuals`.
 */
export function defaultCfdCriteria(
  patches: ReadonlyArray<{ name: string; type: string }>,
): CfdCriteriaSettings {
  const base = structuredClone(DEFAULT_CFD_CRITERIA);
  const names = patches.map((p) => p.name);
  let inlet = names.includes('inlet') ? 'inlet' : '';
  let outlet = names.includes('outlet') ? 'outlet' : '';
  const candidates = patches
    .filter((p) => p.type === 'patch' && p.name !== inlet && p.name !== outlet)
    .map((p) => p.name);
  if (!inlet) inlet = candidates.shift() ?? '';
  if (!outlet) outlet = candidates.shift() ?? '';
  if (!inlet || !outlet) {
    base.convergence.method = 'residuals';
    base.convergence.inletPatch = inlet;
    base.convergence.outletPatch = outlet;
    return base;
  }
  base.convergence.inletPatch = inlet;
  base.convergence.outletPatch = outlet;
  return base;
}

/** Why the inlet / outlet pair cannot be used on this mesh, or null when it can. */
export function patchProblem(c: ConvergenceSettings, patchNames: readonly string[]): string | null {
  if (!c.inletPatch) return 'Pick the inlet patch.';
  if (!c.outletPatch) return 'Pick the outlet patch.';
  if (c.inletPatch === c.outletPatch) return 'The inlet and outlet patches must differ.';
  for (const name of [c.inletPatch, c.outletPatch]) {
    if (!patchNames.includes(name)) return `Patch "${name}" does not exist in the mesh.`;
  }
  return null;
}

/** What installing a set of criteria writes into the case. */
export interface CriteriaInstallPlan {
  /** Case-relative path -> content (system/ files). */
  files: Record<string, string>;
  /** Managed includes to set in controlDict `functions { }`, in order. */
  includes: ManagedInclude[];
  /** What to do with SIMPLE.residualControl in system/fvSolution. */
  residualControl: 'disable' | 'restore';
}

/**
 * Plan the install of `settings` on a mesh with `patchNames`.
 * @throws 422 CRITERIA_INVALID when a pressure-drop method has an unusable patch pair.
 */
export function planCriteriaInstall(
  settings: CfdCriteriaSettings,
  patchNames: readonly string[],
): CriteriaInstallPlan {
  const c = settings.convergence;
  const problem = patchProblem(c, patchNames);
  const pressureMethod = c.method !== 'residuals';
  if (pressureMethod && problem) {
    throw new AppError(422, 'CRITERIA_INVALID', problem);
  }
  // Dp0 is monitored for the pressure methods, and also plotted alongside the
  // vortex metrics when the patch pair is usable.
  const monitors = pressureMethod || (settings.vortex.enabled && problem === null);

  const files: Record<string, string> = {};
  const includes: ManagedInclude[] = [];
  if (monitors) {
    files['system/pressureLossMonitors'] = renderPressureLossMonitors(c);
    includes.push('pressureLossMonitors');
  }
  if (c.method === 'simplePDrop') {
    files['system/SimplePDropConvergence'] = renderSimplePDropConvergence(c);
    includes.push('SimplePDropConvergence');
  } else if (c.method === 'robust') {
    files['system/convergenceControl'] = renderConvergenceControl(c);
    includes.push('convergenceControl');
  }
  if (settings.vortex.enabled) {
    files['system/diveVortexMetrics'] = renderDiveVortexMetrics(settings.vortex);
    includes.push('diveVortexMetrics');
  }
  return { files, includes, residualControl: c.method === 'robust' ? 'disable' : 'restore' };
}

// ---------------------------------------------------------------------------
// controlDict managed includes
// ---------------------------------------------------------------------------

/** Find the matching closing brace of the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Locate the `functions { ... }` block: indices of its `{` and `}`. */
function findFunctionsBlock(text: string): { open: number; close: number } | null {
  const re = /^[ \t]*functions\b/m;
  const match = re.exec(text);
  if (!match) return null;
  const open = text.indexOf('{', match.index + match[0].length);
  if (open < 0) return null;
  // Only whitespace may sit between the keyword and its brace.
  if (text.slice(match.index + match[0].length, open).trim() !== '') return null;
  const close = matchBrace(text, open);
  return close < 0 ? null : { open, close };
}

const includeLineRe = (name: string) =>
  new RegExp(`^[ \\t]*#include[ \\t]+"${name}"[ \\t]*\\r?\\n?`, 'gm');

/** The managed includes present in the controlDict `functions` block, in order. */
export function readManagedIncludes(controlDict: string): ManagedInclude[] {
  const block = findFunctionsBlock(controlDict);
  if (!block) return [];
  const body = controlDict.slice(block.open, block.close);
  const found: { name: ManagedInclude; at: number }[] = [];
  for (const name of MANAGED_INCLUDES) {
    const at = body.search(new RegExp(`#include[ \\t]+"${name}"`));
    if (at >= 0) found.push({ name, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/**
 * Set the managed `#include "<name>"` lines of controlDict `functions { }` to
 * exactly `includes` (in order, first in the block). Unrelated entries are left
 * untouched; a missing `functions` block is created (before the footer) only
 * when there is something to include. Idempotent.
 */
export function setManagedIncludes(controlDict: string, includes: readonly string[]): string {
  let text = controlDict;
  for (const name of MANAGED_INCLUDES) text = text.replace(includeLineRe(name), '');

  const lines = includes.map((name) => `    #include "${name}"\n`).join('');
  const block = findFunctionsBlock(text);
  if (!block) {
    if (includes.length === 0) return controlDict === text ? controlDict : text;
    const functions = `functions\n{\n${lines}}\n`;
    const footer = text.search(/^\/\/ \*{10,}/m);
    if (footer >= 0) return `${text.slice(0, footer)}${functions}\n${text.slice(footer)}`;
    return `${text.replace(/\s*$/, '\n\n')}${functions}`;
  }
  if (includes.length === 0) return text;
  const afterBrace = block.open + 1;
  if (text[afterBrace] === '\n') {
    return `${text.slice(0, afterBrace + 1)}${lines}${text.slice(afterBrace + 1)}`;
  }
  if (text.slice(afterBrace, afterBrace + 2) === '\r\n') {
    return `${text.slice(0, afterBrace + 2)}${lines}${text.slice(afterBrace + 2)}`;
  }
  return `${text.slice(0, afterBrace)}\n${lines}${text.slice(afterBrace)}`;
}

// ---------------------------------------------------------------------------
// residualControl (robust criterion)
// ---------------------------------------------------------------------------

const MARKER_BLOCK_RE = new RegExp(
  `/\\* ${DIVE_RESIDUAL_MARKER.replace(/[()]/g, '\\$&')}\\n([\\s\\S]*?)\\n\\*/`,
);

/**
 * Comment the SIMPLE `residualControl` block out with the DIVE marker (the robust
 * criterion needs it off, else the solver stops on residuals alone). Idempotent;
 * a file without the block is returned unchanged.
 */
export function disableResidualControl(fvSolution: string): string {
  if (fvSolution.includes(DIVE_RESIDUAL_MARKER)) return fvSolution;
  const match = /^([ \t]*)residualControl\b/m.exec(fvSolution);
  if (!match) return fvSolution;
  const start = match.index + match[1].length;
  const open = fvSolution.indexOf('{', start);
  if (open < 0 || fvSolution.slice(start + 'residualControl'.length, open).trim() !== '') {
    return fvSolution;
  }
  const close = matchBrace(fvSolution, open);
  if (close < 0) return fvSolution;
  const original = fvSolution.slice(start, close + 1).replace(/\*\//g, '*\\/');
  return `${fvSolution.slice(0, start)}/* ${DIVE_RESIDUAL_MARKER}\n${original}\n*/${fvSolution.slice(close + 1)}`;
}

/** Restore a residualControl block commented out by disableResidualControl (verbatim). */
export function restoreResidualControl(fvSolution: string): string {
  const match = MARKER_BLOCK_RE.exec(fvSolution);
  if (!match) return fvSolution;
  const original = match[1].replace(/\*\\\//g, '*/');
  return `${fvSolution.slice(0, match.index)}${original}${fvSolution.slice(match.index + match[0].length)}`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// Verbatim copy of documents/Tools/ConvergenceFunctions/pressureLossMonitors (user tool).
const PRESSURE_LOSS_MONITORS_TEMPLATE = `/*---------------------------------------------------------------------------*\\
  PORTABLE PRESSURE-LOSS MONITORS  (function objects for controlDict)
  ---------------------------------------------------------------------------
  Produces \`pTotal\` [Pa] and logs the flux-weighted total-pressure drop, giving
  the postProcessing data that plotConvergence.py and SimplePDropConvergence read.

  HOW TO USE IN ANOTHER MODEL
  ---------------------------------------------------------------------------
  1. copy this file into the case \`system/\` folder.
  2. in system/controlDict, inside \`functions { ... }\`, add:  #include "pressureLossMonitors"
     (put it BEFORE any #include "convergenceControl"/"SimplePDropConvergence").
  3. EDIT the two patch names below (search \`name inlet\` / \`name outlet\`) if your
     patches are named differently. The monitor OBJECT names (inlet_p0_flux etc.)
     are what plotConvergence.py expects -- leave them as-is.

  NB static p is kinematic -> pTotal uses rhoInf so it comes out in Pa.
\\*---------------------------------------------------------------------------*/
pTotal
{
    type            pressure;
    libs            (fieldFunctionObjects);
    field           p;
    mode            total;          // p0 = rho*(p + 0.5|U|^2)
    rho             rhoInf;
    rhoInf          1000;           // water -> pTotal in Pa
    result          pTotal;
    executeControl  timeStep;   executeInterval 1;
    writeControl    writeTime;
}
inlet_p0_flux
{
    type            surfaceFieldValue;   libs (fieldFunctionObjects);
    regionType      patch;   name  inlet;                 // <-- inflow patch
    operation       weightedAverage;   weightField phi;   fields (pTotal p);
    writeFields false;   log true;
    executeControl  timeStep;   executeInterval 1;
    writeControl    timeStep;   writeInterval 1;
}
outlet_p0_flux
{
    type            surfaceFieldValue;   libs (fieldFunctionObjects);
    regionType      patch;   name  outlet;                // <-- outflow patch
    operation       weightedAverage;   weightField phi;   fields (pTotal p);
    writeFields false;   log true;
    executeControl  timeStep;   executeInterval 1;
    writeControl    timeStep;   writeInterval 1;
}
inlet_flux
{
    type            surfaceFieldValue;   libs (fieldFunctionObjects);
    regionType      patch;   name  inlet;                 // <-- inflow patch
    operation       sum;   fields (phi);   writeFields false;   log true;
    executeControl  timeStep;   executeInterval 1;
    writeControl    timeStep;   writeInterval 1;
}
outlet_flux
{
    type            surfaceFieldValue;   libs (fieldFunctionObjects);
    regionType      patch;   name  outlet;                // <-- outflow patch
    operation       sum;   fields (phi);   writeFields false;   log true;
    executeControl  timeStep;   executeInterval 1;
    writeControl    timeStep;   writeInterval 1;
}
// ************************************************************************* //
`;

// Verbatim copy of documents/Tools/ConvergenceFunctions/SimplePDropConvergence (user tool).
const SIMPLE_PDROP_CONVERGENCE_TEMPLATE = `/*---------------------------------------------------------------------------*\\
  PORTABLE SIMPLE CONVERGENCE AUTO-STOP  (coded functionObject)
  ---------------------------------------------------------------------------
  Simpler alternative to convergenceControl. Mass-flow-weighted total-pressure
  drop Dp0; converges when the current Dp0 stays within +/- devTol (relative) of
  the trailing-\`window\` mean for \`nPass\` CONSECUTIVE iterations. No slope or
  residual gate; the consecutive-pass requirement is what makes it robust
  against the single-crossing false positive.

  HOW TO USE IN ANOTHER MODEL
  ---------------------------------------------------------------------------
  1. copy this file into the case \`system/\` folder.
  2. in system/controlDict, inside \`functions { ... }\`, ensure a \`pTotal\`
     pressure FO runs BEFORE this one, then add:  #include "SimplePDropConvergence"
  3. edit the USER INPUTS block below.
  (pTotal is produced by the \`pressureLossMonitors\` include, or any \`pressure\`
   FO with \`mode total, rho rhoInf, rhoInf 1000, result pTotal\`.)
\\*---------------------------------------------------------------------------*/
SimplePDropConvergence
{
    type            coded;
    libs            ("libutilityFunctionObjects.so");
    name            SimplePDropConvergence;

    executeControl  timeStep;   executeInterval 1;

    codeInclude #{ #include "fvCFD.H" #include "PstreamReduceOps.H" #};
    codeOptions #{ -I$(LIB_SRC)/finiteVolume/lnInclude #};
    codeLibs    #{ -lfiniteVolume #};

    codeData
    #{
        List<scalar> history_;
        scalar historySum_ = 0.0;
        label  nHistory_ = 0;
        label  nextIndex_ = 0;
        label  nConsecutive_ = 0;
        bool   stopped_ = false;
    #};

    codeExecute
    #{
        // ==================== USER INPUTS ====================
        const word   inletPatch  = "inlet";    // inflow patch name
        const word   outletPatch = "outlet";   // outflow patch name
        const label  window = 100;     // trailing-mean window [iterations]
        const scalar devTol = 0.03;    // allowed relative deviation from the mean (0.03 = +/-3%)
        const label  nPass  = 100;     // consecutive iterations that must satisfy it
        // ====================================================

        if (stopped_) return true;

        const fvMesh& m = mesh();
        const volScalarField&     pTotal = m.lookupObject<volScalarField>("pTotal");
        const surfaceScalarField& phi    = m.lookupObject<surfaceScalarField>("phi");
        const label in = m.boundaryMesh().findPatchID(inletPatch);
        const label out = m.boundaryMesh().findPatchID(outletPatch);
        if (in < 0 || out < 0)
            FatalErrorInFunction << "inlet/outlet patch not found" << exit(FatalError);

        const scalar fIn  = gSum(phi.boundaryField()[in]);
        const scalar fOut = gSum(phi.boundaryField()[out]);
        if (mag(fIn) < VSMALL || mag(fOut) < VSMALL)
            FatalErrorInFunction << "near-zero flow rate" << exit(FatalError);
        const scalar dp0 =
            gSum(phi.boundaryField()[in] *pTotal.boundaryField()[in]) /fIn
          - gSum(phi.boundaryField()[out]*pTotal.boundaryField()[out])/fOut;

        // fill the initial reference window
        if (nHistory_ < window)
        {
            history_.setSize(nHistory_ + 1);
            history_[nHistory_] = dp0; historySum_ += dp0; ++nHistory_;
            Info<< "SimplePDropConvergence: filling window " << nHistory_ << "/" << window
                << ", dp0 = " << dp0 << " Pa" << nl;
            return true;
        }

        const scalar mean = historySum_/window;
        const scalar dev  = mag(dp0 - mean)/max(mag(mean), VSMALL);
        if (dev <= devTol) ++nConsecutive_; else nConsecutive_ = 0;

        Info<< "SimplePDropConvergence: dp0 = " << dp0 << " Pa, mean = " << mean
            << " Pa, dev = " << 100.0*dev << " %, consecutive = "
            << nConsecutive_ << "/" << nPass << nl;

        // advance the circular trailing window
        historySum_ += dp0 - history_[nextIndex_];
        history_[nextIndex_] = dp0; nextIndex_ = (nextIndex_ + 1) % window;

        if (nConsecutive_ >= nPass)
        {
            Info<< nl << "SimplePDropConvergence: CONVERGED. Writing and stopping." << nl;
            const_cast<Time&>(m.time()).writeAndEnd();
            stopped_ = true;
        }
        return true;
    #};
}
// ************************************************************************* //
`;

// Verbatim copy of documents/Tools/ConvergenceFunctions/convergenceControl (user tool).
const CONVERGENCE_CONTROL_TEMPLATE = `/*---------------------------------------------------------------------------*\\
  PORTABLE ROBUST CONVERGENCE AUTO-STOP  (coded functionObject)
  ---------------------------------------------------------------------------
  Stops a steady (simpleFoam) run when the total-pressure drop Dp0 across the
  domain has genuinely settled. For K consecutive checks (one every W iters),
  ALL three must hold:
     1  mean stationarity : |mean(last W) - mean(prev W)|       <= tolMean [Pa]
     2  no trend (slope)  : |leastSquaresSlope(last W)| * (W-1) <= tolMean [Pa]
     3  residuals         : max initial residual (all eqns) in window <= resTol
  (1)+(2) are immune to the oscillation-crossing / ramp false positives of the
  built-in \`average\` runTimeControl; (3) is the residual gate. AND of all three.

  HOW TO USE IN ANOTHER MODEL
  ---------------------------------------------------------------------------
  1. copy this file into the case \`system/\` folder.
  2. in system/controlDict, inside \`functions { ... }\`, add:  #include "convergenceControl"
  3. in system/fvSolution, DELETE the \`residualControl\` block from SIMPLE
     (otherwise the solver stops on residuals alone, bypassing this FO).
  4. edit the USER INPUTS block below (patch names + tolerances).
  Nothing else. It compiles itself on the first time step (~1-2 min).
\\*---------------------------------------------------------------------------*/
convergenceControl
{
    type            coded;
    libs            (utilityFunctionObjects);
    name            convergenceControl;

    executeControl  timeStep;   executeInterval 1;
    writeControl    timeStep;   writeInterval   1;

    codeOptions #{ -I$(LIB_SRC)/finiteVolume/lnInclude #};
    codeLibs    #{ -lfiniteVolume #};
    codeInclude
    #{
        #include "volFields.H"
        #include "surfaceFields.H"
        #include "solutionControl.H"
    #};

    codeData
    #{
        DynamicList<scalar> hist_;   // Dp0 history [Pa], one per iteration
        scalar resWinMax_ = 0;       // worst initial residual in current window
        label  passCount_ = 0;       // consecutive passing checks so far
        label  nextCheck_ = 0;       // iteration count of the next check
    #};

    codeExecute
    #{
        // ==================== USER INPUTS ====================
        const word   inletPatch  = "inlet";    // inflow patch name
        const word   outletPatch = "outlet";   // outflow patch name
        const label  W       = 100;     // averaging / check window [iterations]
        const scalar tolMean = 50.0;    // [Pa] gate for criteria 1 (mean drift) & 2 (slope)
        const label  K       = 2;       // number of consecutive passing checks required
        const scalar resTol  = 1e-3;    // max initial residual (all eqns) allowed in the window
                                        //   NB set ABOVE the residual floor of your case, else it
                                        //   never passes and the run rides to endTime.
        // ====================================================

        const fvMesh& m = mesh();
        if (nextCheck_ == 0) nextCheck_ = 2*W;

        // (A) flux-weighted total-pressure drop Dp0 [Pa] (p0 = p + 0.5|U|^2, *1000 kin->Pa)
        const volScalarField&     p   = m.lookupObject<volScalarField>("p");
        const volVectorField&     U   = m.lookupObject<volVectorField>("U");
        const surfaceScalarField& phi = m.lookupObject<surfaceScalarField>("phi");
        const label inID  = m.boundaryMesh().findPatchID(inletPatch);
        const label outID = m.boundaryMesh().findPatchID(outletPatch);
        if (inID < 0 || outID < 0)
            FatalErrorInFunction << "inlet/outlet patch not found" << exit(FatalError);
        auto p0flux = [&](const label id) -> scalar
        {
            const scalarField& pp   = p.boundaryField()[id];
            const vectorField& Up   = U.boundaryField()[id];
            const scalarField& phip = phi.boundaryField()[id];
            scalar num = 0, den = 0;
            forAll(pp, i) { num += phip[i]*(pp[i] + 0.5*magSqr(Up[i])); den += phip[i]; }
            reduce(num, sumOp<scalar>()); reduce(den, sumOp<scalar>());
            return (mag(den) > VSMALL ? num/den : 0.0)*1000.0;
        };
        hist_.append(p0flux(inID) - p0flux(outID));

        // (B) worst initial residual seen within this window
        const dictionary& sdict = m.data().solverPerformanceDict();
        scalar resNow = 0;
        for (const entry& e : sdict) resNow = max(resNow, solutionControl::maxResidual(m, e).first());
        resWinMax_ = max(resWinMax_, resNow);

        // (C) evaluate every W iterations
        if (hist_.size() >= nextCheck_)
        {
            const label n = hist_.size();
            scalar mLast = 0, mPrev = 0;
            for (label i = n - W;   i < n;     ++i) mLast += hist_[i];
            for (label i = n - 2*W; i < n - W; ++i) mPrev += hist_[i];
            mLast /= W;  mPrev /= W;

            const scalar xbar = 0.5*(W - 1);
            scalar sxy = 0, sxx = 0;
            for (label i = 0; i < W; ++i)
            { const scalar dx = scalar(i) - xbar; sxy += dx*(hist_[n-W+i] - mLast); sxx += dx*dx; }
            const scalar slope = (sxx > 0 ? sxy/sxx : 0.0);

            const scalar drift = mag(mLast - mPrev);
            const scalar trend = mag(slope)*(W - 1);
            const bool c1 = (drift <= tolMean), c2 = (trend <= tolMean), c3 = (resWinMax_ <= resTol);
            if (c1 && c2 && c3) ++passCount_; else passCount_ = 0;

            Info<< "convergenceControl @ " << m.time().timeName()
                << ":  drift=" << drift << " Pa  trend=" << trend << " Pa  maxRes=" << resWinMax_
                << "  [mean:" << (c1?"y":"n") << " slope:" << (c2?"y":"n") << " res:" << (c3?"y":"n")
                << "]  pass " << passCount_ << "/" << K << endl;

            resWinMax_ = 0;  nextCheck_ += W;
            if (passCount_ >= K)
            {
                Info<< "convergenceControl: CONVERGED (Dp0 stationary + residuals) @ iteration "
                    << m.time().timeName() << endl;
                const_cast<Time&>(m.time()).writeAndEnd();
            }
        }
    #};
}
// ************************************************************************* //
`;

// DIVE vortex metrics (the __NAME__ placeholders are filled by renderDiveVortexMetrics).
const DIVE_VORTEX_METRICS_TEMPLATE = `/*---------------------------------------------------------------------------*\\
  DIVE VORTEX METRICS  (coded functionObject)
  ---------------------------------------------------------------------------
  Written by DIVE from the project's Solver tab settings: edits here are
  overwritten at the next save or run start.

  One pass of the user's VorticityFunction tools (postVorticity.sh and the
  Q-core RMS vorticity method), with v2406-safe API only (the v2606 zone shortcut is
  not used):
     Q             = 0.5*(|skew(grad U)|^2 - |symm(grad U)|^2)     [1/s2]
     omega         = curl(U)                                        [1/s]
     y             = wall distance (wallDist, meshWave)             [m]
     qVolume       = sum V  over Q > qThreshold                     [m3]
     maskedQVolume = sum V  over Q > qThreshold and y > wallDistance [m3]
     core          = cells with Q >= qCrit and V > vMin
     omegaRms      = sqrt( sum |omega|^2 V / sum V ) over the core   [1/s]
  Runs every \`executeInterval\` iterations and at write times (where it also
  writes Q, vorticity, wallDistance and Qfiltered when writeFields is on).
  Log line:  diveVortexMetrics: time=.. qVolume=.. maskedQVolume=.. omegaRms=..
             coreVolume=.. coreCells=..
  Rows also go to postProcessing/diveVortexMetrics/<startTime>/vortexMetrics.dat
  It compiles itself on the first time step (~1-2 min).
\\*---------------------------------------------------------------------------*/
diveVortexMetrics
{
    type            coded;
    libs            (utilityFunctionObjects);
    name            diveVortexMetrics;

    executeControl  timeStep;   executeInterval __INTERVAL__;
    writeControl    writeTime;

    codeOptions #{ -I$(LIB_SRC)/finiteVolume/lnInclude -I$(LIB_SRC)/meshTools/lnInclude #};
    codeLibs    #{ -lfiniteVolume -lmeshTools #};
    codeInclude
    #{
        #include "volFields.H"
        #include "fvcGrad.H"
        #include "fvcCurl.H"
        #include "wallDist.H"
        #include "OFstream.H"
        #include "OSspecific.H"
    #};

    codeData
    #{
        autoPtr<OFstream> datFile_;

        void diveEvaluate(const bool atWriteTime)
        {
            // ==================== USER INPUTS ====================
            const word   velocityField = "__VELOCITY__";   // U (absolute) or Urel (relative), same for Q and omega
            const scalar qThreshold    = __Q_THRESHOLD__;   // [1/s2] Q threshold of the vortex volume
            const scalar wallDistance  = __WALL_DISTANCE__;   // [m] near-wall mask of the masked volume
            const scalar qCrit         = __Q_CRIT__;   // [1/s2] Q threshold of the RMS core
            const scalar vMin          = __V_MIN__;   // [m3] core cells need V > vMin (0 = no filter)
            const bool   writeFields   = __WRITE_FIELDS__;   // write Q, vorticity, wallDistance, Qfiltered
            // ====================================================

            const fvMesh& m = mesh();
            const Time& runTime = m.time();
            const volVectorField& U = m.lookupObject<volVectorField>(velocityField);

            const volTensorField gradU(fvc::grad(U));
            volScalarField Q
            (
                IOobject("Q", runTime.timeName(), m, IOobject::NO_READ, IOobject::NO_WRITE, false),
                0.5*(magSqr(skew(gradU)) - magSqr(symm(gradU)))
            );
            volVectorField vorticity
            (
                IOobject("vorticity", runTime.timeName(), m, IOobject::NO_READ, IOobject::NO_WRITE, false),
                fvc::curl(U)
            );
            const volScalarField& y = wallDist::New(m).y();
            const scalarField& V = m.V();

            const scalarField& Qi = Q.primitiveField();
            const scalarField& yi = y.primitiveField();
            const vectorField& wi = vorticity.primitiveField();

            scalar qVolume = 0, maskedQVolume = 0, coreVolume = 0, omegaSqrVolume = 0;
            label coreCells = 0;
            forAll(Qi, i)
            {
                if (Qi[i] > qThreshold)
                {
                    qVolume += V[i];
                    if (yi[i] > wallDistance) maskedQVolume += V[i];
                }
                if (Qi[i] >= qCrit && V[i] > vMin)
                {
                    coreVolume += V[i];
                    omegaSqrVolume += magSqr(wi[i])*V[i];
                    ++coreCells;
                }
            }
            reduce(qVolume, sumOp<scalar>());
            reduce(maskedQVolume, sumOp<scalar>());
            reduce(coreVolume, sumOp<scalar>());
            reduce(omegaSqrVolume, sumOp<scalar>());
            reduce(coreCells, sumOp<label>());
            const scalar omegaRms =
                (coreVolume > VSMALL ? Foam::sqrt(omegaSqrVolume/coreVolume) : 0.0);

            Info<< "diveVortexMetrics: time=" << runTime.timeName()
                << " qVolume=" << qVolume << " maskedQVolume=" << maskedQVolume
                << " omegaRms=" << omegaRms << " coreVolume=" << coreVolume
                << " coreCells=" << coreCells << endl;

            if (Pstream::master())
            {
                if (!datFile_)
                {
                    const fileName dir =
                        runTime.globalPath()/"postProcessing"/"diveVortexMetrics"
                       /runTime.timeName(runTime.startTime().value());
                    mkDir(dir);
                    datFile_.reset
                    (
                        new OFstream
                        (
                            dir/(functionObject::postProcess
                              ? "vortexMetrics_postProcess.dat" : "vortexMetrics.dat")
                        )
                    );
                    datFile_()
                        << "# time qVolume maskedQVolume omegaRms coreVolume coreCells" << endl;
                }
                datFile_()
                    << runTime.timeName() << ' ' << qVolume << ' ' << maskedQVolume << ' '
                    << omegaRms << ' ' << coreVolume << ' ' << coreCells << endl;
            }

            if (atWriteTime && writeFields)
            {
                volScalarField wallDistanceField
                (
                    IOobject("wallDistance", runTime.timeName(), m, IOobject::NO_READ, IOobject::NO_WRITE, false),
                    y
                );
                volScalarField Qfiltered
                (
                    IOobject("Qfiltered", runTime.timeName(), m, IOobject::NO_READ, IOobject::NO_WRITE, false),
                    Q
                );
                scalarField& Qf = Qfiltered.primitiveFieldRef();
                forAll(Qf, i)
                {
                    if (!(yi[i] > wallDistance)) Qf[i] = 0;
                }
                Q.write();
                vorticity.write();
                wallDistanceField.write();
                Qfiltered.write();
            }
        }
    #};

    codeExecute
    #{
        diveEvaluate(false);
    #};

    codeWrite
    #{
        diveEvaluate(true);
    #};
}
// ************************************************************************* //
`;
