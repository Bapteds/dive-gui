// Audit-log router, mounted at /api/v1/audit-logs.
// Read-only and restricted to authenticated super-admins.
import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { validate } from '../../middleware/validate';
import { listAuditLogsController } from './audit.controller';
import { listAuditLogsQuerySchema } from './audit.schemas';

/** Build the audit-log router (super-admin only, read-only). */
export function createAuditRouter(): Router {
  const router = Router();

  router.use(asyncHandler(requireAuth));
  router.use(requireRole('SUPER_ADMIN'));

  router.get(
    '/',
    validate({ query: listAuditLogsQuerySchema }),
    asyncHandler(listAuditLogsController),
  );

  return router;
}
