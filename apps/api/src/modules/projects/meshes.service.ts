// Multi-mesh import & merge (Assembly v2): business logic.
//
// A project holds a reusable LIBRARY of imported polyMesh sources (stored apart
// from the case under meshes/, see meshStorage). The "merge" pipeline combines a
// chosen, ordered subset of them into the project's single constant/polyMesh —
// the artifact every other feature (Visualize, Solver, Export) already consumes
// — by:
//
//   1. prepare:     stage each source as a minimal case in a work dir and prefix
//                   its patches (m1_, m2_, …) so mergeMeshes never fuses two
//                   distinct same-named patches (e.g. each part's own "walls").
//                   When order[0] is the MERGE_BASE_CASE sentinel the master is
//                   staged from the project's OWN case mesh, UNPREFIXED (its
//                   inlet/outlet/interface names are preserved as the base).
//   2. mergeMeshes: combine every additional source into the master mesh.
//   3. per interface, branch on coupling:
//        nonConformalCyclic: createNonConformalCouples couples a touching patch
//                   pair, KEEPING both parts' cells + patches (v12-native, the
//                   Assembly v2 default — flow interpolates, no node coincidence).
//        stitch:    conformally FUSE the pair into an internal interface (legacy).
//   4. cleanup:     drop the zero-face patches stitchMesh leaves behind — SKIPPED
//                   when any non-conformal couple exists (its constraint patches
//                   must be kept).
//   5. checkMesh:   validate the combined mesh.
//   6. promote:     replace the case's constant/polyMesh with the combined mesh
//                   and re-align the 0/ boundary fields (mode 'merge' for a case
//                   base — preserve its physics; 'rebuild' for a library base).
//
// This mirrors the CGNS conversion pipeline (conversion.service): the OpenFOAM
// binaries are configurable (config/env) and every tool failure — including a
// missing binary on a Windows dev box — is captured as a structured step result
// rather than thrown, and the command runner is injectable for tests. Validation
// errors (empty/invalid plan, unknown patch) DO throw. The original case is
// backed up before the destructive promote, and the case is only touched once
// the whole pipeline has succeeded (it runs in a transient .work/ dir first).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  MergePlan,
  MergeResult,
  MergeStep,
  MergeStepKind,
  MeshImportConversion,
  MeshInterface,
  MeshManifest,
  MeshPatch,
  MeshSource,
  PartTransform,
} from '@dive/shared';
import { MERGE_BASE_CASE } from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import { isIdentityTransform, transformMeshPoints } from '../../lib/meshTransform';
import {
  meshSourceVizDir,
  meshSourceVizIsStale,
  meshSourceVizPaths,
  readMeshSourceVizEdges,
  readMeshSourceVizGlb,
  readMeshSourceVizManifest,
} from '../../lib/meshSourceVizStorage';
import {
  BOUNDARY_FILE,
  collapseBoundaryToSinglePatch,
  isValidPatchName,
  parseBoundaryPatchDetails,
  removeEmptyBoundaryPatches,
  renameBoundaryPatch,
  renderBaseFile,
  type BaseFilePath,
  type BoundaryPatchDetail,
} from '../../lib/openfoamCase';
import {
  caseDirAbsolute,
  caseFileExists,
  caseIsEmpty,
  listCaseTree,
  readCaseFile,
  type CaseEntry,
} from '../../lib/caseStorage';
import { ensureOriginalBackup } from '../../lib/meshBackupStorage';
import { convertMeshFileToCase, meshFileFormat } from '../../lib/meshImport';
import {
  deleteMeshSource,
  importMeshArchive,
  importMeshFolder,
  listMeshSources,
  meshDirAbsolute,
  meshPolyMeshDir,
  meshSourceExists,
  meshSrcDir,
  readMeshBoundary,
  readMeshMeta,
  readMergePlan,
  resetMeshWork,
  uniqueMeshId,
  writeMergePlan,
  writeMeshMeta,
  type MeshMeta,
} from '../../lib/meshStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import { syncBoundaryFields } from './files.service';

/** Outcome of a merge run on the wire: the report plus the refreshed case tree. */
export interface MergeRunResult extends MergeResult {
  /** Refreshed case tree after a successful promote (unchanged on failure). */
  entries: CaseEntry[];
}

/** One way to import a mesh source: a polyMesh folder, a .zip, or a mesh FILE. */
export interface MeshImportPayload {
  /** Display name (folder name / zip name / file name). */
  name: string;
  /** A .zip archive of a polyMesh. */
  archive?: Buffer;
  /** A polyMesh folder (each file carrying its relative path). */
  files?: Array<{ relativePath: string; data: Buffer }>;
  /** A single .cgns / .msh file to convert into a polyMesh. */
  meshFile?: { name: string; data: Buffer };
}

/**
 * Outcome of a library import: the new source (when built), the refreshed list,
 * and the conversion report when the upload was a mesh FILE (.cgns / .msh).
 */
export interface ImportMeshOutcome {
  mesh?: MeshSource;
  meshes: MeshSource[];
  conversion?: MeshImportConversion;
}

/** Keep captured output bounded on the wire while preserving the useful tail. */
const OUTPUT_TAIL_CHARS = 20000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

// --------------------------------------------------------------------------
// Library: list / import / delete / inspect patches.
// --------------------------------------------------------------------------

/** Map a stored mesh source + its parsed boundary patches to the public shape. */
async function toMeshSource(projectId: string, meta: MeshMeta): Promise<MeshSource> {
  const boundary = await readMeshBoundary(projectId, meta.id);
  const patches: MeshPatch[] = boundary
    ? parseBoundaryPatchDetails(boundary.toString('utf8'))
    : [];
  return { id: meta.id, name: meta.name, patches, createdAt: meta.createdAt };
}

/** List a project's mesh sources (with their boundary patches), no access check. */
async function publicMeshes(projectId: string): Promise<MeshSource[]> {
  const metas = await listMeshSources(projectId);
  return Promise.all(metas.map((meta) => toMeshSource(projectId, meta)));
}

/** List a project's imported mesh sources. */
export async function listMeshes(viewer: Viewer, projectId: string): Promise<MeshSource[]> {
  await assertProjectVisible(viewer, projectId);
  return publicMeshes(projectId);
}

