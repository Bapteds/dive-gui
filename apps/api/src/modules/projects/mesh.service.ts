// 3D mesh viewer ("Visualize" tab): business logic.
//
// A project that has imported an OpenFOAM mesh (constant/polyMesh) can be
// rendered in the browser. Heavy parsing is done ONCE, offline, by a one-shot
// Python script (scripts/extractPatches.py, reusing PyVista) that extracts only
// the boundary surfaces into a compact GLB + a JSON manifest, cached on disk
// under the project's viz/ store. The API then serves those artifacts to a
// three.js viewer.
//
// This follows the CGNS conversion module exactly (conversion.service.ts): the
// script path is resolved relative to THIS module (cwd-independent) with an
// env override and an existence pre-check, the command runs through the
// injectable runner (commandRunner.setCommandRunner) so tests run without
// PyVista, and a build that produces no output is treated as a failure.
//
// Access model: gated by *project* visibility (a project the viewer cannot see
// returns 404 — no existence leak), then by a server-side polyMesh gate behind
// the client-side gate (no mesh => 409).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BOUNDARY_FILE,
  MESH_FILES,
  getFieldPatchType,
  isValidPatchName,
  parseBoundaryPatches,
  renameBoundaryPatch,
  renameFieldBoundaryPatch,
  setBoundaryPatchType,
  setFieldPatchType,
} from '../../lib/openfoamCase';
import {
  CONSTRAINT_PATCH_TYPES,
  MESH_PATCH_TYPES,
  type MeshBackupInfo,
  type MeshManifest,
  type MeshPatchEdit,
  type MeshPatchType,
} from '@dive/shared';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { runCommand, type CommandResult } from '../../lib/commandRunner';
import { commandFailed, planOpenfoamCommand } from '../../lib/openfoamCommand';
import {
  caseDirAbsolute,
  caseFileExists,
  listCaseTree,
  readCaseFile,
  writeCaseFile,
} from '../../lib/caseStorage';
import {
  readVizEdges,
  readVizGlb,
  readVizManifest,
  vizArtifactPaths,
  vizDirAbsolute,
  vizIsStale,
} from '../../lib/vizStorage';
import {
  backupExists,
  ensureOriginalBackup,
  readBackupMeta,
  restoreBackup,
  writeBackup,
} from '../../lib/meshBackupStorage';
import { assertProjectVisible, type Viewer } from './projects.service';
import { scaffoldCase, syncBoundaryFields } from './files.service';

/** Keep a captured stderr tail bounded when surfacing a build failure. */
const OUTPUT_TAIL_CHARS = 4000;
function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  return `…(truncated)\n${text.slice(text.length - OUTPUT_TAIL_CHARS)}`;
}

/** Does an absolute path exist on disk? */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-side gate (behind the client-side one): are all five mesh files
 * present? Reuses the canonical MESH_FILES list (full case-relative paths).
 */
async function hasPolyMesh(projectId: string): Promise<boolean> {
  const presence = await Promise.all(MESH_FILES.map((file) => caseFileExists(projectId, file)));
  return presence.every(Boolean);
}

/** Resolve the boundary-patch extractor script (configured, else bundled default). */
function extractPatchesScript(): string {
  const configured = env.EXTRACT_PATCHES_SCRIPT.trim();
  if (configured) return configured;
  // Default: the script bundled with the API at apps/api/scripts/extractPatches.py.
  // Resolved relative to THIS module (not process.cwd()), so it works from source
  // (tsx, src/) or the compiled output (dist/). `scripts/` is not compiled, so it
  // is three levels up to apps/api from both src/modules/projects and dist/….
  return path.resolve(__dirname, '../../../scripts/extractPatches.py');
}

/** Build a concise, actionable failure message from a command result. */
function summarizeFailure(result: CommandResult): string {
  if (result.spawnError) return `Could not start the extractor: ${result.spawnError}`;
  if (result.timedOut) return 'The mesh extractor timed out.';
  const detail = tail(result.stderr || result.stdout || '');
  return `The mesh extractor exited with code ${result.exitCode ?? 'null'}.${detail ? `\n${detail}` : ''}`;
}

