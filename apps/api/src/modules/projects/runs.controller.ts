// HTTP controllers for solver runs. Thin adapters over runs.service; all routes
// run behind requireAuth and are project-visibility scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import { getRun, getRunLog, listRuns, startRun, stopRun } from './runs.service';
import type { StartRunInput } from './runs.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** POST /projects/:id/runs — start a solver run. */
export async function startRunController(req: Request, res: Response): Promise<void> {
  const run = await startRun(requireViewer(req), req.params.id, req.body as StartRunInput);
  res.status(201).json({ run });
}

/** GET /projects/:id/runs — list the project's runs (newest first). */
export async function listRunsController(req: Request, res: Response): Promise<void> {
  const runs = await listRuns(requireViewer(req), req.params.id);
  res.status(200).json({ runs });
}

/** GET /projects/:id/runs/:runId — fetch a single run. */
export async function getRunController(req: Request, res: Response): Promise<void> {
  const run = await getRun(requireViewer(req), req.params.id, req.params.runId);
  res.status(200).json({ run });
}

/** GET /projects/:id/runs/:runId/log — catch-up log (run + residual series + tail). */
export async function getRunLogController(req: Request, res: Response): Promise<void> {
  const payload = await getRunLog(requireViewer(req), req.params.id, req.params.runId);
  res.status(200).json(payload);
}

/** POST /projects/:id/runs/:runId/stop — stop a run (graceful, SIGTERM fallback). */
export async function stopRunController(req: Request, res: Response): Promise<void> {
  const run = await stopRun(requireViewer(req), req.params.id, req.params.runId);
  res.status(200).json({ run });
}