/** The boundary patches of a single mesh source (drives the stitch-pair picker). */
export async function getMeshPatches(
  viewer: Viewer,
  projectId: string,
  meshId: string,
): Promise<MeshPatch[]> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }
  const boundary = await readMeshBoundary(projectId, meshId);
  return boundary ? parseBoundaryPatchDetails(boundary.toString('utf8')) : [];
}

/** Outcome of re-patching a library mesh: the autoPatch run + the refreshed source. */
export interface MeshSourceAutoPatchOutcome {
  result: {
    success: boolean;
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  };
  mesh?: MeshSource;
  meshes: MeshSource[];
}

/**
 * Split a library mesh's boundary into patches by feature angle (OpenFOAM
 * `autoPatch`), so a single-patch import (e.g. a .cgns that arrived as one
 * `defaultFaces`) gets distinct, stitchable patches. autoPatch needs a minimal
 * system/, written for the run and removed after; the boundary is collapsed to
 * one patch first so each run numbers from auto0, and restored on failure. Never
 * throws on a tool failure — returns `result.success: false` plus the logs.
 *
 * @throws 404 NOT_FOUND (project not visible or mesh absent).
 */
export async function autoPatchMeshSource(
  viewer: Viewer,
  projectId: string,
  meshId: string,
  featureAngle: number,
): Promise<MeshSourceAutoPatchOutcome> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }
  const meshDir = meshDirAbsolute(projectId, meshId);
  const boundaryAbs = path.join(meshPolyMeshDir(projectId, meshId), 'boundary');

  // autoPatch reads system/controlDict; library sources have none, so write the
  // minimal trio just for the run and drop it after (staging never copies it).
  const systemFiles: BaseFilePath[] = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'];
  for (const file of systemFiles) {
    const abs = path.join(meshDir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, renderBaseFile(file, []), 'utf8');
  }

  // Re-patch from a clean slate: collapse to one patch so each run numbers from
  // auto0 (autoPatch otherwise keeps existing patches and appends autoN). Keep the
  // pre-collapse boundary to restore it if the tool fails.
  const preCollapse = await fs.readFile(boundaryAbs, 'utf8');
  await fs.writeFile(boundaryAbs, collapseBoundaryToSinglePatch(preCollapse), 'utf8');

  const plan = planOpenfoamCommand(
    env.AUTO_PATCH_BIN,
    [String(featureAngle), '-overwrite', '-case', meshDir],
    meshDir,
  );
  const cmd = await runCommand({ ...plan, timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS });

  if (!commandFailed(cmd)) {
    // Drop the empty patches autoPatch leaves behind (the collapsed one it split).
    const after = await fs.readFile(boundaryAbs, 'utf8');
    const cleaned = removeEmptyBoundaryPatches(after);
    if (cleaned !== after) await fs.writeFile(boundaryAbs, cleaned, 'utf8');
  } else {
    await fs.writeFile(boundaryAbs, preCollapse, 'utf8'); // failed: restore as-was
  }
  await fs.rm(path.join(meshDir, 'system'), { recursive: true, force: true }).catch(() => undefined);

  const extra = cmd.spawnError
    ? `\n[runner] ${cmd.spawnError}`
    : cmd.timedOut
      ? '\n[runner] command timed out'
      : '';
  const result = {
    success: !commandFailed(cmd),
    command: plan.display,
    exitCode: cmd.exitCode,
    stdout: tail(cmd.stdout),
    stderr: tail(cmd.stderr + extra),
    durationMs: cmd.durationMs,
  };

  const meta = await readMeshMeta(projectId, meshId);
  const mesh = result.success && meta ? await toMeshSource(projectId, meta) : undefined;
  return { result, mesh, meshes: await publicMeshes(projectId) };
}

/**
 * Rename a patch of a library mesh (its boundary file is the only source of patch
 * names; a library source carries no 0/ fields to propagate to). Lets the user
 * give the auto-split patches meaningful names (inlet / outlet / interface) to
 * stitch on. Returns the refreshed source + list.
 *
 * @throws 404 NOT_FOUND, 409 NO_MESH / PATCH_EXISTS, 422 VALIDATION_ERROR.
 */
export async function renameMeshSourcePatch(
  viewer: Viewer,
  projectId: string,
  meshId: string,
  from: string,
  to: string,
): Promise<{ mesh: MeshSource; meshes: MeshSource[] }> {
  await assertProjectVisible(viewer, projectId);
  if (!isValidPatchName(to)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'A patch name must be a single word (letters, digits, underscore).');
  }
  const meta = await readMeshMeta(projectId, meshId);
  if (!meta) throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  const boundary = await readMeshBoundary(projectId, meshId);
  if (!boundary) throw new AppError(409, 'NO_MESH', 'This mesh has no polyMesh boundary.');
  const content = boundary.toString('utf8');
  const names = parseBoundaryPatchDetails(content).map((patch) => patch.name);
  if (!names.includes(from)) {
    throw new AppError(404, 'NOT_FOUND', `Patch "${from}" was not found in this mesh.`);
  }
  if (from !== to) {
    if (names.includes(to)) {
      throw new AppError(409, 'PATCH_EXISTS', `A patch named "${to}" already exists.`);
    }
    const boundaryAbs = path.join(meshPolyMeshDir(projectId, meshId), 'boundary');
    await fs.writeFile(boundaryAbs, renameBoundaryPatch(content, from, to), 'utf8');
  }
  const [mesh, meshes] = await Promise.all([toMeshSource(projectId, meta), publicMeshes(projectId)]);
  return { mesh, meshes };
}

/**
 * Import a polyMesh folder or .zip into the project's mesh library. The upload
 * must contain a polyMesh (a boundary file); otherwise the partial source is
 * discarded and a 400 is thrown.
 */