/**
 * Build (or rebuild) the cached render: run the extractor to produce the GLB +
 * manifest under the project's viz/ store. Synchronous in-request, bounded by
 * MESH_BUILD_TIMEOUT_MS, exactly like the CGNS conversion (no job queue exists
 * yet — async is future work). Idempotent: concurrent callers each rebuild, and
 * later reads pick up the latest artifacts.
 *
 * @throws 500 SCRIPT_MISSING if the extractor is not on disk (fail fast, clear).
 * @throws 502 MESH_BUILD_FAILED if the run errors or produces no GLB.
 */
async function buildViz(projectId: string): Promise<void> {
  const script = extractPatchesScript();
  if (!(await pathExists(script))) {
    throw new AppError(
      500,
      'SCRIPT_MISSING',
      `Mesh extractor not found at ${script}. Set EXTRACT_PATCHES_SCRIPT to its absolute path.`,
    );
  }

  const caseDir = caseDirAbsolute(projectId);
  const { glb, manifest } = vizArtifactPaths(projectId);
  await fs.mkdir(vizDirAbsolute(projectId), { recursive: true });

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
    throw new AppError(502, 'MESH_BUILD_FAILED', summarizeFailure(result));
  }
}

/**
 * Return the patch manifest for a project's mesh, building the render on demand
 * if it is missing or stale. This is the call the client makes first; it may
 * trigger the (bounded) synchronous build.
 *
 * @throws 404 NOT_FOUND if the project is not visible (no existence leak).
 * @throws 409 NO_MESH if the project has no constant/polyMesh.
 * @throws 500/502 if the build fails (see buildViz).
 */
export async function getMeshManifest(viewer: Viewer, projectId: string): Promise<MeshManifest> {
  await assertProjectVisible(viewer, projectId);

  if (!(await hasPolyMesh(projectId))) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }

  if (await vizIsStale(projectId)) {
    await buildViz(projectId);
  }

  const stored = await readVizManifest(projectId);
  if (!stored) {
    // The build claimed success but the manifest is unreadable — surface it as a
    // build failure rather than an empty render.
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The mesh manifest could not be read after build.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/**
 * Return the rendered GLB geometry bytes for a project. The manifest call builds
 * the render, so by the time the client fetches geometry the artifact normally
 * exists; a missing GLB means the client asked out of order.
 *
 * @throws 404 NOT_FOUND if the project is not visible.
 * @throws 409 MESH_NOT_BUILT if the geometry has not been built yet.
 */
export async function getMeshGeometry(viewer: Viewer, projectId: string): Promise<Buffer> {
  await assertProjectVisible(viewer, projectId);
  const glb = await readVizGlb(projectId);
  if (!glb) {
    throw new AppError(409, 'MESH_NOT_BUILT', 'The 3D preview has not been built yet.');
  }
  return glb;
}

/**
 * Return the cell-edge buffer for a project's render, or null when this render
 * has none (an older build, or edge extraction was skipped). The viewer falls
 * back to a client-side overlay when null.
 *
 * @throws 404 NOT_FOUND if the project is not visible.
 */
export async function getMeshEdges(viewer: Viewer, projectId: string): Promise<Buffer | null> {
  await assertProjectVisible(viewer, projectId);
  return readVizEdges(projectId);
}

/** Skip files larger than this when scanning for boundaryField (mesh data is big). */
const FIELD_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Rename a boundary patch. Updates the patch header in constant/polyMesh/boundary
 * AND every field file's `boundaryField` entry, so the case stays valid (an
 * OpenFOAM field's boundaryField must cover exactly the mesh patches). The render
 * cache becomes stale (boundary mtime changes) and is rebuilt on the next
 * manifest fetch. Returns the refreshed patch-name list.
 *
 * @throws 404 NOT_FOUND if the project is not visible, or `from` is not a patch.
 * @throws 409 NO_MESH if there is no boundary file; 409 PATCH_EXISTS on collision.
 * @throws 422 VALIDATION_ERROR if `to` is not a valid patch name.
 */
export async function renameMeshPatch(
  viewer: Viewer,
  projectId: string,
  from: string,
  to: string,
): Promise<{ patches: string[] }> {
  await assertProjectVisible(viewer, projectId);

  if (!isValidPatchName(to)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'A patch name must be a single word (letters, digits, underscore).');
  }

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  if (!boundary) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  const content = boundary.toString('utf8');
  const patches = parseBoundaryPatches(content);

  if (!patches.includes(from)) {
    throw new AppError(404, 'NOT_FOUND', `Patch "${from}" was not found in the mesh.`);
  }
  if (from === to) {
    return { patches };
  }
  if (patches.includes(to)) {
    throw new AppError(409, 'PATCH_EXISTS', `A patch named "${to}" already exists.`);
  }

  // 1) The mesh boundary file (the source of truth for patch names).
  const newBoundary = renameBoundaryPatch(content, from, to);
  await writeCaseFile(projectId, BOUNDARY_FILE, newBoundary);

  // 2) Field files' boundaryField, to keep the case valid. Scan only small text
  //    dictionaries (skip the large polyMesh data) that mention boundaryField.
  const entries = await listCaseTree(projectId);
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (entry.path.startsWith('constant/polyMesh/')) continue;
    if (entry.size > FIELD_SCAN_MAX_BYTES) continue;
    const buffer = await readCaseFile(projectId, entry.path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    if (!text.includes('boundaryField')) continue;
    const updated = renameFieldBoundaryPatch(text, from, to);
    if (updated !== text) {
      await writeCaseFile(projectId, entry.path, updated);
    }
  }

  return { patches: parseBoundaryPatches(newBoundary) };
}

