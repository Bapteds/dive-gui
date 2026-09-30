// HTTP controllers of the Free surface tool (WS-I spec §6) and the project lock
// middleware that keeps manual runs and case / mesh mutations out while a job
// runs. Thin adapters over freeSurface.service; routes run behind requireAuth and
// are project-visibility scoped in the service.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  deleteFreeSurfaceJob,
  getFreeSurfaceJob,
  getFreeSurfaceOverview,
  isFreeSurfaceActive,
  readFreeSurfaceFile,
  startFreeSurfaceJob,
  stopFreeSurfaceJob,
} from './freeSurface.service';
import type { FreeSurfaceSelectionQuery, FreeSurfaceStartInput } from './freeSurface.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/**
 * Project lock (spec §5): answer 409 FREE_SURFACE_IN_PROGRESS while a
 * free-surface job runs for `:id`. `when` narrows it (e.g. case target only).
 * The job's own calls go to the services directly, never through these routes.
 */
export function freeSurfaceLock(when?: (req: Request) => boolean): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (isFreeSurfaceActive(req.params.id) && (!when || when(req))) {
      next(
        new AppError(
          409,
          'FREE_SURFACE_IN_PROGRESS',
          'A free-surface job is running for this project. Wait for it to finish or stop it.',
        ),
      );
      return;
    }
    next();
  };
}

/** GET /projects/:id/free-surface — checks, defaults, mesh origin, jobs. */
export async function getFreeSurfaceController(req: Request, res: Response): Promise<void> {
  const selection = (req.validated?.query ?? {}) as FreeSurfaceSelectionQuery;
  const overview = await getFreeSurfaceOverview(requireViewer(req), req.params.id, selection);
  res.status(200).json(overview);
}

/** POST /projects/:id/free-surface — start a job (202). */
export async function startFreeSurfaceController(req: Request, res: Response): Promise<void> {
  const job = await startFreeSurfaceJob(
    requireViewer(req),
    req.params.id,
    req.body as FreeSurfaceStartInput,
  );
  res.status(202).json({ job });
}

/** GET /projects/:id/free-surface/:jobId — one job. */
export async function getFreeSurfaceJobController(req: Request, res: Response): Promise<void> {
  const job = await getFreeSurfaceJob(requireViewer(req), req.params.id, req.params.jobId);
  res.status(200).json({ job });
}

/** POST /projects/:id/free-surface/:jobId/stop — stop (idempotent). */
export async function stopFreeSurfaceJobController(req: Request, res: Response): Promise<void> {
  const job = await stopFreeSurfaceJob(requireViewer(req), req.params.id, req.params.jobId);
  res.status(200).json({ job });
}

/** DELETE /projects/:id/free-surface/:jobId — delete a finished job (204). */
export async function deleteFreeSurfaceJobController(req: Request, res: Response): Promise<void> {
  await deleteFreeSurfaceJob(requireViewer(req), req.params.id, req.params.jobId);
  res.status(204).end();
}

/** GET /projects/:id/free-surface/:jobId/files/:name — download an allow-listed file. */
export async function downloadFreeSurfaceFileController(
  req: Request,
  res: Response,
): Promise<void> {
  const { name } = req.params;
  const { bytes, contentType } = await readFreeSurfaceFile(
    requireViewer(req),
    req.params.id,
    req.params.jobId,
    name,
  );
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(bytes);
}
