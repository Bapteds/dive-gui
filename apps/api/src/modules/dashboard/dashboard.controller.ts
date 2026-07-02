// HTTP controller for the dashboard aggregate. Thin adapter over dashboard.service;
// runs behind requireAuth and is visibility-scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from '../projects/projects.service';
import { getDashboard } from './dashboard.service';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /dashboard - live server metrics + the viewer's solver runs. */
export async function getDashboardController(req: Request, res: Response): Promise<void> {
  const data = await getDashboard(requireViewer(req));
  res.status(200).json(data);
}
