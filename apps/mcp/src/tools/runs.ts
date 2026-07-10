// Tools for making a case runnable (runnability gate, solver scaffolding,
// boundary sync + conditions), running/monitoring the solver, and exporting
// results to CFD-Post.
import { z } from 'zod';
import type { Api } from '../client.js';
import { type Registrar, saveDownload } from '../kit.js';
import { projectId, runParams } from './params.js';

export function registerRunTools(tool: Registrar, api: Api): void {
  const slow = { timeoutMs: api.slowTimeoutMs };

  // ---- Runnability + solver preparation ---------------------------------
  tool('get_runnable', {
    title: 'Check runnability',
    description: 'Report whether the case can run the solver (drives the Solver tab gate).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/runnable`));

  tool('scaffold_solver', {
    title: 'Scaffold solver files',
    description:
      'Generate the files a case needs to be runnable (turbulence/transport + 0/ fields) for a solver + turbulence model.',
    inputSchema: {
      ...projectId,
      solver: z.string().optional().describe('Solver id, e.g. "simpleFoam". Omit for the default.'),
      turbulence: z.string().optional().describe('Turbulence model, e.g. "kOmegaSST". Omit for the default.'),
    },
  }, async ({ projectId, solver, turbulence }) => {
    const body: Record<string, string> = {};
    if (solver) body.solver = solver;
    if (turbulence) body.turbulence = turbulence;
    return api.post(`/projects/${projectId}/runnable/scaffold`, body);
  });

  tool('sync_boundaries', {
    title: 'Sync boundaries',
    description:
      "Align every 0/ field's boundaryField to the mesh boundary (merge mode: existing patch BCs are kept, stale entries dropped, new patches get a per-type default).",
    inputSchema: projectId,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/files/sync-boundaries`));

  tool('apply_boundary_conditions', {
    title: 'Apply boundary conditions',
    description:
      'Apply a component BC preset (Turbine / Pipe / DraftTube / Chamber + driving mode) to the case 0/ fields. Backs up the case first. Optionally attach a CSV (draft-tube inlet profile) from a local file path.',
    inputSchema: {
      ...projectId,
      payload: z
        .record(z.string(), z.unknown())
        .describe('ApplyBoundaryConditionsRequest object (same shape the web overlay sends).'),
      csvPath: z
        .string()
        .optional()
        .describe('Optional absolute path to a CSV file (draft-tube runner-exit profile).'),
    },
    destructive: true,
  }, async ({ projectId, payload, csvPath }) =>
    api.postForm(
      `/projects/${projectId}/boundary-conditions/apply`,
      { payload: JSON.stringify(payload) },
      csvPath ? [{ field: 'csv', path: csvPath }] : [],
      undefined,
      slow,
    ));

  // ---- Solver runs ------------------------------------------------------
  tool('list_runs', {
    title: 'List solver runs',
    description: "List a project's solver runs (newest first) with their status.",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/runs`));

  tool('get_run', {
    title: 'Get solver run',
    description: 'Fetch a single solver run (status, timings, exit info).',
    inputSchema: runParams,
  }, async ({ projectId, runId }) => api.get(`/projects/${projectId}/runs/${runId}`));

  tool('get_run_log', {
    title: 'Get run log + residuals',
    description:
      "Fetch a run's catch-up payload: the run record, the residual series (for convergence monitoring) and the log tail.",
    inputSchema: runParams,
  }, async ({ projectId, runId }) => api.get(`/projects/${projectId}/runs/${runId}/log`));

  tool('start_run', {
    title: 'Start solver run',
    description:
      'Start a solver run in the case directory (spawns the solver, streams output to a persisted log). cores>1 runs in parallel (decomposePar + mpirun).',
    inputSchema: {
      ...projectId,
      solver: z.string().optional().describe('Solver id, e.g. "simpleFoam". Omit for the default.'),
      cores: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Parallel core count (>1 for MPI). Omit / 1 = serial.'),
    },
    destructive: true,
  }, async ({ projectId, solver, cores }) => {
    const body: Record<string, unknown> = {};
    if (solver) body.solver = solver;
    if (cores && cores > 1) body.cores = cores;
    return api.post(`/projects/${projectId}/runs`, body);
  });

  tool('stop_run', {
    title: 'Stop solver run',
    description: 'Stop a running solver (graceful, with a SIGTERM fallback).',
    inputSchema: runParams,
    destructive: true,
  }, async ({ projectId, runId }) => api.post(`/projects/${projectId}/runs/${runId}/stop`));

  // ---- Export to CFD-Post -----------------------------------------------
  tool('get_export_status', {
    title: 'Get export status',
    description: "Fetch the last OpenFOAM→CGNS export's profile / validation / artifacts (or null).",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/export`));

  tool('run_export', {
    title: 'Run CFD-Post export',
    description:
      'Run the full OpenFOAM→CGNS export pipeline (inspect → convert → validate → cfdpost). Returns the per-step report with logs and produced artifacts.',
    inputSchema: projectId,
    destructive: true,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/export`, undefined, undefined, slow));

  tool('download_export_artifact', {
    title: 'Download export artifact',
    description:
      'Download a produced export artifact and save it to a local path. `artifact` is one of: cgns (out.cgns), session, memo, report.',
    inputSchema: {
      ...projectId,
      artifact: z.enum(['cgns', 'session', 'memo', 'report']).describe('Which artifact to download.'),
      savePath: z.string().min(1).describe('Local file path to write the artifact to.'),
    },
  }, async ({ projectId, artifact, savePath }) =>
    saveDownload(
      savePath,
      await api.getBytes(`/projects/${projectId}/export/download/${artifact}`, undefined, slow),
    ));
}