/** Is `type` one of the constraint types (field BC must match it exactly)? */
function isConstraintType(type: string): boolean {
  return (CONSTRAINT_PATCH_TYPES as readonly string[]).includes(type);
}

/**
 * Reconcile one field file's boundaryField entry for `patch` with the patch's
 * new geometric `type`:
 *  - a constraint type forces the field BC to the SAME type (solver requires it);
 *  - a non-constraint type (patch / wall) resets a leftover constraint BC to a
 *    generic `zeroGradient`, otherwise keeps the user's BC untouched.
 * Returns the (possibly unchanged) text.
 */
function propagateFieldType(text: string, patch: string, type: MeshPatchType): string {
  if (isConstraintType(type)) {
    return setFieldPatchType(text, patch, type);
  }
  const current = getFieldPatchType(text, patch);
  if (current && isConstraintType(current)) {
    return setFieldPatchType(text, patch, 'zeroGradient');
  }
  return text;
}

/**
 * Apply a set of patch renames to one file's text without intermediate
 * collisions. Each `from` is first renamed to a unique placeholder, then every
 * placeholder to its final `to` — so swaps (A<->B) and chains (A->B, B->C) are
 * handled correctly. `renameFn` is the boundary or field-scoped renamer.
 */
function applyRenames(
  text: string,
  renames: Map<string, string>,
  renameFn: (content: string, from: string, to: string) => string,
): string {
  if (renames.size === 0) return text;
  let out = text;
  const placeholders: Array<[string, string]> = [];
  let index = 0;
  for (const [from, to] of renames) {
    const placeholder = `__DIVE_TMP_${index}__`;
    out = renameFn(out, from, placeholder);
    placeholders.push([placeholder, to]);
    index += 1;
  }
  for (const [placeholder, to] of placeholders) {
    out = renameFn(out, placeholder, to);
  }
  return out;
}

/**
 * Set the geometric `type` of a boundary patch in constant/polyMesh/boundary AND
 * keep the 0/ fields valid:
 *  - a constraint type (empty / symmetry / symmetryPlane / wedge) forces every
 *    field's boundaryField entry for the patch to the SAME type (the solver
 *    errors otherwise);
 *  - a non-constraint type (patch / wall) resets a leftover constraint field BC
 *    to a generic `zeroGradient`, and otherwise keeps the user's BCs.
 * The render cache goes stale (boundary mtime) and rebuilds on the next manifest
 * fetch, so the new type shows in the patch table.
 *
 * @throws 404 NOT_FOUND if the project is not visible, or `patch` is absent.
 * @throws 409 NO_MESH if there is no boundary file.
 * @throws 422 VALIDATION_ERROR if `type` is not a supported patch type.
 */