export async function importMesh(
  viewer: Viewer,
  projectId: string,
  payload: MeshImportPayload,
): Promise<ImportMeshOutcome> {
  await assertProjectVisible(viewer, projectId);

  // A .cgns / .msh file is converted into a polyMesh source (own report path).
  if (payload.meshFile) {
    return importMeshFromFile(projectId, payload.meshFile, payload.name);
  }

  let meta: MeshMeta;
  if (payload.archive) {
    meta = await importMeshArchive(projectId, payload.name, payload.archive);
  } else if (payload.files && payload.files.length > 0) {
    meta = await importMeshFolder(
      projectId,
      payload.name,
      payload.files.map((f) => ({ rawPath: f.relativePath, data: f.data })),
    );
  } else {
    throw new AppError(400, 'NO_FILES_UPLOADED', 'No files were uploaded');
  }

  // A valid polyMesh has a boundary file; reject anything else (and clean up).
  if (!(await readMeshBoundary(projectId, meta.id))) {
    await deleteMeshSource(projectId, meta.id);
    throw new AppError(
      400,
      'NO_MESH',
      'The upload does not contain a polyMesh (no constant/polyMesh/boundary file).',
    );
  }

  const [mesh, meshes] = await Promise.all([toMeshSource(projectId, meta), publicMeshes(projectId)]);
  return { mesh, meshes };
}

/**
 * Import a .cgns / .msh file as a library source named `name` (its slug becomes
 * the source id/directory): stage the file, convert it into the source's
 * constant/polyMesh, and keep the source only if the mesh was built. Returns the
 * conversion report either way (success === false on a tool failure, with the
 * source discarded), so the UI can show the logs.
 */
async function importMeshFromFile(
  projectId: string,
  file: { name: string; data: Buffer },
  name: string,
): Promise<ImportMeshOutcome> {
  const format = meshFileFormat(file.name);
  if (!format) {
    throw new AppError(
      400,
      'NO_MESH',
      'Unsupported mesh file. Import a .cgns or .msh (or a polyMesh folder / .zip).',
    );
  }

  const id = await uniqueMeshId(projectId, name);
  const caseDir = meshDirAbsolute(projectId, id);
  const srcDir = meshSrcDir(projectId, id);
  const srcAbs = path.join(srcDir, `source${path.extname(file.name).toLowerCase()}`);
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(srcAbs, file.data);

  const conversion = await convertMeshFileToCase(caseDir, srcAbs, format, srcDir);

  const built = conversion.success && !!(await readMeshBoundary(projectId, id));
  if (!built) {
    await deleteMeshSource(projectId, id);
    return { meshes: await publicMeshes(projectId), conversion };
  }

  // The polyMesh is built; drop the source + intermediate files (re-importable).
  await fs.rm(srcDir, { recursive: true, force: true }).catch(() => undefined);
  const meta: MeshMeta = { id, name, kind: format, createdAt: new Date().toISOString() };
  await writeMeshMeta(projectId, meta);

  const [mesh, meshes] = await Promise.all([toMeshSource(projectId, meta), publicMeshes(projectId)]);
  return { mesh, meshes, conversion };
}

/** Remove a mesh source from the library. */
export async function removeMesh(
  viewer: Viewer,
  projectId: string,
  meshId: string,
): Promise<{ meshes: MeshSource[] }> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }
  await deleteMeshSource(projectId, meshId);
  return { meshes: await publicMeshes(projectId) };
}

/** Read the last saved merge plan (for pre-filling the merge dialog). */
export async function getMergePlan(viewer: Viewer, projectId: string): Promise<MergePlan | null> {
  await assertProjectVisible(viewer, projectId);
  return readMergePlan(projectId);
}

/** Persist a merge plan without running it (so a draft survives a reload). */
export async function saveMergePlan(
  viewer: Viewer,
  projectId: string,
  plan: MergePlan,
): Promise<MergePlan> {
  await assertProjectVisible(viewer, projectId);
  return persistPlan(projectId, plan);
}

// --------------------------------------------------------------------------
// Merge pipeline.
// --------------------------------------------------------------------------

