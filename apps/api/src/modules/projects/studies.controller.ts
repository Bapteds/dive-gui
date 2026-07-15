// HTTP controllers for diameter-optimization studies. Thin adapters over
// studies.service; all routes run behind requireAuth and are project-visibility
// scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  createStudy,
  deleteStudy,
  extractStudyCenterline,
  getStudy,
  listStudies,
  updateStudy,
} from './studies.service';
import type { CenterlineInput, CreateStudyInput, UpdateStudyInput } from './studies.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/studies — list the project's studies (newest first). */
export async function listStudiesController(req: Request, res: Response): Promise<void> {
  const studies = await listStudies(requireViewer(req), req.params.id);
  res.status(200).json({ studies });
}

/** POST /projects/:id/studies — create a draft study. */
export async function createStudyController(req: Request, res: Response): Promise<void> {
  const study = await createStudy(requireViewer(req), req.params.id, req.body as CreateStudyInput);
  res.status(201).json({ study });
}

/** GET /projects/:id/studies/:studyId — fetch a single study. */
export async function getStudyController(req: Request, res: Response): Promise<void> {
  const study = await getStudy(requireViewer(req), req.params.id, req.params.studyId);
  res.status(200).json({ study });
}

/** PUT /projects/:id/studies/:studyId — edit a draft study. */
export async function updateStudyController(req: Request, res: Response): Promise<void> {
  const study = await updateStudy(
    requireViewer(req),
    req.params.id,
    req.params.studyId,
    req.body as UpdateStudyInput,
  );
  res.status(200).json({ study });
}

/** DELETE /projects/:id/studies/:studyId — delete a study. */
export async function deleteStudyController(req: Request, res: Response): Promise<void> {
  await deleteStudy(requireViewer(req), req.params.id, req.params.studyId);
  res.status(204).end();
}

/** POST /projects/:id/studies/centerline — trace the pipe centerline (study prep). */
export async function extractCenterlineController(req: Request, res: Response): Promise<void> {
  const result = await extractStudyCenterline(
    requireViewer(req),
    req.params.id,
    req.body as CenterlineInput,
  );
  res.status(200).json(result);
}
