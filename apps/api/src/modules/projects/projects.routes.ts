// Projects router, mounted at /api/v1/projects.
// Every route requires an authenticated user; access is visibility-scoped in
// the service (owner + collaborators, or any super-admin).
import express, { Router } from 'express';
import { EDITABLE_FILE_MAX_BYTES } from '@dive/shared';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { validate } from '../../middleware/validate';
import {
  addCollaboratorController,
  createProjectController,
  deleteProjectController,
  getProjectController,
  listProjectsController,
  removeCollaboratorController,
} from './projects.controller';
import {
  createCaseFileController,
  deleteCaseDirController,
  deleteCaseFileController,
  downloadCaseController,
  getCaseFileContentController,
  getCaseFilesController,
  importCaseFilesController,
  moveCaseEntryController,
  parseCaseUpload,
  resetCaseController,
  saveCaseFileContentController,
  scaffoldCaseController,
  scaffoldSolverController,
  syncBoundariesController,
  verifyCaseController,
  verifyRunnableController,
} from './files.controller';
import {
  convertCgnsController,
  deleteCgnsController,
  listCgnsController,
  uploadCgnsController,
} from './conversion.controller';
import {
  autoPatchMeshSourceController,
  deleteMeshController,
  editMeshSourcePatchesController,
  getAssemblyController,
  getMergePlanController,
  getMeshPatchesController,
  getMeshSourceEdgesController,
  getMeshSourceGeometryController,
  getMeshSourceManifestController,
  importMeshController,
  listMeshesController,
  mergeMeshesController,
  renameMeshSourcePatchController,
  saveMergePlanController,
} from './meshes.controller';
import {
  autoPatchController,
  editMeshPatchesController,
  getMeshBackupController,
  getMeshEdgesController,
  getMeshGeometryController,
  getMeshManifestController,
  rebuildMeshController,
  renameMeshPatchController,
  restoreMeshBackupController,
  saveMeshBackupController,
  setMeshPatchTypeController,
} from './mesh.controller';
import { applyBoundaryConditionsController, parseBoundaryUpload } from './boundary.controller';
import {
  getRunController,
  getRunLogController,
  listRunsController,
  startRunController,
  stopRunController,
} from './runs.controller';
import {
  downloadExportArtifactController,
  getExportStatusController,
  runExportController,
} from './export.controller';
import { exportArtifactParamSchema } from './export.schemas';
import {
  autoPatchSchema,
  editPatchesSchema,
  renamePatchSchema,
  setPatchTypeSchema,
} from './mesh.schemas';
import {
  createFileSchema,
  filePathQuerySchema,
  movePathSchema,
  scaffoldSolverSchema,
} from './files.schemas';
import { runIdParamSchema, startRunSchema } from './runs.schemas';
import {
  createStudyController,
  deleteStudyController,
  extractCenterlineController,
  getStudyController,
  listStudiesController,
  updateStudyController,
} from './studies.controller';
import {
  createStudySchema,
  extractCenterlineSchema,
  studyIdParamSchema,
  updateStudySchema,
} from './studies.schemas';
import { cgnsNameQuerySchema, convertCgnsSchema } from './conversion.schemas';
import {
  meshIdParamSchema,
  meshSourceAutoPatchSchema,
  meshSourceEditPatchesSchema,
  meshSourceRenamePatchSchema,
  mergePlanSchema,
} from './meshes.schemas';
import {
  addCollaboratorSchema,
  collaboratorParamSchema,
  createProjectSchema,
  projectIdParamSchema,
} from './projects.schemas';
import {
  applyTemplateController,
  applyTemplateFilesController,
  previewApplyTemplateController,
} from '../templates/templates.controller';
import {
  applyDecisionsSchema,
  applyTemplateFilesSchema,
  applyTemplateParamSchema,
} from '../templates/templates.schemas';

/**
 * Body parser for the file-save route only. The global JSON limit (16kb) is far
 * too small for file content, and the editor sends raw text, so accept any
 * content-type as text up to the editable cap.
 */
const parseFileContent = express.text({ type: '*/*', limit: EDITABLE_FILE_MAX_BYTES });

/**
 * JSON parser for the apply-template routes: a decision map / selected-paths array
 * for up to 1000 files overflows the 16kb global limit (which is skipped for these
 * routes in app.ts) (M9).
 */
const parseApplyBody = express.json({ limit: '1mb' });

