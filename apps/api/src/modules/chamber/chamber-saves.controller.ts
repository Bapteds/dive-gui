// HTTP controllers for saved chamber builds. Thin adapters over
// chamber-saves.service; all routes run behind requireAuth. Reads are open to
// any authenticated user; mutations are guarded by ownership inside the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from '../projects/projects.service';
import {
  createChamberSave,
  deleteChamberSave,
  listChamberSaves,
  updateChamberSave,
} from './chamber-saves.service';
import type { ChamberSaveCreateInput, ChamberSaveUpdateInput } from './chamber-saves.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /chamber/saves — list every (shared) save, newest-updated first. */
export async function listChamberSavesController(_req: Request, res: Response): Promise<void> {
  const saves = await listChamberSaves();
  res.status(200).json({ saves });
}

/** POST /chamber/saves — create a named snapshot owned by the viewer. */
export async function createChamberSaveController(req: Request, res: Response): Promise<void> {
  const viewer = requireViewer(req);
  const save = await createChamberSave(viewer, req.body as ChamberSaveCreateInput);
  res.status(201).json({ save });
}

/** PUT /chamber/saves/:id — overwrite the snapshot and/or rename. */
export async function updateChamberSaveController(req: Request, res: Response): Promise<void> {
  const viewer = requireViewer(req);
  const save = await updateChamberSave(viewer, req.params.id, req.body as ChamberSaveUpdateInput);
  res.status(200).json({ save });
}

/** DELETE /chamber/saves/:id — remove a save. */
export async function deleteChamberSaveController(req: Request, res: Response): Promise<void> {
  const viewer = requireViewer(req);
  await deleteChamberSave(viewer, req.params.id);
  res.status(204).send();
}