/** Build a reported step from a real command result. */
function toStep(
  kind: MergeStepKind,
  label: string,
  display: string,
  result: CommandResult,
): MergeStep {
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError}`
    : result.timedOut
      ? '\n[runner] command timed out'
      : '';
  return {
    kind,
    label,
    command: display,
    status: commandFailed(result) ? 'failed' : 'success',
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr + extra),
    durationMs: result.durationMs,
  };
}

/** A non-command step (prepare/cleanup) that succeeded, with an optional note. */
function okStep(kind: MergeStepKind, label: string, note = ''): MergeStep {
  return { kind, label, command: '', status: 'success', exitCode: null, stdout: note, stderr: '', durationMs: 0 };
}

/** A non-command step that failed (a filesystem error during prepare/cleanup). */
function failStep(kind: MergeStepKind, label: string, message: string): MergeStep {
  return { kind, label, command: '', status: 'failed', exitCode: null, stdout: '', stderr: message, durationMs: 0 };
}

/**
 * The interfaces a plan asks for, normalizing the legacy `stitches` field: when
 * `interfaces` is present it wins (each entry carries its own coupling); otherwise
 * a legacy draft's `stitches` are interpreted as interfaces with coupling
 * 'stitch'. Preferring `interfaces` (rather than concatenating) keeps a re-run of
 * a persisted plan — which carries BOTH the normalized interfaces and the verbatim
 * legacy stitches — from double-counting the same pair.
 */
function planInterfaces(plan: MergePlan): MeshInterface[] {
  if (plan.interfaces && plan.interfaces.length > 0) return plan.interfaces;
  return (plan.stitches ?? []).map((stitch) => ({
    aMeshId: stitch.aMeshId,
    aPatch: stitch.aPatch,
    bMeshId: stitch.bMeshId,
    bPatch: stitch.bPatch,
    coupling: 'stitch' as const,
  }));
}

/** Normalize + persist a plan (dedupe the order, keep first occurrence). The
 * legacy `stitches` ride along verbatim (so an old draft round-trips) next to the
 * normalized `interfaces`; the rigid part placements ride along too so an assembly
 * draft survives a reload and a re-run reproduces the exact same geometry. */
async function persistPlan(projectId: string, plan: MergePlan): Promise<MergePlan> {
  const normalized: MergePlan = {
    order: [...new Set(plan.order)],
    interfaces: planInterfaces(plan),
    stitches: plan.stitches ?? [],
    transforms: plan.transforms ?? [],
  };
  await writeMergePlan(projectId, normalized);
  return normalized;
}

/**
 * Stage one source as a minimal OpenFOAM case in `caseDir`: copy its polyMesh,
 * (optionally) bake a rigid placement into the staged points, write the minimal
 * system/ dictionaries the utilities need, and (when merging more than one mesh)
 * prefix every patch with the mesh's slug so names are globally unique before
 * mergeMeshes combines them.
 *
 * When `transform` is a non-identity placement, its rotation+translation is
 * applied to THIS staged copy's constant/polyMesh/points only (the library source
 * stays pristine) so the merged geometry matches the browser assembly preview
 * exactly. points and boundary are independent, so this never disturbs the patch
 * names the prefix step below rewrites. The master (order[0]) is passed no
 * transform, so it is never moved.
 */
async function stageSource(
  projectId: string,
  meshId: string,
  caseDir: string,
  slug: string,
  patches: BoundaryPatchDetail[],
  prefix: boolean,
  transform?: PartTransform,
): Promise<void> {
  const srcPolyMesh = meshPolyMeshDir(projectId, meshId);
  const destPolyMesh = path.join(caseDir, 'constant', 'polyMesh');
  await fs.mkdir(destPolyMesh, { recursive: true });
  await fs.cp(srcPolyMesh, destPolyMesh, { recursive: true });

  // Bake the assembly placement into the staged points (never the source). Done
  // in-process (V8 float64) with three.js's exact quaternion→matrix formula so
  // preview == result; an identity/absent transform is a no-op (today's path).
  if (transform && !isIdentityTransform(transform)) {
    const pointsAbs = path.join(destPolyMesh, 'points');
    const points = await fs.readFile(pointsAbs);
    await fs.writeFile(pointsAbs, transformMeshPoints(points, transform.rotation, transform.translation));
  }

  // Minimal system/ trio so mergeMeshes / stitchMesh / checkMesh can load the case.
  const systemFiles: BaseFilePath[] = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'];
  for (const file of systemFiles) {
    const abs = path.join(caseDir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, renderBaseFile(file, []), 'utf8');
  }

  if (prefix) {
    const boundaryAbs = path.join(destPolyMesh, 'boundary');
    let content = await fs.readFile(boundaryAbs, 'utf8');
    for (const patch of patches) {
      content = renameBoundaryPatch(content, patch.name, `${slug}_${patch.name}`);
    }
    await fs.writeFile(boundaryAbs, content, 'utf8');
  }
}

/**
 * Stage the project's OWN case mesh as the merge master (Assembly v2 base=case,
 * sentinel order[0] === MERGE_BASE_CASE): copy the case's constant/polyMesh into
 * the work master and write the minimal system/ trio the utilities need. The base
 * is deliberately NOT prefixed — its inlet/outlet/interface patch names are
 * preserved so its 0/ physics can be merged back onto the promoted mesh unchanged.
 * The base is never moved, so no transform is applied. The source case mesh stays
 * pristine (the pipeline only touches the transient .work/ copy until promote).
 */
async function stageCaseMaster(projectId: string, caseDir: string): Promise<void> {
  const srcPolyMesh = path.join(caseDirAbsolute(projectId), 'constant', 'polyMesh');
  const destPolyMesh = path.join(caseDir, 'constant', 'polyMesh');
  await fs.mkdir(destPolyMesh, { recursive: true });
  await fs.cp(srcPolyMesh, destPolyMesh, { recursive: true });

  // Minimal system/ trio so mergeMeshes / createNonConformalCouples / checkMesh
  // can load the staged case (the base's own system/ is left untouched on disk).
  const systemFiles: BaseFilePath[] = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'];
  for (const file of systemFiles) {
    const abs = path.join(caseDir, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, renderBaseFile(file, []), 'utf8');
  }
}

/** Drop the zero-face patches stitchMesh leaves behind; return how many were removed. */
async function cleanupMasterBoundary(masterDir: string): Promise<number> {
  const boundaryAbs = path.join(masterDir, 'constant', 'polyMesh', 'boundary');
  const content = await fs.readFile(boundaryAbs, 'utf8');
  const cleaned = removeEmptyBoundaryPatches(content);
  if (cleaned === content) return 0;
  const before = parseBoundaryPatchDetails(content).length;
  const after = parseBoundaryPatchDetails(cleaned).length;
  await fs.writeFile(boundaryAbs, cleaned, 'utf8');
  return Math.max(0, before - after);
}

/** Failed-check count checkMesh reports ("Failed N mesh checks"), or 0 (incl. "Mesh OK"). */
function countCheckMeshFailures(stdout: string): number {
  const match = stdout.match(/Failed\s+(\d+)\s+mesh checks/i);
  return match ? Number(match[1]) : 0;
}

/**
 * Current face count of each named patch in the work master's boundary. After a
 * stitch a fully-fused interface patch is gone or `nFaces 0`; a patch still
 * carrying faces means stitchMesh matched none/few of them (parts not coincident).
 */
async function stitchedFaceCounts(masterDir: string, patches: string[]): Promise<Map<string, number>> {
  const boundaryAbs = path.join(masterDir, 'constant', 'polyMesh', 'boundary');
  const details = parseBoundaryPatchDetails(await fs.readFile(boundaryAbs, 'utf8'));
  const byName = new Map(details.map((d) => [d.name, d.nFaces] as const));
  return new Map(patches.map((p) => [p, byName.get(p) ?? 0] as const));
}

/** Replace the project's case mesh with the combined mesh from the work master. */
async function promoteMasterMesh(projectId: string, masterDir: string): Promise<void> {
  const srcPolyMesh = path.join(masterDir, 'constant', 'polyMesh');
  const destPolyMesh = path.join(caseDirAbsolute(projectId), 'constant', 'polyMesh');
  await fs.rm(destPolyMesh, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destPolyMesh), { recursive: true });
  await fs.cp(srcPolyMesh, destPolyMesh, { recursive: true });
}

/** Assemble the final result (boundary patches read back only on success). */
async function finalizeMerge(
  projectId: string,
  steps: MergeStep[],
  notes: string[],
  promoted: boolean,
): Promise<MergeRunResult> {
  const success = promoted && steps.every((step) => step.status === 'success');
  let boundaryPatches: MeshPatch[] = [];
  if (success) {
    const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
    boundaryPatches = boundary ? parseBoundaryPatchDetails(boundary.toString('utf8')) : [];
  }
  return { success, steps, notes, boundaryPatches, entries: await listCaseTree(projectId) };
}

/**
 * Run the merge pipeline for `plan` and, on success, promote the combined mesh
 * into the project's case. `order[0]` may be the `MERGE_BASE_CASE` sentinel to
 * build the assembly onto the project's OWN case mesh (Assembly v2), preserving
 * its `0/` physics. Validation errors (empty/invalid plan, unknown patch) throw;
 * an external tool failure resolves with `success: false` and the per-step logs
 * (mirrors the conversion flow), leaving the case mesh untouched.
 *
 * @throws 404 NOT_FOUND (project not visible), 409 NO_MESHES (empty plan),
 *         422 INVALID_MERGE_PLAN / STITCH_PATCH_NOT_FOUND (bad references).
 */
export async function runMerge(
  viewer: Viewer,
  projectId: string,
  plan: MergePlan,
): Promise<MergeRunResult> {
  await assertProjectVisible(viewer, projectId);

  // --- Validate the plan against the library (+ the case for a base=case) --
  const order = [...new Set(plan.order)];
  if (order.length === 0) {
    throw new AppError(409, 'NO_MESHES', 'Add at least one mesh to the merge.');
  }
  // Assembly v2: order[0] may be the sentinel = build onto the project case mesh.
  const baseIsCase = order[0] === MERGE_BASE_CASE;
  const metas = await listMeshSources(projectId);
  const byId = new Map(metas.map((meta) => [meta.id, meta] as const));
  for (const [index, id] of order.entries()) {
    if (id === MERGE_BASE_CASE) {
      if (index !== 0) {
        throw new AppError(422, 'INVALID_MERGE_PLAN', 'The project case can only be the first item in the merge.');
      }
      if (!(await caseFileExists(projectId, BOUNDARY_FILE))) {
        throw new AppError(422, 'INVALID_MERGE_PLAN', 'This project has no case mesh to use as the assembly base.');
      }
      continue;
    }
    if (!byId.has(id)) {
      throw new AppError(422, 'INVALID_MERGE_PLAN', 'The plan references a mesh that is not in the library.');
    }
  }

  // Human phrase for a part in an error/note (the case base has no library meta).
  const nameOf = (id: string): string =>
    id === MERGE_BASE_CASE ? 'the project case mesh' : `mesh "${byId.get(id)!.name}"`;

  // Parse each part's patches (the case boundary for the base=case), then validate
  // every interface reference up front. Legacy `stitches` normalize to interfaces.
  const patchesOf = new Map<string, BoundaryPatchDetail[]>();
  for (const id of order) {
    const boundary =
      id === MERGE_BASE_CASE
        ? await readCaseFile(projectId, BOUNDARY_FILE)
        : await readMeshBoundary(projectId, id);
    if (!boundary) {
      const which = id === MERGE_BASE_CASE ? 'The project case mesh' : `Mesh "${byId.get(id)!.name}"`;
      throw new AppError(422, 'INVALID_MERGE_PLAN', `${which} has no polyMesh boundary.`);
    }
    patchesOf.set(id, parseBoundaryPatchDetails(boundary.toString('utf8')));
  }
  const interfaces = planInterfaces(plan);
  for (const iface of interfaces) {
    for (const [meshId, patch] of [
      [iface.aMeshId, iface.aPatch],
      [iface.bMeshId, iface.bPatch],
    ] as const) {
      if (!order.includes(meshId)) {
        throw new AppError(422, 'INVALID_MERGE_PLAN', 'An interface references a mesh not included in the merge.');
      }
      if (!patchesOf.get(meshId)!.some((candidate) => candidate.name === patch)) {
        throw new AppError(
          422,
          'STITCH_PATCH_NOT_FOUND',
          `Patch "${patch}" was not found in ${nameOf(meshId)}.`,
        );
      }
    }
  }

  await persistPlan(projectId, plan);

  // Slugs (m1_, m2_, …) namespace each part's patches so mergeMeshes never fuses
  // two same-named patches. Prefix the base only when it is a LIBRARY source: a
  // base=case keeps its own patch names (inlet/outlet/interface) so its physics
  // survives the promote. Added parts are always namespaced when combining >1 mesh.
  const multi = order.length > 1;
  const slugOf = new Map<string, string>();
  order.forEach((id, index) => slugOf.set(id, `m${index + 1}`));
  const prefixOf = (index: number): boolean => (index === 0 ? multi && !baseIsCase : multi);
  const resolvePatch = (meshId: string, patch: string): string =>
    prefixOf(order.indexOf(meshId)) ? `${slugOf.get(meshId)}_${patch}` : patch;

  const notes: string[] = [];
  const steps: MergeStep[] = [];
  const timeoutMs = env.MERGE_STEP_TIMEOUT_MS;

  // Rigid placements from the assembly preview, keyed by mesh id. The master
  // (order[0]) is deliberately never looked up here — it is the fixed base and is
  // always staged at identity.
  const byMesh = new Map((plan.transforms ?? []).map((t) => [t.meshId, t] as const));

  // --- 1) prepare: stage each part (+ placement) + prefix its patches -------
  const workRoot = await resetMeshWork(projectId);
  const caseDirOf = (id: string): string => path.join(workRoot, slugOf.get(id)!);
  for (const [index, id] of order.entries()) {
    const slug = slugOf.get(id)!;
    const doPrefix = prefixOf(index);
    const isBaseCaseMaster = index === 0 && baseIsCase;
    const label = isBaseCaseMaster ? 'Prepare the project case mesh' : `Prepare ${byId.get(id)!.name}`;
    // The base part is never moved; every added part carries its optional placement.
    const transform = index === 0 ? undefined : byMesh.get(id);
    const placed = !!transform && !isIdentityTransform(transform);
    try {
      if (isBaseCaseMaster) {
        // Base=case: stage the project's own polyMesh as the master, UNPREFIXED.
        await stageCaseMaster(projectId, caseDirOf(id));
        steps.push(okStep('prepare', label, 'Staged the project case mesh as the assembly base (patches kept).'));
      } else {
        await stageSource(projectId, id, caseDirOf(id), slug, patchesOf.get(id)!, doPrefix, transform);
        const stagedNote = doPrefix ? `Patches prefixed with ${slug}_` : 'Staged source mesh';
        steps.push(okStep('prepare', label, placed ? `Transformed + staged; ${stagedNote}` : stagedNote));
      }
    } catch (err) {
      steps.push(failStep('prepare', label, err instanceof Error ? err.message : String(err)));
      return finalizeMerge(projectId, steps, notes, false);
    }
  }

  const masterDir = caseDirOf(order[0]);

  // --- 2) mergeMeshes: combine every additional source into the master -----
  // OpenFOAM.org v11+ dropped mergeMeshes' positional case arguments: the master
  // is the -case (here masterDir) and every mesh to fold in is named via the
  // -addCases list option. One case per step keeps each its own row in the report.
  for (let i = 1; i < order.length; i += 1) {
    const id = order[i];
    const planned = planOpenfoamCommand(
      env.MERGE_MESHES_BIN,
      ['-case', masterDir, '-addCases', `("${caseDirOf(id)}")`, '-overwrite'],
      masterDir,
    );
    const result = await runCommand({ ...planned, timeoutMs });
    const step = toStep('mergeMeshes', `Combine ${byId.get(id)!.name}`, planned.display, result);
    steps.push(step);
    if (step.status !== 'success') return finalizeMerge(projectId, steps, notes, false);
  }
  if (order.length > 1) notes.push(`Combined ${order.length} meshes with mergeMeshes.`);

  // --- 3) couple each interface (branch on coupling) -----------------------
  // nonConformalCyclic -> createNonConformalCouples (v12-native, keeps both parts);
  // stitch -> the legacy conformal stitchMesh fuse. Any NCC couple flips `hasNcc`,
  // which makes the cleanup below SKIP empty-patch removal (the couple's constraint
  // patches must be kept, and its nested-dict boundary must never be regex-rewritten).
  const masterBoundaryAbs = path.join(masterDir, 'constant', 'polyMesh', 'boundary');
  let hasNcc = false;
  let stitchedCount = 0;
  for (const iface of interfaces) {
    const aPatch = resolvePatch(iface.aMeshId, iface.aPatch);
    const bPatch = resolvePatch(iface.bMeshId, iface.bPatch);

    if (iface.coupling === 'nonConformalCyclic') {
      // OpenFOAM.org v12: createNonConformalCouples takes the two patch names as
      // POSITIONAL args and writes into the master's polyMesh in place. It KEEPS
      // both patches and ADDS the coupled nonConformalCyclic_on_* / nonConformalError_on_*
      // constraint patches. No -fields (this is a mesh-only work case; the field
      // BCs are realigned after promote). The rigid placement is already baked into
      // the staged points, so `transform none` is implicit — no transform arg.
      const planned = planOpenfoamCommand(
        env.NCC_COUPLE_BIN,
        [aPatch, bPatch, '-overwrite', '-case', masterDir],
        masterDir,
      );
      const result = await runCommand({ ...planned, timeoutMs });
      const step = toStep('createNonConformalCouples', `Couple ${aPatch} ↔ ${bPatch}`, planned.display, result);
      steps.push(step);
      if (step.status !== 'success') return finalizeMerge(projectId, steps, notes, false);

      // Post-guard (analogue of the "stitch fused nothing" check): the couple only
      // created faces if BOTH nonConformalCyclic_on_<a> and _on_<b> now exist. When
      // the interface patches don't overlap, the tool exits 0 having created none.
      const details = parseBoundaryPatchDetails(await fs.readFile(masterBoundaryAbs, 'utf8'));
      const facesOf = new Map(details.map((d) => [d.name, d.nFaces] as const));
      const onA = `nonConformalCyclic_on_${aPatch}`;
      const onB = `nonConformalCyclic_on_${bPatch}`;
      if (!facesOf.has(onA) || !facesOf.has(onB)) {
        steps[steps.length - 1] = failStep(
          'createNonConformalCouples',
          `Couple ${aPatch} ↔ ${bPatch}`,
          `createNonConformalCouples ran but created no coupled faces — the interface patches ${aPatch} and ${bPatch} almost certainly don't overlap; check both parts share a coordinate frame with the interface surfaces coincident.`,
        );
        return finalizeMerge(projectId, steps, notes, false);
      }
      hasNcc = true;

      // Warn when a large share of the interface faces landed on nonConformalError
      // (poor overlap): only the overlapping region transfers flow.
      const errFaces =
        (facesOf.get(`nonConformalError_on_${aPatch}`) ?? 0) + (facesOf.get(`nonConformalError_on_${bPatch}`) ?? 0);
      const cplFaces = (facesOf.get(onA) ?? 0) + (facesOf.get(onB) ?? 0);
      if (errFaces > 0 && errFaces >= 0.2 * (errFaces + cplFaces)) {
        notes.push(
          `Interface ${aPatch} ↔ ${bPatch}: ${Math.round((100 * errFaces) / (errFaces + cplFaces))}% of the interface faces did not overlap (they became nonConformalError faces) — review that the two surfaces are coincident in the same coordinate frame; only the overlapping region will transfer flow.`,
        );
      }
      continue;
    }

    // coupling === 'stitch': the legacy CONFORMAL fuse (kept for back-compat).
    // Pre-stitch face counts (mergeMeshes preserves them) to later tell a real
    // fusion from a stitch that matched nothing.
    const origFaces = new Map<string, number>([
      [aPatch, patchesOf.get(iface.aMeshId)!.find((p) => p.name === iface.aPatch)?.nFaces ?? 0],
      [bPatch, patchesOf.get(iface.bMeshId)!.find((p) => p.name === iface.bPatch)?.nFaces ?? 0],
    ]);
    // OpenFOAM.org v11+ stitchMesh takes a single patchPairs list "((master slave))"
    // (not two positional names) and replaced -partial/-perfect with -tol. Pass the
    // tolerance only when configured so the tool's own default (1e-4) otherwise wins.
    const stitchArgs = [`((${aPatch} ${bPatch}))`, '-overwrite', '-case', masterDir];
    const tol = env.STITCH_TOL.trim();
    if (tol) stitchArgs.push('-tol', tol);
    const planned = planOpenfoamCommand(env.STITCH_MESH_BIN, stitchArgs, masterDir);
    const result = await runCommand({ ...planned, timeoutMs });
    const step = toStep('stitchMesh', `Stitch ${aPatch} ↔ ${bPatch}`, planned.display, result);
    steps.push(step);
    if (step.status !== 'success') return finalizeMerge(projectId, steps, notes, false);

    // A stitch can exit 0 yet fuse 0 faces when the patches are not coincident,
    // leaving both at full nFaces — that promotes two disconnected domains as a
    // clean success. Fail when nothing fused; warn when only partially fused.
    const after = await stitchedFaceCounts(masterDir, [aPatch, bPatch]);
    const nothingFused = [aPatch, bPatch].every(
      (p) => (origFaces.get(p) ?? 0) > 0 && (after.get(p) ?? 0) >= (origFaces.get(p) ?? 0),
    );
    if (nothingFused) {
      steps[steps.length - 1] = failStep(
        'stitchMesh',
        `Stitch ${aPatch} ↔ ${bPatch}`,
        `stitchMesh ran but fused no faces (${aPatch} and ${bPatch} still carry every face). The two patches are almost certainly not coincident: check both parts are in the same coordinate frame with the interface surfaces touching, and raise STITCH_TOL if their meshes differ slightly.`,
      );
      return finalizeMerge(projectId, steps, notes, false);
    }
    const partial = [aPatch, bPatch].filter((p) => (after.get(p) ?? 0) > 0);
    if (partial.length) {
      notes.push(
        `Interface ${aPatch} ↔ ${bPatch}: ${partial.map((p) => `${p} still has ${after.get(p)} face(s)`).join(', ')} after stitching — only partially fused; review coincidence / STITCH_TOL.`,
      );
    }
    stitchedCount += 1;
  }
  const nccCount = interfaces.filter((iface) => iface.coupling === 'nonConformalCyclic').length;
  if (nccCount) notes.push(`Coupled ${nccCount} non-conformal interface(s) with createNonConformalCouples.`);
  if (stitchedCount) notes.push(`Stitched ${stitchedCount} interface(s).`);

  // --- 4) cleanup: remove the zero-face patches stitchMesh leaves behind ---
  // SKIP when any non-conformal couple exists: createNonConformalCouples's
  // nonConformalError_on_* patches are legitimately nFaces 0, so removing them (or
  // regex-rewriting the NCC boundary at all) would corrupt the coupling.
  if (hasNcc) {
    steps.push(
      okStep(
        'cleanup',
        'Clean up empty patches',
        'Skipped: non-conformal coupling keeps its constraint patches (nonConformalCyclic / nonConformalError), so empty-patch removal is not run.',
      ),
    );
  } else {
    try {
      const removed = await cleanupMasterBoundary(masterDir);
      steps.push(
        okStep('cleanup', 'Clean up empty patches', removed > 0 ? `Removed ${removed} empty patch(es).` : 'No empty patches.'),
      );
    } catch (err) {
      steps.push(failStep('cleanup', 'Clean up empty patches', err instanceof Error ? err.message : String(err)));
      return finalizeMerge(projectId, steps, notes, false);
    }
  }

  // --- 5) checkMesh on the combined master ---------------------------------
  const checkPlan = planOpenfoamCommand(env.CHECK_MESH_BIN, ['-case', masterDir], masterDir);
  const checkResult = await runCommand({ ...checkPlan, timeoutMs });
  const checkStep = toStep('checkMesh', 'Check combined mesh', checkPlan.display, checkResult);
  steps.push(checkStep);
  if (checkStep.status !== 'success') return finalizeMerge(projectId, steps, notes, false);
  // checkMesh exits 0 even when it reports failed checks, so a clean exit does NOT
  // mean a clean mesh — surface the count so a "success" never overstates validity.
  const meshIssues = countCheckMeshFailures(checkResult.stdout);
  if (meshIssues > 0) {
    notes.push(
      `checkMesh reported ${meshIssues} failed mesh check(s) (e.g. non-orthogonality, skewness): the meshes were combined but the result may be low quality — open the checkMesh log and review before running the solver.`,
    );
  }

  // --- 6) promote: back up, replace the case mesh, realign 0/ fields -------
  // Back up only when there is an existing case to protect; a mesh-only project
  // has no case/ dir yet (ensureOriginalBackup would fail copying a missing dir).
  if (!(await caseIsEmpty(projectId))) {
    await ensureOriginalBackup(projectId);
  }
  await promoteMasterMesh(projectId, masterDir);
  try {
    // A case base preserves its physics (merge mode keeps existing BCs, only new
    // patches get defaults); a library base rebuilds every field (patches renamed).
    const mode = baseIsCase ? 'merge' : 'rebuild';
    const sync = await syncBoundaryFields(viewer, projectId, { mode });
    if (sync.updated.length)
      notes.push(
        mode === 'merge'
          ? `Re-aligned ${sync.updated.length} field(s): kept the existing boundary conditions of the case's patches and added generic defaults for the newly coupled / added patches. Set the physics for the added part's patches before solving.`
          : `Re-aligned ${sync.updated.length} field(s) to the merged patch set — their boundary conditions were reset to generic defaults because the patches were renamed (m1_*, m2_*, …). Re-specify your inlet / outlet / physical BCs before solving.`,
      );
  } catch {
    // No 0/ fields to align yet (a mesh-only project): the user makes the case
    // runnable next, which scaffolds them. Not a merge failure.
  }

  return finalizeMerge(projectId, steps, notes, true);
}