/** Build the projects router (authenticated, visibility-scoped). */
export function createProjectsRouter(): Router {
  const router = Router();

  router.use(asyncHandler(requireAuth));

  router.get('/', asyncHandler(listProjectsController));
  router.post('/', validate({ body: createProjectSchema }), asyncHandler(createProjectController));

  router.get(
    '/:id',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getProjectController),
  );
  router.delete(
    '/:id',
    validate({ params: projectIdParamSchema }),
    asyncHandler(deleteProjectController),
  );

  router.post(
    '/:id/collaborators',
    validate({ params: projectIdParamSchema, body: addCollaboratorSchema }),
    asyncHandler(addCollaboratorController),
  );
  router.delete(
    '/:id/collaborators/:userId',
    validate({ params: collaboratorParamSchema }),
    asyncHandler(removeCollaboratorController),
  );

  // Case files: list, import (folder or .zip), download, verify, scaffold.
  router.get(
    '/:id/files',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getCaseFilesController),
  );
  router.delete(
    '/:id/files',
    validate({ params: projectIdParamSchema }),
    asyncHandler(resetCaseController),
  );
  router.post(
    '/:id/files/import',
    validate({ params: projectIdParamSchema }),
    parseCaseUpload,
    asyncHandler(importCaseFilesController),
  );
  router.get(
    '/:id/files/download',
    validate({ params: projectIdParamSchema }),
    asyncHandler(downloadCaseController),
  );
  router.get(
    '/:id/files/verify',
    validate({ params: projectIdParamSchema }),
    asyncHandler(verifyCaseController),
  );
  router.post(
    '/:id/files/scaffold',
    validate({ params: projectIdParamSchema }),
    asyncHandler(scaffoldCaseController),
  );

  // Runnability (Solver tab): report whether the case can run simpleFoam, and
  // generate the missing simpleFoam files (turbulence/transport + 0/ fields).
  router.get(
    '/:id/runnable',
    validate({ params: projectIdParamSchema }),
    asyncHandler(verifyRunnableController),
  );
  router.post(
    '/:id/runnable/scaffold',
    validate({ params: projectIdParamSchema, body: scaffoldSolverSchema }),
    asyncHandler(scaffoldSolverController),
  );
  router.post(
    '/:id/files/sync-boundaries',
    validate({ params: projectIdParamSchema }),
    asyncHandler(syncBoundariesController),
  );

  // Single-file content: read for the editor, save edited text back.
  router.get(
    '/:id/files/content',
    validate({ params: projectIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(getCaseFileContentController),
  );
  router.put(
    '/:id/files/content',
    validate({ params: projectIdParamSchema, query: filePathQuerySchema }),
    parseFileContent,
    asyncHandler(saveCaseFileContentController),
  );
  // Create a new (empty) file, or delete a single file, from the editor. The
  // JSON body of the create route is parsed by the global express.json (a path
  // is tiny); delete carries the path as a query param.
  router.post(
    '/:id/files/content',
    validate({ params: projectIdParamSchema, body: createFileSchema }),
    asyncHandler(createCaseFileController),
  );
  router.delete(
    '/:id/files/content',
    validate({ params: projectIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(deleteCaseFileController),
  );
  // Delete a whole folder, or move/rename a file or folder, from the editor.
  router.delete(
    '/:id/files/dir',
    validate({ params: projectIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(deleteCaseDirController),
  );
  router.post(
    '/:id/files/move',
    validate({ params: projectIdParamSchema, body: movePathSchema }),
    asyncHandler(moveCaseEntryController),
  );

  // CGNS mesh sources + conversion. Upload/list/delete a CGNS file, then convert
  // a chosen one into the case mesh (constant/polyMesh) using a chosen template.
  // The upload reuses the shared multipart parser; convert takes a JSON body.
  router.get(
    '/:id/cgns',
    validate({ params: projectIdParamSchema }),
    asyncHandler(listCgnsController),
  );
  router.post(
    '/:id/cgns',
    validate({ params: projectIdParamSchema }),
    parseCaseUpload,
    asyncHandler(uploadCgnsController),
  );
  router.delete(
    '/:id/cgns',
    validate({ params: projectIdParamSchema, query: cgnsNameQuerySchema }),
    asyncHandler(deleteCgnsController),
  );
  router.post(
    '/:id/cgns/convert',
    validate({ params: projectIdParamSchema, body: convertCgnsSchema }),
    asyncHandler(convertCgnsController),
  );

  // Mesh library + merge ("Merge meshes" flow). Import several polyMesh sources
  // into a reusable per-project library, then combine + conformally stitch a
  // chosen subset into the case's constant/polyMesh. Import reuses the shared
  // multipart parser; merge/plan take a JSON MergePlan body. Static sub-paths
  // (import/plan/merge) are registered before the dynamic ":meshId" routes.
  router.get(
    '/:id/meshes',
    validate({ params: projectIdParamSchema }),
    asyncHandler(listMeshesController),
  );
  router.post(
    '/:id/meshes/import',
    validate({ params: projectIdParamSchema }),
    parseCaseUpload,
    asyncHandler(importMeshController),
  );
  router.get(
    '/:id/meshes/plan',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getMergePlanController),
  );
  router.put(
    '/:id/meshes/plan',
    validate({ params: projectIdParamSchema, body: mergePlanSchema }),
    asyncHandler(saveMergePlanController),
  );
  router.post(
    '/:id/meshes/merge',
    validate({ params: projectIdParamSchema, body: mergePlanSchema }),
    asyncHandler(mergeMeshesController),
  );
  // Disassemble: the applied-assembly record (or null). A static sub-path, so it is
  // registered BEFORE the dynamic ":meshId" routes below (never captured as a mesh id).
  router.get(
    '/:id/meshes/assembly',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getAssemblyController),
  );
  router.get(
    '/:id/meshes/:meshId/patches',
    validate({ params: meshIdParamSchema }),
    asyncHandler(getMeshPatchesController),
  );
  // Per-source 3D render for the "Assemble" tab: the manifest call builds the
  // render on demand (extract boundary patches -> GLB + manifest, cached under
  // meshes/<id>/.viz/); geometry streams the cached GLB; edges the cell grid.
  router.get(
    '/:id/meshes/:meshId/manifest',
    validate({ params: meshIdParamSchema }),
    asyncHandler(getMeshSourceManifestController),
  );
  router.get(
    '/:id/meshes/:meshId/geometry',
    validate({ params: meshIdParamSchema }),
    asyncHandler(getMeshSourceGeometryController),
  );
  router.get(
    '/:id/meshes/:meshId/edges',
    validate({ params: meshIdParamSchema }),
    asyncHandler(getMeshSourceEdgesController),
  );
  // Re-patch a LIBRARY mesh before merging: split its boundary by feature angle
  // (so a single-patch .cgns import gets stitchable patches), then name them.
  router.post(
    '/:id/meshes/:meshId/auto-patch',
    validate({ params: meshIdParamSchema, body: meshSourceAutoPatchSchema }),
    asyncHandler(autoPatchMeshSourceController),
  );
  router.post(
    '/:id/meshes/:meshId/patches/rename',
    validate({ params: meshIdParamSchema, body: meshSourceRenamePatchSchema }),
    asyncHandler(renameMeshSourcePatchController),
  );
  // Visualize library: batch rename + retype a source's boundary patches (source
  // has no 0/ fields, so this is boundary-only; the render rebuilds on the mtime bump).
  router.put(
    '/:id/meshes/:meshId/patches',
    validate({ params: meshIdParamSchema, body: meshSourceEditPatchesSchema }),
    asyncHandler(editMeshSourcePatchesController),
  );
  router.delete(
    '/:id/meshes/:meshId',
    validate({ params: meshIdParamSchema }),
    asyncHandler(deleteMeshController),
  );

  // 3D mesh viewer ("Visualize" tab). The manifest call builds the render on
  // demand (extract boundary patches -> GLB + manifest, cached on disk); the
  // geometry call streams the cached GLB; rebuild forces a fresh extraction.
  router.get(
    '/:id/mesh/manifest',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getMeshManifestController),
  );
  router.get(
    '/:id/mesh/geometry',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getMeshGeometryController),
  );
  router.get(
    '/:id/mesh/edges',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getMeshEdgesController),
  );
  router.post(
    '/:id/mesh/rebuild',
    validate({ params: projectIdParamSchema }),
    asyncHandler(rebuildMeshController),
  );
  router.post(
    '/:id/mesh/patches/rename',
    validate({ params: projectIdParamSchema, body: renamePatchSchema }),
    asyncHandler(renameMeshPatchController),
  );
  router.post(
    '/:id/mesh/patches/type',
    validate({ params: projectIdParamSchema, body: setPatchTypeSchema }),
    asyncHandler(setMeshPatchTypeController),
  );
  // Auto-patch: run OpenFOAM autoPatch <featureAngle> -overwrite to split the
  // external boundary faces into patches by feature angle (rewrites the mesh
  // boundary in place; the render is rebuilt on the next manifest fetch).
  router.post(
    '/:id/mesh/auto-patch',
    validate({ params: projectIdParamSchema, body: autoPatchSchema }),
    asyncHandler(autoPatchController),
  );
  // Batch edit: rename and/or retype many patches at once (the "edit names &
  // types" overlay). Propagated into the 0/ fields; the original case is backed
  // up before the first edit so the change is reversible.
  router.put(
    '/:id/mesh/patches',
    validate({ params: projectIdParamSchema, body: editPatchesSchema }),
    asyncHandler(editMeshPatchesController),
  );
  // "Boundary conditions" overlay: apply a component BC preset (Turbine / Pipe /
  // DraftTube / Chamber + driving mode) to the case's 0/ fields. Multipart: a JSON
  // `payload` + an optional CSV (the draft-tube inlet profile). Backs up the case.
  router.post(
    '/:id/boundary-conditions/apply',
    validate({ params: projectIdParamSchema }),
    parseBoundaryUpload,
    asyncHandler(applyBoundaryConditionsController),
  );
  // Single-slot mesh backup: read its status, overwrite it with the current
  // case, or restore the case (mesh + 0/ fields) from it.
  router.get(
    '/:id/mesh/backup',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getMeshBackupController),
  );
  router.post(
    '/:id/mesh/backup',
    validate({ params: projectIdParamSchema }),
    asyncHandler(saveMeshBackupController),
  );
  router.post(
    '/:id/mesh/backup/restore',
    validate({ params: projectIdParamSchema }),
    asyncHandler(restoreMeshBackupController),
  );

  // OpenFOAM -> CGNS export for CFD-Post ("Export" tab). POST runs the 4-step
  // pipeline; GET returns the last run's profile/validation/artifacts; the
  // download route streams a produced artifact (out.cgns / session / memo / report).
  router.post(
    '/:id/export',
    validate({ params: projectIdParamSchema }),
    asyncHandler(runExportController),
  );
  router.get(
    '/:id/export',
    validate({ params: projectIdParamSchema }),
    asyncHandler(getExportStatusController),
  );
  router.get(
    '/:id/export/download/:artifact',
    validate({ params: exportArtifactParamSchema }),
    asyncHandler(downloadExportArtifactController),
  );

  // Apply a shared template to this project's case: preview the conflicts, then
  // apply with a per-file decision map. Authorization is project visibility.
  router.get(
    '/:id/apply-template/:templateId/preview',
    validate({ params: applyTemplateParamSchema }),
    asyncHandler(previewApplyTemplateController),
  );
  router.post(
    '/:id/apply-template/:templateId/files',
    parseApplyBody,
    validate({ params: applyTemplateParamSchema, body: applyTemplateFilesSchema }),
    asyncHandler(applyTemplateFilesController),
  );
  router.post(
    '/:id/apply-template/:templateId',
    parseApplyBody,
    validate({ params: applyTemplateParamSchema, body: applyDecisionsSchema }),
    asyncHandler(applyTemplateController),
  );

  // Solver runs ("Solver" tab). Start a run (spawns the solver in the case dir,
  // streaming its output to a persisted log), list/get runs, poll the log +
  // residual series while a run is active, and stop a run.
  router.get(
    '/:id/runs',
    validate({ params: projectIdParamSchema }),
    asyncHandler(listRunsController),
  );
  router.post(
    '/:id/runs',
    validate({ params: projectIdParamSchema, body: startRunSchema }),
    asyncHandler(startRunController),
  );
  router.get(
    '/:id/runs/:runId',
    validate({ params: runIdParamSchema }),
    asyncHandler(getRunController),
  );
  router.get(
    '/:id/runs/:runId/log',
    validate({ params: runIdParamSchema }),
    asyncHandler(getRunLogController),
  );
  router.post(
    '/:id/runs/:runId/stop',
    validate({ params: runIdParamSchema }),
    asyncHandler(stopRunController),
  );

  // Diameter-optimization studies ("Optimisation" tab). CRUD over a saved
  // morph + sweep + objective config; launching the sweep (POST .../run) arrives
  // with the orchestrator in a later phase.
  router.get(
    '/:id/studies',
    validate({ params: projectIdParamSchema }),
    asyncHandler(listStudiesController),
  );
  router.post(
    '/:id/studies',
    validate({ params: projectIdParamSchema, body: createStudySchema }),
    asyncHandler(createStudyController),
  );
  // Static sub-path BEFORE the dynamic :studyId routes so "centerline" is not
  // captured as a study id.
  router.post(
    '/:id/studies/centerline',
    validate({ params: projectIdParamSchema, body: extractCenterlineSchema }),
    asyncHandler(extractCenterlineController),
  );
  router.get(
    '/:id/studies/:studyId',
    validate({ params: studyIdParamSchema }),
    asyncHandler(getStudyController),
  );
  router.put(
    '/:id/studies/:studyId',
    validate({ params: studyIdParamSchema, body: updateStudySchema }),
    asyncHandler(updateStudyController),
  );
  router.delete(
    '/:id/studies/:studyId',
    validate({ params: studyIdParamSchema }),
    asyncHandler(deleteStudyController),
  );

  return router;
}
