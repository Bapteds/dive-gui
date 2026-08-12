// Meshing router, mounted at /api/v1/meshing. Every route requires an
// authenticated user; sessions are shared across the team (no per-user scoping).
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { validate } from '../../middleware/validate';
import { parseCaseUpload } from '../projects/files.controller';
import {
  copySessionController,
  createSessionController,
  deleteSessionController,
  deleteStlController,
  downloadSessionController,
  downloadStlController,
  fromChamberController,
  getMeshEdgesController,
  getMeshGeometryController,
  getMeshManifestController,
  getSessionController,
  listSessionsController,
  renameSessionController,
  runSnappyController,
  saveConfigController,
  uploadStlController,
} from './meshing.controller';
import {
  copySessionSchema,
  createSessionSchema,
  fromChamberSchema,
  meshingConfigSchema,
  renameSessionSchema,
  sessionIdParamSchema,
  stlNameQuerySchema,
} from './meshing.schemas';

/** Build the meshing router (authenticated). */
export function createMeshingRouter(): Router {
  const router = Router();

  router.use(asyncHandler(requireAuth));

  // Sessions: list + create.
  router.get('/', asyncHandler(listSessionsController));
  router.post('/', validate({ body: createSessionSchema }), asyncHandler(createSessionController));

  // Copy a session's setup; import a chamber build's patches (new/existing/copyFrom).
  router.post('/copy', validate({ body: copySessionSchema }), asyncHandler(copySessionController));
  router.post(
    '/from-chamber',
    validate({ body: fromChamberSchema }),
    asyncHandler(fromChamberController),
  );

  // One session: read + rename + delete.
  router.get('/:id', validate({ params: sessionIdParamSchema }), asyncHandler(getSessionController));
  router.patch(
    '/:id',
    validate({ params: sessionIdParamSchema, body: renameSessionSchema }),
    asyncHandler(renameSessionController),
  );
  router.delete(
    '/:id',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(deleteSessionController),
  );

  // STL surfaces: upload (multipart), download one, delete one.
  router.post(
    '/:id/stl',
    validate({ params: sessionIdParamSchema }),
    parseCaseUpload,
    asyncHandler(uploadStlController),
  );
  router.get(
    '/:id/stl',
    validate({ params: sessionIdParamSchema, query: stlNameQuerySchema }),
    asyncHandler(downloadStlController),
  );
  router.delete(
    '/:id/stl',
    validate({ params: sessionIdParamSchema, query: stlNameQuerySchema }),
    asyncHandler(deleteStlController),
  );

  // Run the snappyHexMesh pipeline.
  router.post(
    '/:id/run',
    validate({ params: sessionIdParamSchema, body: meshingConfigSchema }),
    asyncHandler(runSnappyController),
  );

  // Autosave the edited config (persist without running).
  router.put(
    '/:id/config',
    validate({ params: sessionIdParamSchema, body: meshingConfigSchema }),
    asyncHandler(saveConfigController),
  );

  // Result-mesh 3D viewer (build-on-demand, mirrors the project mesh viewer).
  router.get(
    '/:id/mesh/manifest',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(getMeshManifestController),
  );
  router.get(
    '/:id/mesh/geometry',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(getMeshGeometryController),
  );
  router.get(
    '/:id/mesh/edges',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(getMeshEdgesController),
  );

  // Download the whole session case as a .zip.
  router.get(
    '/:id/download',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(downloadSessionController),
  );

  return router;
}