export async function setPatchType(
  viewer: Viewer,
  projectId: string,
  patch: string,
  type: MeshPatchType,
): Promise<{ patches: string[] }> {
  await assertProjectVisible(viewer, projectId);

  if (!(MESH_PATCH_TYPES as readonly string[]).includes(type)) {
    throw new AppError(422, 'VALIDATION_ERROR', `Unsupported patch type "${type}".`);
  }

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  if (!boundary) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  const content = boundary.toString('utf8');
  if (!parseBoundaryPatches(content).includes(patch)) {
    throw new AppError(404, 'NOT_FOUND', `Patch "${patch}" was not found in the mesh.`);
  }

  // 1) The mesh boundary file (the geometric type, source of truth).
  const newBoundary = setBoundaryPatchType(content, patch, type);
  await writeCaseFile(projectId, BOUNDARY_FILE, newBoundary);

  // 2) Propagate into the 0/ fields so the case stays valid.
  const entries = await listCaseTree(projectId);
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (entry.path.startsWith('constant/polyMesh/')) continue;
    if (entry.size > FIELD_SCAN_MAX_BYTES) continue;
    const buffer = await readCaseFile(projectId, entry.path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    if (!text.includes('boundaryField')) continue;

    const updated = propagateFieldType(text, patch, type);
    if (updated !== text) {
      await writeCaseFile(projectId, entry.path, updated);
    }
  }

  return { patches: parseBoundaryPatches(newBoundary) };
}

/**
 * Apply a batch of patch edits (rename + retype) atomically across the boundary
 * file and every 0/ field, in one pass. This is what the Visualize tab's "edit
 * names & types" overlay calls instead of the per-patch rename/type endpoints.
 *
 * Validation up front (all-or-nothing): each `from` exists, each `to` is a valid
 * OpenFOAM word, each `type` is supported, no patch is edited twice, and the
 * resulting full set of names is unique (catches collisions with unchanged
 * patches and between edits). Renames are then applied collision-free (see
 * applyRenames) and types propagated into the fields (see propagateFieldType).
 *
 * The ORIGINAL case is captured into the single backup slot before the first
 * write (ensureOriginalBackup), so the edit is reversible. The render cache goes
 * stale (boundary mtime) and rebuilds on the next manifest fetch.
 *
 * @throws 404 NOT_FOUND if the project is not visible, or a `from` is absent.
 * @throws 409 NO_MESH if there is no boundary file; 409 PATCH_EXISTS on a name clash.
 * @throws 422 VALIDATION_ERROR for an invalid name/type or a duplicated `from`.
 */
export async function editMeshPatches(
  viewer: Viewer,
  projectId: string,
  edits: MeshPatchEdit[],
): Promise<{ patches: string[] }> {
  await assertProjectVisible(viewer, projectId);

  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  if (!boundary) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  const content = boundary.toString('utf8');
  const current = parseBoundaryPatches(content);

  // Validate every edit before touching disk.
  const editByFrom = new Map<string, MeshPatchEdit>();
  for (const edit of edits) {
    if (editByFrom.has(edit.from)) {
      throw new AppError(422, 'VALIDATION_ERROR', `Patch "${edit.from}" is edited more than once.`);
    }
    editByFrom.set(edit.from, edit);
    if (!current.includes(edit.from)) {
      throw new AppError(404, 'NOT_FOUND', `Patch "${edit.from}" was not found in the mesh.`);
    }
    if (!isValidPatchName(edit.to)) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        `"${edit.to}" is not a valid patch name (a single word: letters, digits, underscore).`,
      );
    }
    if (!(MESH_PATCH_TYPES as readonly string[]).includes(edit.type)) {
      throw new AppError(422, 'VALIDATION_ERROR', `Unsupported patch type "${edit.type}".`);
    }
  }

  // Final name of every CURRENT patch (edited -> to, else unchanged); the full
  // set must be unique, and collect the real renames (to !== from).
  const renames = new Map<string, string>();
  const finalNames = new Set<string>();
  for (const name of current) {
    const edit = editByFrom.get(name);
    const finalName = edit ? edit.to : name;
    if (finalNames.has(finalName)) {
      throw new AppError(409, 'PATCH_EXISTS', `A patch named "${finalName}" already exists.`);
    }
    finalNames.add(finalName);
    if (edit && edit.to !== edit.from) renames.set(edit.from, edit.to);
  }

  // Capture the original before the first modification.
  await ensureOriginalBackup(projectId);

  // 1) Boundary file: renames first (collision-free), then types on final names.
  let newBoundary = applyRenames(content, renames, renameBoundaryPatch);
  for (const edit of edits) {
    newBoundary = setBoundaryPatchType(newBoundary, edit.to, edit.type);
  }
  await writeCaseFile(projectId, BOUNDARY_FILE, newBoundary);

  // 2) Field files (0/...): same renames + type propagation, one read/write each.
  const entries = await listCaseTree(projectId);
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    if (entry.path.startsWith('constant/polyMesh/')) continue;
    if (entry.size > FIELD_SCAN_MAX_BYTES) continue;
    const buffer = await readCaseFile(projectId, entry.path);
    if (!buffer) continue;
    const text = buffer.toString('utf8');
    if (!text.includes('boundaryField')) continue;

    let updated = applyRenames(text, renames, renameFieldBoundaryPatch);
    for (const edit of edits) {
      updated = propagateFieldType(updated, edit.to, edit.type);
    }
    if (updated !== text) {
      await writeCaseFile(projectId, entry.path, updated);
    }
  }

  return { patches: parseBoundaryPatches(newBoundary) };
}