// --------------------------------------------------------------------------
// Per-source render (the "Assemble" tab preview).
//
// The assembly workspace needs to draw each library source on its own so the
// user can pick a mounting face on the base and place the added parts. This
// mirrors the case-mesh viewer (mesh.service.ts) exactly — the same offline
// extractPatches.py → GLB + manifest (+ edges) pipeline, the same build-on-demand
// staleness, the same injectable command runner — but points the extractor at a
// LIBRARY source directory and caches the artifacts under meshes/<id>/.viz/. The
// small resolver/probe/summary helpers are duplicated here (rather than imported
// from mesh.service) so the two viewers own their code independently.
// --------------------------------------------------------------------------

/** Does an absolute path exist on disk? */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the boundary-patch extractor script (configured, else bundled default). */
function extractPatchesScript(): string {
  const configured = env.EXTRACT_PATCHES_SCRIPT.trim();
  if (configured) return configured;
  // Default: the script bundled with the API at apps/api/scripts/extractPatches.py,
  // resolved relative to THIS module (not process.cwd()), so it works from source
  // (tsx, src/) or the compiled output (dist/). scripts/ is not compiled, so it is
  // three levels up to apps/api from src/modules/projects (and from dist/…).
  return path.resolve(__dirname, '../../../scripts/extractPatches.py');
}

