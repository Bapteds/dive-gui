// HTTP controllers for the per-project convergence criteria + vortex metrics
// (WS-G). Thin adapters over criteria.service; visibility is checked there.
import type { Request, Response } from 'express';
import type { CfdCriteriaSettings } from '@dive/shared';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import { computeVortexOnDemand, getCriteria, saveCriteria } from './criteria.service';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/criteria - settings (or defaults), mesh patches, applicability. */
export async function getCriteriaController(req: Request, res: Response): Promise<void> {
  const payload = await getCriteria(requireViewer(req), req.params.id);
  res.status(200).json(payload);
}

/** PUT /projects/:id/criteria - save and install the settings. */
export async function saveCriteriaController(req: Request, res: Response): Promise<void> {
  const payload = await saveCriteria(
    requireViewer(req),
    req.params.id,
    req.body as CfdCriteriaSettings,
  );
  res.status(200).json(payload);
}

/** POST /projects/:id/criteria/vortex - vortex metrics at the latest time. */
export async function computeVortexController(req: Request, res: Response): Promise<void> {
  const vortex = await computeVortexOnDemand(requireViewer(req), req.params.id);
  res.status(200).json({ vortex });
}