/**
 * Return the status of the project's single mesh-backup slot, or null when no
 * backup has been taken yet.
 *
 * @throws 404 NOT_FOUND if the project is not visible.
 */
export async function getMeshBackup(
  viewer: Viewer,
  projectId: string,
): Promise<MeshBackupInfo | null> {
  await assertProjectVisible(viewer, projectId);
  return readBackupMeta(projectId);
}

/**
 * Overwrite the backup slot with the project's CURRENT case (kind 'manual'):
 * the explicit "make this the new baseline" action. Requires a mesh to exist.
 *
 * @throws 404 NOT_FOUND if the project is not visible.
 * @throws 409 NO_MESH if the project has no constant/polyMesh.
 */
export async function saveMeshBackup(viewer: Viewer, projectId: string): Promise<MeshBackupInfo> {
  await assertProjectVisible(viewer, projectId);
  if (!(await hasPolyMesh(projectId))) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  return writeBackup(projectId, 'manual');
}

/**
 * Restore the case from the backup slot (mesh + 0/ fields + everything under
 * case/), then rebuild the render and return the fresh manifest.
 *
 * @throws 404 NOT_FOUND if the project is not visible, or no backup exists.
 * @throws 500/502 if the post-restore rebuild fails (see buildViz).
 */
export async function restoreMeshBackup(viewer: Viewer, projectId: string): Promise<MeshManifest> {
  await assertProjectVisible(viewer, projectId);
  if (!(await backupExists(projectId))) {
    throw new AppError(404, 'NOT_FOUND', 'No mesh backup to restore.');
  }
  await restoreBackup(projectId);
  await buildViz(projectId);
  const stored = await readVizManifest(projectId);
  if (!stored) {
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The mesh manifest could not be read after restore.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/**
 * Force a rebuild of the render, then return the fresh manifest. Used by the
 * optional "rebuild" action (e.g. after a manual mesh edit).
 *
 * @throws 404/409/500/502 as for getMeshManifest / buildViz.
 */
export async function rebuildMesh(viewer: Viewer, projectId: string): Promise<MeshManifest> {
  await assertProjectVisible(viewer, projectId);
  if (!(await hasPolyMesh(projectId))) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }
  await buildViz(projectId);
  const stored = await readVizManifest(projectId);
  if (!stored) {
    throw new AppError(502, 'MESH_BUILD_FAILED', 'The mesh manifest could not be read after build.');
  }
  return { patches: stored.patches, generatedAt: stored.generatedAt };
}

/** Outcome of an autoPatch run on a project's mesh. */
export interface AutoPatchResult {
  /** True only when autoPatch exited 0. */
  success: boolean;
  /** The logical command line that was run (surfaced in the UI for transparency). */
  command: string;
  /** Process exit code, or null when killed / never spawned. */
  exitCode: number | null;
  /** Captured stdout (tail, truncated). */
  stdout: string;
  /** Captured stderr (tail, truncated). */
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Boundary patch names after the run (the auto-generated patches on success). */
  patches: string[];
}

/**
 * Run OpenFOAM's `autoPatch <featureAngle> -overwrite` on a project's mesh:
 * divides the external boundary faces into separate patches wherever adjacent
 * faces meet at an angle above `featureAngle` (degrees), rewriting
 * constant/polyMesh in place. The boundary file changes, so the cached render
 * goes stale (boundary mtime) and is rebuilt on the next manifest fetch — the
 * client drops its mesh queries on success.
 *
 * On success the 0/ fields are realigned to the new patch set (see
 * syncBoundaryFields) so the case stays runnable: autoPatch replaces the patches
 * wholesale, which would otherwise leave the field boundaryFields referencing
 * patches that no longer exist.
 *
 * autoPatch reads system/controlDict, so the minimal base files are scaffolded
 * first when the case has none (same as the conversion pipeline), letting the
 * action work on a freshly imported, mesh-only case.
 *
 * Like the conversion pipeline, an external-tool failure does NOT throw: it
 * resolves with `success: false` plus the captured logs so the UI can surface
 * them. Only access / missing-mesh problems throw.
 *
 * @throws 404 NOT_FOUND if the project is not visible (no existence leak).
 * @throws 409 NO_MESH if the project has no constant/polyMesh.
 */
export async function autoPatchMesh(
  viewer: Viewer,
  projectId: string,
  featureAngle: number,
): Promise<AutoPatchResult> {
  await assertProjectVisible(viewer, projectId);

  if (!(await hasPolyMesh(projectId))) {
    throw new AppError(409, 'NO_MESH', 'No polyMesh found for this project.');
  }

  // autoPatch rewrites constant/polyMesh in place; capture the original first so
  // the run is reversible from the backup slot.
  await ensureOriginalBackup(projectId);

  // autoPatch reads system/controlDict; generate the minimal base files when the
  // case has none so the utility can run on a mesh-only import.
  if (!(await caseFileExists(projectId, 'system/controlDict'))) {
    await scaffoldCase(viewer, projectId);
  }

  const caseDir = caseDirAbsolute(projectId);
  // autoPatch <featureAngle> -overwrite, scoped to this case. The angle is a
  // validated finite number and every token is real argv (never a shell string),
  // so a user-supplied value can never be interpreted as a command.
  const plan = planOpenfoamCommand(
    env.AUTO_PATCH_BIN,
    [String(featureAngle), '-overwrite', '-case', caseDir],
    caseDir,
  );
  const result = await runCommand({ ...plan, timeoutMs: env.CONVERSION_STEP_TIMEOUT_MS });

  // autoPatch replaces the boundary patches WHOLESALE (auto0, auto1, …), so the
  // 0/ fields now reference patches that no longer exist. Realign every field's
  // boundaryField to the new mesh patches (a valid BC per geometric type) so the
  // case stays runnable — the same sync used after a template/scaffold. Only on
  // success, and best-effort: a sync hiccup must not turn a good run into a
  // failure (the autoPatch result is still reported either way).
  if (!commandFailed(result)) {
    try {
      await syncBoundaryFields(viewer, projectId);
    } catch {
      // Leave the fields as-is; the mesh was still patched successfully.
    }
  }

  // Surface a runner-level reason (missing binary / timeout) in the captured
  // output, mirroring the conversion step report.
  const extra = result.spawnError
    ? `\n[runner] ${result.spawnError}`
    : result.timedOut
      ? '\n[runner] command timed out'
      : '';

  // Re-read the boundary so the UI can report the resulting patches (autoPatch
  // replaces them with auto-generated patches). Best-effort: an unreadable
  // boundary yields an empty list rather than failing the whole call.
  const boundary = await readCaseFile(projectId, BOUNDARY_FILE);
  const patches = boundary ? parseBoundaryPatches(boundary.toString('utf8')) : [];

  return {
    success: !commandFailed(result),
    command: plan.display,
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr + extra),
    durationMs: result.durationMs,
    patches,
  };
}