/** Build a concise, actionable failure message from an extractor command result. */
function summarizeVizFailure(result: CommandResult): string {
  if (result.spawnError) return `Could not start the extractor: ${result.spawnError}`;
  if (result.timedOut) return 'The mesh extractor timed out.';
  const detail = tail(result.stderr || result.stdout || '');
  return `The mesh extractor exited with code ${result.exitCode ?? 'null'}.${detail ? `\n${detail}` : ''}`;
}

/**
 * Build (or rebuild) a library source's cached render: run extractPatches.py
 * against the source's own directory (it writes its own case.foam and reads
 * constant/polyMesh, so no system/ is needed) to produce the GLB + manifest
 * (+ edges.bin) under meshes/<id>/.viz/. Synchronous in-request and bounded by
 * MESH_BUILD_TIMEOUT_MS, exactly like the case-mesh build.
 *
 * @throws 500 SCRIPT_MISSING if the extractor is not on disk (fail fast, clear).
 * @throws 502 MESH_BUILD_FAILED if the run errors or produces no GLB.
 */
async function buildMeshSourceViz(projectId: string, meshId: string): Promise<void> {
  const script = extractPatchesScript();
  if (!(await pathExists(script))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `Mesh extractor not found at ${script}. Set EXTRACT_PATCHES_SCRIPT to its absolute path.`,
    );
  }

  const caseDir = meshDirAbsolute(projectId, meshId);
  const { glb, manifest } = meshSourceVizPaths(projectId, meshId);
  await fs.mkdir(meshSourceVizDir(projectId, meshId), { recursive: true });

  const result = await runCommand({
    command: env.MESH_PYTHON_BIN,
    args: [script, caseDir, glb, manifest],
    cwd: caseDir,
    env: process.env,
    timeoutMs: env.MESH_BUILD_TIMEOUT_MS,
  });

  // The script may exit 0 yet not write the GLB; treat a missing output as a
  // failure so we never serve a stale/absent render as success.
  if (result.spawnError || result.timedOut || result.exitCode !== 0 || !(await pathExists(glb))) {
    throw new AppError(502, 'MESH_BUILD_FAILED', summarizeVizFailure(result));
  }
}

