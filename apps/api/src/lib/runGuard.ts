// Active-run guard for destructive case mutations (M1).
//
// A project's OpenFOAM case (constant/polyMesh + 0/ fields + system/) is a SHARED
// resource: while a solver run is active it is reading — and, in parallel, its
// processor* dirs are writing into — that exact directory. Any user action that
// rewrites or deletes the mesh or case files mid-run (reset, merge/promote, backup
// restore, autoPatch, patch edits, CGNS convert, boundary-conditions apply, file
// move/delete/save, scaffold, template apply) kills the run with a cryptic FOAM
// fatal or, worse, lets a later reconstructPar stitch processor dirs onto a NEW
// mesh (a corrupt case). Callers assert this BEFORE mutating so the user gets a
// clear "stop the run first" instead.
//
// Standalone (prisma + shared only) so every mutation service can import it without
// a circular dependency on runs.service (which itself imports from files.service).
import { ACTIVE_RUN_STATUSES } from '@dive/shared';
import { AppError } from './AppError';
import { prisma } from './prisma';

/**
 * Throw 409 RUN_IN_PROGRESS when the project has a queued/running solver run, so a
 * destructive case mutation cannot corrupt the case a live solver is using. A no-op
 * when nothing is active.
 *
 * @throws 409 RUN_IN_PROGRESS if a run is active for the project.
 */
export async function assertNoActiveRun(projectId: string): Promise<void> {
  const active = await prisma.run.count({
    where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  });
  if (active > 0) {
    throw new AppError(
      409,
      'RUN_IN_PROGRESS',
      'A solver run is active for this project. Stop it before changing the mesh or case files.',
    );
  }
}
