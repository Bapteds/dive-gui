// Audit-log HTTP controller. Thin adapter over the audit read service. Runs
// behind requireAuth + requireRole('SUPER_ADMIN') at the router level.
import type { Request, Response } from 'express';
import { listAuditLogs } from './audit.service';
import { AUDIT_DEFAULT_LIMIT, type ListAuditLogsQuery } from './audit.schemas';

/** GET /audit-logs — list recent audit entries (newest first). */
export async function listAuditLogsController(req: Request, res: Response): Promise<void> {
  // The validate middleware coerces + defaults the query; fall back defensively.
  const query = req.validated?.query as ListAuditLogsQuery | undefined;
  const limit = query?.limit ?? AUDIT_DEFAULT_LIMIT;
  const logs = await listAuditLogs(limit);
  res.status(200).json({ logs });
}
