// HTTP controllers for the mesh quality rating ("Notation" tab). Thin adapters
// over meshQuality.service; routes run behind requireAuth and are
// project-visibility scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import { getMeshQuality, runMeshQuality } from './meshQuality.service';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** POST /projects/:id/mesh/quality — run checkMesh -allGeometry and grade the mesh. */
export async function runMeshQualityController(req: Request, res: Response): Promise<void> {
  const quality = await runMeshQuality(requireViewer(req), req.params.id);
  res.status(200).json({ quality });
}

/** GET /projects/:id/mesh/quality — the last persisted rating (or null). */
export async function getMeshQualityController(req: Request, res: Response): Promise<void> {
  const quality = await getMeshQuality(requireViewer(req), req.params.id);
  res.status(200).json({ quality });
}