/**
 * Ensure a source's render exists and is current, building it (bounded, in-request)
 * only when the GLB is missing or stale. Shared by the manifest AND geometry
 * endpoints so EITHER is a valid build trigger: the Assemble tab fetches a source's
 * geometry directly (its patch names come from the library list, not this manifest),
 * so geometry must build the render itself instead of 409-ing when asked "out of
 * order". Only geometry (never edges) also triggers a build, so a single source is
 * never built twice concurrently.
 */
async function ensureMeshSourceViz(projectId: string, meshId: string): Promise<void> {
  if (await meshSourceVizIsStale(projectId, meshId)) {
    await buildMeshSourceViz(projectId, meshId);
  }
}

/**
 * Return a library source's patch manifest, building its render on demand when
 * missing or stale (a bounded synchronous build).
 *
 * @throws 404 NOT_FOUND if the project is not visible or the source is unknown.
 * @throws 500/502 if the build fails (see buildMeshSourceViz).
 */
export async function getMeshSourceManifest(
  viewer: Viewer,
  projectId: string,
  meshId: string,
): Promise<MeshManifest> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }

  await ensureMeshSourceViz(projectId, meshId);

  const stored = await readMeshSourceVizManifest(projectId, meshId);
  if (!stored) {
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The mesh manifest could not be read after build.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/**
 * Return a library source's rendered GLB geometry bytes, building the render on
 * demand when missing or stale. The Assemble tab fetches geometry directly (it does
 * not read this source's manifest), so geometry is a self-sufficient build trigger
 * rather than a read that assumes a prior manifest call.
 *
 * @throws 404 NOT_FOUND if the project is not visible or the source is unknown.
 * @throws 500/502 if the build fails (see buildMeshSourceViz).
 */
export async function getMeshSourceGeometry(
  viewer: Viewer,
  projectId: string,
  meshId: string,
): Promise<Buffer> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }
  await ensureMeshSourceViz(projectId, meshId);
  const glb = await readMeshSourceVizGlb(projectId, meshId);
  if (!glb) {
    // ensureMeshSourceViz throws on a failed build, so a null GLB here is an
    // unexpected post-build anomaly rather than "not built yet".
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The 3D preview could not be built.');
  }
  return glb;
}

/**
 * Return a library source's cell-edge buffer, or null when this render has none
 * (an older build, or edge extraction was skipped). The viewer falls back to a
 * client-side overlay when null.
 *
 * @throws 404 NOT_FOUND if the project is not visible or the source is unknown.
 */
export async function getMeshSourceEdges(
  viewer: Viewer,
  projectId: string,
  meshId: string,
): Promise<Buffer | null> {
  await assertProjectVisible(viewer, projectId);
  if (!(await meshSourceExists(projectId, meshId))) {
    throw new AppError(404, 'NOT_FOUND', 'Mesh source not found');
  }
  return readMeshSourceVizEdges(projectId, meshId);
}
