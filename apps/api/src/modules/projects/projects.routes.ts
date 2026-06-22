// Projects router, mounted at /api/v1/projects.
// Every route requires an authenticated user; access is visibility-scoped in
// the service (owner + collaborators, or any super-admin).
import { Router } from 'express';
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
  downloadCaseController,
  getCaseFilesController,
  importCaseFilesController,
  parseCaseUpload,
  scaffoldCaseController,
  verifyCaseController,
} from './files.controller';
import {
  addCollaboratorSchema,
  collaboratorParamSchema,
  createProjectSchema,
  projectIdParamSchema,
} from './projects.schemas';

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

  return router;
}
