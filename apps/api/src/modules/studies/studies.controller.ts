// HTTP controllers of the optimisation studies (WS-H spec §7, nested under
// /projects/:id/studies by §0). Thin adapters over studies.service; the routes
// run behind requireAuth and are project-visibility scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from '../projects/projects.service';
import {
  createStudy,
  deleteStudy,
  exportStudyCsv,
  getEvaluation,
  getStudyDetail,
  getStudySetup,
  listStudies,
  startStudy,
  stopStudy,
  updateStudy,
} from './studies.service';
import type { CreateStudyInput, UpdateStudyInput } from './studies.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/studies */
export async function listStudiesController(req: Request, res: Response): Promise<void> {
  const studies = await listStudies(requireViewer(req), req.params.id);
  res.status(200).json({ studies });
}

/** GET /projects/:id/studies/setup */
export async function studySetupController(req: Request, res: Response): Promise<void> {
  res.status(200).json(await getStudySetup(requireViewer(req), req.params.id));
}

/** POST /projects/:id/studies (201, draft) */
export async function createStudyController(req: Request, res: Response): Promise<void> {
  const study = await createStudy(requireViewer(req), req.params.id, req.body as CreateStudyInput);
  res.status(201).json({ study });
}

/** GET /projects/:id/studies/:studyId */
export async function getStudyController(req: Request, res: Response): Promise<void> {
  res.status(200).json(await getStudyDetail(requireViewer(req), req.params.id, req.params.studyId));
}

/** PATCH /projects/:id/studies/:studyId (draft only) */
export async function updateStudyController(req: Request, res: Response): Promise<void> {
  const study = await updateStudy(
    requireViewer(req),
    req.params.id,
    req.params.studyId,
    req.body as UpdateStudyInput,
  );
  res.status(200).json({ study });
}

/** POST /projects/:id/studies/:studyId/start (202) */
export async function startStudyController(req: Request, res: Response): Promise<void> {
  const study = await startStudy(requireViewer(req), req.params.id, req.params.studyId, 'start');
  res.status(202).json({ study });
}

/** POST /projects/:id/studies/:studyId/resume (202) */
export async function resumeStudyController(req: Request, res: Response): Promise<void> {
  const study = await startStudy(requireViewer(req), req.params.id, req.params.studyId, 'resume');
  res.status(202).json({ study });
}

/** POST /projects/:id/studies/:studyId/stop (200, pause, idempotent) */
export async function stopStudyController(req: Request, res: Response): Promise<void> {
  const study = await stopStudy(requireViewer(req), req.params.id, req.params.studyId);
  res.status(200).json({ study });
}

/** DELETE /projects/:id/studies/:studyId (204) */
export async function deleteStudyController(req: Request, res: Response): Promise<void> {
  await deleteStudy(requireViewer(req), req.params.id, req.params.studyId);
  res.status(204).end();
}

/** GET /projects/:id/studies/:studyId/evaluations/:index */
export async function getEvaluationController(req: Request, res: Response): Promise<void> {
  const index = (req.validated?.params as { index?: number } | undefined)?.index ?? Number(req.params.index);
  res
    .status(200)
    .json(await getEvaluation(requireViewer(req), req.params.id, req.params.studyId, index));
}

/** GET /projects/:id/studies/:studyId/export.csv */
export async function exportStudyCsvController(req: Request, res: Response): Promise<void> {
  const { filename, csv } = await exportStudyCsv(requireViewer(req), req.params.id, req.params.studyId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(csv);
}
