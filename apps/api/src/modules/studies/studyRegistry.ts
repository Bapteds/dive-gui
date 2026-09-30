// In-process registry of the running optimisation study (WS-H spec §6): one
// study at a time globally, and the project lock it holds. Kept free of service
// imports so the project routes and the free-surface service can read it without
// an import cycle. Single API instance (K31): lost on restart, then the boot
// reconciliation pauses the study.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from '../projects/projects.service';

/** The live runner of a study. */
export interface ActiveStudy {
  studyId: string;
  projectId: string;
  /** The viewer the stages act as (the one who started / resumed). */
  viewer: Viewer;
  /** Set by stop (pause) or delete: the runner interrupts the current stage. */
  abort: boolean;
  /** The meshing session / solver run of the current stage (for Stop). */
  sessionId: string | null;
  runId: string | null;
  /** Settles when the runner has finished (used by delete to wait for the stop). */
  done: Promise<void>;
}

let active: ActiveStudy | null = null;

/** The running study, or null. */
export function getActiveStudy(): ActiveStudy | null {
  return active;
}

/** Claim the global slot (the caller checked it was free). */
export function setActiveStudy(entry: ActiveStudy): void {
  active = entry;
}

/** Release the slot if it still belongs to `entry`. */
export function clearActiveStudy(entry: ActiveStudy): void {
  if (active === entry) active = null;
}

/** Is a study running on this project (the project lock)? */
export function isStudyActiveForProject(projectId: string): boolean {
  return active !== null && active.projectId === projectId;
}

/** The 409 of the project lock. */
export function studyInProgressError(): AppError {
  return new AppError(
    409,
    'STUDY_IN_PROGRESS',
    'An optimisation study is running on this project. Pause it from the Optimisation tab first.',
  );
}

/**
 * Project lock middleware (spec §0 A7): 409 STUDY_IN_PROGRESS while a study runs
 * on `:id`. `when` narrows it (e.g. case target only). The study's own calls go
 * to the services directly, never through these routes.
 */
export function studyLock(when?: (req: Request) => boolean): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (isStudyActiveForProject(req.params.id) && (!when || when(req))) {
      next(studyInProgressError());
      return;
    }
    next();
  };
}
