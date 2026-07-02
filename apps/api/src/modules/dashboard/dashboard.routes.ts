// Dashboard router, mounted at /api/v1/dashboard. Authenticated users only; the
// payload is visibility-scoped to the caller in the service.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { getDashboardController } from './dashboard.controller';

/** Build the dashboard router. */
export function createDashboardRouter(): Router {
  const router = Router();
  router.use(asyncHandler(requireAuth));
  router.get('/', asyncHandler(getDashboardController));
  return router;
}
