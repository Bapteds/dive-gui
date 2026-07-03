import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getRunLog,
  getRunnable,
  listRuns,
  scaffoldSolver,
  startRun,
  stopRun,
} from '@/lib/api/projects';
import type {
  RunLogPayload,
  RunStatus,
  RunSummary,
  RunnableCheck,
  ScaffoldSolverResponse,
  SolverId,
} from '@/lib/api/types';

/**
 * useRuns - React Query hooks for the "Solver" tab.
 *
 * A solver run is the app's first long-running background job. The server does
 * not push; instead the client POLLS while a run is active. Two queries poll:
 *  - the runs list (to know if any run is active, and to refresh history), and
 *  - the active run's log (the live residual series + log tail).
 * Both stop polling the moment the run reaches a terminal status, so an idle tab
 * makes no network noise. Reload-proof: every poll is a full authenticated GET.
 */

/** Poll cadence while a run is active. */
const POLL_MS = 1200;

/** Run statuses that are still executing (keep polling while one of these). */
const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'running'];

/** Is this run status still active (worth polling)? */
export function isRunActive(status: RunStatus | undefined): boolean {
  return status !== undefined && ACTIVE_STATUSES.includes(status);
}

export const runnableQueryKey = (projectId: string) =>
  ['projects', projectId, 'runnable'] as const;
export const runsQueryKey = (projectId: string) => ['projects', projectId, 'runs'] as const;
export const runLogQueryKey = (projectId: string, runId: string) =>
  ['projects', projectId, 'runs', runId, 'log'] as const;

/** Whether the case is runnable by simpleFoam (gates the run config / Run CTA). */
export function useRunnableQuery(projectId: string, enabled = true) {
  return useQuery<RunnableCheck>({
    queryKey: runnableQueryKey(projectId),
    queryFn: () => getRunnable(projectId),
    enabled,
    staleTime: 10_000,
  });
}

/** Variables for the "Make runnable" scaffold: a solver and/or a turbulence model. */
export interface ScaffoldSolverVars {
  solver?: SolverId;
  turbulence?: string;
}

/** Generate the files a case needs to be runnable by a chosen solver + turbulence model. */
export function useScaffoldSolver(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ScaffoldSolverResponse, Error, ScaffoldSolverVars | undefined>({
    mutationFn: (vars) => scaffoldSolver(projectId, vars?.solver, vars?.turbulence),
    onSuccess: (result) => {
      queryClient.setQueryData(runnableQueryKey(projectId), result.runnable);
      // New case files were written; keep the case tree / summary in sync.
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'files'] });
    },
  });
}

/**
 * List a project's runs (history + the current run). Polls while any run is
 * active so a freshly finished run flips to its terminal badge on its own.
 */
export function useRunsQuery(projectId: string, enabled = true) {
  return useQuery<RunSummary[]>({
    queryKey: runsQueryKey(projectId),
    queryFn: () => listRuns(projectId),
    enabled,
    refetchInterval: (query) => {
      const runs = query.state.data;
      return runs?.some((run) => isRunActive(run.status)) ? POLL_MS : false;
    },
  });
}

/** Start a solver run, then refresh the runs list (the new run becomes current). */
export function useStartRun(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<RunSummary, Error, { solver?: SolverId; cores?: number } | undefined>({
    mutationFn: (vars) => startRun(projectId, vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runsQueryKey(projectId) });
    },
  });
}

/** Stop a run, then refresh the runs list. */
export function useStopRun(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<RunSummary, Error, string>({
    mutationFn: (runId) => stopRun(projectId, runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runsQueryKey(projectId) });
    },
  });
}

/**
 * Poll the live log + residual series for a run. Polls only while the run is
 * active (the payload's own status drives the cadence), then stops. Disabled
 * when there is no current run.
 */
export function useRunLogQuery(projectId: string, runId: string | null) {
  return useQuery<RunLogPayload>({
    queryKey: runLogQueryKey(projectId, runId ?? 'none'),
    queryFn: () => getRunLog(projectId, runId as string),
    enabled: !!runId,
    refetchInterval: (query) => (isRunActive(query.state.data?.run.status) ? POLL_MS : false),
  });
}
