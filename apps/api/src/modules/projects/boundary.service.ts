// "Boundary conditions" overlay: apply a component BC preset to a project case.
//
// The user picks what the imported mesh IS (Turbine / Pipe / DraftTube / Chamber)
// and how the flow is driven, then assigns the inlet / outlet / wall patches. We
// rewrite those patches' boundaryField entries across every 0/ field with the
// physically correct recipe (openfoamCase.componentInletBc / componentOutletBc /
// fieldBcBody), straight from the DIVE turbine templates. The case is scaffolded
// first so the 0/ fields exist, and backed up so the change is reversible. A draft
// tube maps its inlet velocity profile from an uploaded CSV into boundaryData.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GRAVITY,
  OBJECT_TYPE_MODES,
  isConfigurableSolver,
  type AppliedRotor,
  type ApplyBoundaryConditionsRequest,
  type ApplyBoundaryConditionsResult,
  type ImportStep,
  type SolverId,
} from '@dive/shared';
import { AppError } from '../../lib/AppError';
import { convertCsvToBoundaryData } from '../../lib/boundaryData';
import {
  BOUNDARY_FILE,
  componentInletBc,
  componentOutletBc,
  fieldBcBody,
  parseApplication,
  parseBoundaryPatches,
  parseTurbulenceModel,
  renderDynamicMeshDict,
  renderMrfProperties,
  setBoundaryPatchType,
  setFieldPatchBc,
} from '../../lib/openfoamCase';
import {
  caseDirAbsolute,
  listCaseTree,
  readCaseFile,
  writeCaseFile,
} from '../../lib/caseStorage';
import { ensureOriginalBackup } from '../../lib/meshBackupStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import { scaffoldSolver } from './files.service';

/** Skip pathologically large files when scanning the 0/ fields (mirrors mesh.service). */
const FIELD_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** The case's turbulence model (constant/turbulenceProperties), or the k-omega default. */
async function caseTurbulenceModel(projectId: string): Promise<string> {
  const turb = await readCaseFile(projectId, 'constant/turbulenceProperties');
  const parsed = turb ? parseTurbulenceModel(turb.toString('utf8')) : null;
  return parsed ?? 'kOmegaSST';
}

/** The case's configured solver if it is a guided one, else the simpleFoam default
 * (so scaffolding an already-configured case never downgrades its solver). */
async function caseSolver(projectId: string): Promise<SolverId> {
  const controlDict = await readCaseFile(projectId, 'system/controlDict');
  const application = controlDict ? parseApplication(controlDict.toString('utf8')) : null;
  return application && isConfigurableSolver(application) ? application : 'simpleFoam';
}

/**
 * Apply a component BC preset. Validates the plan against the real mesh patches,
 * scaffolds the 0/ fields if missing, backs up the original case, then writes the
 * inlet / outlet / wall BCs into every field. For a draft tube (csvProfile), the
 * uploaded CSV is converted to boundaryData first (so we know which turbulence
 * fields it carries).
 *
 * @throws 404 NOT_FOUND if the project is not visible.
 * @throws 409 NO_MESH if the project has no constant/polyMesh.
 * @throws 422 INVALID_BC_PLAN for an unknown patch / bad mode / missing value.
 * @throws 422 BC_CSV_REQUIRED for a draft tube with no CSV.
 */
