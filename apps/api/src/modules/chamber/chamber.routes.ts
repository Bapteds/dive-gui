// Chamber Creation router, mounted at /api/v1/chamber. Every route requires an
// authenticated user; builds are shared across the team (keyed by a param hash,
// not per-user), mirroring the standalone Meshing feature.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { validate } from '../../middleware/validate';
import {
  buildChamberController,
  getChamberEdgesController,
  getChamberExportController,
  getChamberGeometryController,
  getChamberManifestController,
} from './chamber.controller';
import {
  chamberBuildSchema,
  chamberExportParamSchema,
  chamberHashParamSchema,
} from './chamber.schemas';

/** Build the chamber router (authenticated). */
export function createChamberRouter(): Router {
  const router = Router();

  router.use(asyncHandler(requireAuth));

  // Compute the 12 outputs + build the geometry (idempotent, hash-cached).
  router.post('/build', validate({ body: chamberBuildSchema }), asyncHandler(buildChamberController));

  // One build's render + manifest + edges (by param hash).
  router.get(
    '/:hash/manifest',
    validate({ params: chamberHashParamSchema }),
    asyncHandler(getChamberManifestController),
  );
  router.get(
    '/:hash/geometry',
    validate({ params: chamberHashParamSchema }),
    asyncHandler(getChamberGeometryController),
  );
  router.get(
    '/:hash/edges',
    validate({ params: chamberHashParamSchema }),
    asyncHandler(getChamberEdgesController),
  );

  // Download an export artifact (STL / STEP / OpenFOAM triSurface zip).
  router.get(
    '/:hash/export/:kind',
    validate({ params: chamberExportParamSchema }),
    asyncHandler(getChamberExportController),
  );

  return router;
}
