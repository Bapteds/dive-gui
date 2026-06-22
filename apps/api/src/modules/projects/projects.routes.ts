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
  deleteCaseFileController,
  downloadCaseController,
  getCaseFileContentController,
  getCaseFilesController,
  importCaseFilesController,
  parseCaseUpload,
  resetCaseController,
  saveCaseFileContentController,
  scaffoldCaseController,
  verifyCaseController,
} from './files.controller';
import { createFileSchema, filePathQuerySchema } from './files.schemas';
import {
  addCollaboratorSchema,
  collaboratorParamSchema,
  createProjectSchema,
  projectIdParamSchema,
} from './projects.schemas';
import {
  applyTemplateController,
  previewApplyTemplateController,
} from '../templates/templates.controller';
import { applyDecisionsSchema, applyTemplateParamSchema } from '../templates/templates.schemas';

/**
 * Body parser for the file-save route only. The global JSON limit (16kb) is far
 * too small for file content, and the editor sends raw text, so accept any
 * content-type as text up to the editable cap.
 */
const parseFileContent = express.text({ type: '*/*', limit: EDITABLE_FILE_MAX_BYTES });

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

  // Apply a shared template to this project's case: preview the conflicts, then
  // apply with a per-file decision map. Authorization is project visibility.
  router.get(
    '/:id/apply-template/:templateId/preview',
    validate({ params: applyTemplateParamSchema }),
    asyncHandler(previewApplyTemplateController),
  );
  router.post(
    '/:id/apply-template/:templateId',
    validate({ params: applyTemplateParamSchema, body: applyDecisionsSchema }),
    asyncHandler(applyTemplateController),
  );

  return router;
}