export async function applyBoundaryConditions(
  viewer: Viewer,
  projectId: string,
  request: ApplyBoundaryConditionsRequest,
  csv?: Buffer,
): Promise<ApplyBoundaryConditionsResult> {
  await assertProjectVisible(viewer, projectId);

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  if (!boundary) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  const boundaryText = boundary.toString('utf8');
  const patchNames = parseBoundaryPatches(boundaryText);

  // Validate the plan against the mesh before touching disk.
  for (const name of [request.inlet, request.outlet, ...request.walls]) {
    if (!patchNames.includes(name)) {
      throw new AppError(422, 'INVALID_BC_PLAN', `Patch "${name}" was not found in the mesh.`);
    }
  }
  if (request.inlet === request.outlet) {
    throw new AppError(422, 'INVALID_BC_PLAN', 'The inlet and outlet must be different patches.');
  }
  if (!OBJECT_TYPE_MODES[request.objectType].includes(request.mode)) {
    throw new AppError(
      422,
      'INVALID_BC_PLAN',
      `Mode "${request.mode}" is not available for a ${request.objectType}.`,
    );
  }
  if (request.mode === 'pressure' && request.values.head === undefined) {
    throw new AppError(422, 'INVALID_BC_PLAN', 'A net head is required for a pressure-driven inlet.');
  }
  if (request.mode === 'flowRate' && request.values.flowRate === undefined) {
    throw new AppError(422, 'INVALID_BC_PLAN', 'A flow rate is required for a flow-rate-driven inlet.');
  }
  if (request.mode === 'csvProfile' && !csv) {
    throw new AppError(422, 'BC_CSV_REQUIRED', 'A CSV runner-exit profile is required for a draft tube.');
  }

  const notes: string[] = [];

  // Back up the ORIGINAL case (once) before any write, so the apply is reversible.
  await ensureOriginalBackup(projectId);

  // Ensure the 0/ fields exist for the case's solver + model (non-overwriting): a
  // freshly imported case has only polyMesh. We then overwrite inlet/outlet/walls.
  await scaffoldSolver(viewer, projectId, await caseSolver(projectId));
  const model = await caseTurbulenceModel(projectId);

  // Draft tube: map the CSV profile into boundaryData BEFORE writing the fields,
  // so we know which turbulence fields the profile carries (mapped vs fallback).
  let csvSteps: ImportStep[] | undefined;
  let csvFields: string[] = [];
  if (request.mode === 'csvProfile' && csv) {
    const caseDir = caseDirAbsolute(projectId);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dive-bc-'));
    try {
      const csvAbs = path.join(tmpDir, 'profile.csv');
      await fs.writeFile(csvAbs, csv);
      const conv = await convertCsvToBoundaryData(caseDir, csvAbs, request.inlet);
      csvSteps = conv.steps;
      csvFields = conv.mappedFields;
      const converted = conv.steps.every((step) => step.status === 'success');
      if (!converted) {
        notes.push(
          'The CSV to boundaryData conversion did not complete; the inlet velocity profile will be missing until the toolchain runs on the deploy host.',
        );
      } else {
        const missing = ['k', 'omega'].filter((field) => !csvFields.includes(field));
        if (missing.length > 0) {
          notes.push(
            `The CSV had no ${missing.join(' / ')} column, so the inlet ${missing.join(' / ')} uses the turbulence-intensity fallback.`,
          );
        }
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // Walls: set the geometric type to `wall` in the boundary file so the wall
  // functions are physically correct (nut/k/omega wall functions expect a wall).
  let newBoundary = boundaryText;
  for (const wall of request.walls) {
    newBoundary = setBoundaryPatchType(newBoundary, wall, 'wall');
  }
  if (newBoundary !== boundaryText) {
    await writeCaseFile(projectId, BOUNDARY_FILE, newBoundary);
  }

  const inletOpts = {
    objectType: request.objectType,
    mode: request.mode,
    values: request.values,
    model,
    csvFields,
  };
  const outletOpts = { objectType: request.objectType, mode: request.mode, model };

  // Rewrite the inlet / outlet / wall entries in every 0/ field.
  const fields: string[] = [];
  const entries = await listCaseTree(projectId);
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (entry.path.startsWith('constant/polyMesh/')) continue;
    if (entry.size > FIELD_SCAN_MAX_BYTES) continue;
    const buffer = await readCaseFile(projectId, entry.path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    if (!text.includes('boundaryField')) continue;
    const fieldName = entry.path.split('/').pop() ?? entry.path;

    let updated = setFieldPatchBc(text, request.inlet, componentInletBc(fieldName, inletOpts));
    updated = setFieldPatchBc(updated, request.outlet, componentOutletBc(fieldName, outletOpts));
    for (const wall of request.walls) {
      updated = setFieldPatchBc(updated, wall, fieldBcBody(fieldName, 'wall', model));
    }
    if (updated !== text) {
      await writeCaseFile(projectId, entry.path, updated);
      fields.push(entry.path);
    }
  }

  // Turbine rotor: write the MRF (Frozen Rotor) or dynamic-mesh (Moving Rotor)
  // dictionary in addition to the 0/ fields. Only for a turbine — the other
  // component types have no rotating region.
  let appliedRotor: AppliedRotor | undefined;
  if (request.objectType === 'turbine' && request.rotor) {
    const rotor = request.rotor;
    for (const patch of rotor.nonRotatingPatches ?? []) {
      if (!patchNames.includes(patch)) {
        throw new AppError(
          422,
          'INVALID_BC_PLAN',
          `Non-rotating patch "${patch}" was not found in the mesh.`,
        );
      }
    }
    // The rotor needs a cell zone; we cannot create one, only warn if the mesh
    // has none defined yet (it must be made with topoSet before the run).
    const cellZones = await readCaseFile(projectId, 'constant/polyMesh/cellZones');
    if (!cellZones) {
      notes.push(
        `The mesh has no cellZones, so the rotor zone "${rotor.cellZone}" must be created (e.g. with topoSet) before the run.`,
      );
    }
    if (rotor.mode === 'frozenRotor') {
      await writeCaseFile(
        projectId,
        'constant/MRFProperties',
        renderMrfProperties({
          cellZone: rotor.cellZone,
          origin: rotor.origin,
          axis: rotor.axis,
          omega: rotor.omega,
          nonRotatingPatches: rotor.nonRotatingPatches,
        }),
      );
      appliedRotor = {
        mode: rotor.mode,
        cellZone: rotor.cellZone,
        omega: rotor.omega,
        file: 'constant/MRFProperties',
      };
    } else {
      await writeCaseFile(
        projectId,
        'constant/dynamicMeshDict',
        renderDynamicMeshDict({
          cellZone: rotor.cellZone,
          origin: rotor.origin,
          axis: rotor.axis,
          omega: rotor.omega,
        }),
      );
      appliedRotor = {
        mode: rotor.mode,
        cellZone: rotor.cellZone,
        omega: rotor.omega,
        file: 'constant/dynamicMeshDict',
      };
      notes.push(
        'Moving Rotor wrote constant/dynamicMeshDict, but it needs a transient solver: set the solver to pimpleFoam in the Solver tab and make the rotor interface a cyclicAMI couple, otherwise the run will not rotate.',
      );
    }
  }

  const p0 =
    request.mode === 'pressure' && request.values.head !== undefined
      ? Number((GRAVITY * request.values.head).toFixed(6))
      : undefined;

  return {
    success: true,
    applied: {
      objectType: request.objectType,
      mode: request.mode,
      inlet: request.inlet,
      outlet: request.outlet,
      walls: request.walls,
      fields,
      ...(p0 !== undefined ? { p0 } : {}),
      ...(appliedRotor ? { rotor: appliedRotor } : {}),
    },
    csvSteps,
    notes,
  };
}
