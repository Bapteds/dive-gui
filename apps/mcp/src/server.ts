// DIVE Turbinen MCP server.
// Exposes the app's REST API (/api/v1) as MCP tools so Claude can drive the same
// operations the React front performs: browse projects, read/write case files,
// run and monitor solvers, convert/merge meshes, apply boundary conditions and
// export to CFD-Post. Auth is a service account (see apps/mcp/.env), handled by
// DiveClient (login + auto re-login on 401).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ApiError, DiveClient } from './client.js';

const config = loadConfig();
const client = new DiveClient(config);

const server = new McpServer({ name: 'dive-mcp', version: '0.1.0' });

/** Wrap a value as an MCP text-content result (pretty JSON). */
function ok(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: text || '(empty response)' }] };
}

/** Wrap an error as an MCP error result with a readable message. */
function fail(err: unknown) {
  const message =
    err instanceof ApiError
      ? `API error ${err.status} [${err.code}]: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Register a tool whose handler returns any JSON-serialisable value. */
function tool<S extends z.ZodRawShape>(
  name: string,
  meta: { title: string; description: string; inputSchema?: S; destructive?: boolean },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  // registerTool's generics don't compose cleanly through this thin wrapper
  // (the callback return-type overload resolves poorly against a generic shape);
  // args stay typed via `handler`, so cast only the registration call itself.
  const register = server.registerTool.bind(server) as (
    n: string,
    m: unknown,
    cb: (args: z.infer<z.ZodObject<S>>) => Promise<ReturnType<typeof ok>>,
  ) => void;
  register(
    name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: (meta.inputSchema ?? ({} as S)),
      annotations: {
        readOnlyHint: /^(list|get|read|verify)_/.test(name),
        destructiveHint: meta.destructive ?? false,
      },
    },
    async (args) => {
      try {
        return ok(await handler(args));
      } catch (err) {
        return fail(err);
      }
    },
  );
}

// Common param shapes.
const projectId = { projectId: z.string().describe('Project id.') };
const runParams = {
  projectId: z.string().describe('Project id.'),
  runId: z.string().describe('Solver run id.'),
};

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

tool('list_projects', {
  title: 'List projects',
  description: 'List the projects visible to the service account (newest first).',
}, async () => client.get('/projects'));

tool('get_project', {
  title: 'Get project',
  description: 'Fetch a single project by id (metadata, owner, collaborators).',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}`));

tool('get_dashboard', {
  title: 'Get dashboard',
  description: 'Fetch aggregate dashboard stats (projects, runs, activity).',
}, async () => client.get('/dashboard'));

tool('list_case_files', {
  title: 'List case files',
  description: 'List the OpenFOAM case file tree for a project (empty until a case is imported).',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/files`));

tool('read_case_file', {
  title: 'Read a case file',
  description: 'Read the text content of a single case file (e.g. system/controlDict, 0/U).',
  inputSchema: {
    ...projectId,
    path: z.string().describe('Case-relative file path, e.g. "system/controlDict".'),
  },
}, async ({ projectId, path }) =>
  client.get(`/projects/${projectId}/files/content`, { path }));

tool('verify_case', {
  title: 'Verify case',
  description: 'Report which mandatory OpenFOAM files the case has / is missing.',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/files/verify`));

tool('get_runnable', {
  title: 'Check runnability',
  description: 'Report whether the case can run the solver (drives the Solver tab gate).',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/runnable`));

tool('list_runs', {
  title: 'List solver runs',
  description: 'List a project\'s solver runs (newest first) with their status.',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/runs`));

tool('get_run', {
  title: 'Get solver run',
  description: 'Fetch a single solver run (status, timings, exit info).',
  inputSchema: runParams,
}, async ({ projectId, runId }) => client.get(`/projects/${projectId}/runs/${runId}`));

tool('get_run_log', {
  title: 'Get run log + residuals',
  description:
    'Fetch a run\'s catch-up payload: the run record, the residual series (for convergence monitoring) and the log tail.',
  inputSchema: runParams,
}, async ({ projectId, runId }) => client.get(`/projects/${projectId}/runs/${runId}/log`));

tool('list_meshes', {
  title: 'List mesh sources',
  description: 'List the project\'s imported polyMesh library sources with their boundary patches.',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/meshes`));

tool('get_mesh_manifest', {
  title: 'Get mesh manifest',
  description:
    'Fetch the case mesh\'s patch manifest (builds the 3D render on demand; first call may be slow).',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/mesh/manifest`));

tool('list_cgns', {
  title: 'List CGNS sources',
  description: 'List the project\'s uploaded CGNS mesh source files.',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/cgns`));

tool('get_export_status', {
  title: 'Get export status',
  description: 'Fetch the last OpenFOAM→CGNS export\'s profile / validation / artifacts (or null).',
  inputSchema: projectId,
}, async ({ projectId }) => client.get(`/projects/${projectId}/export`));

tool('list_templates', {
  title: 'List templates',
  description: 'List the shared case templates available to apply to a project.',
}, async () => client.get('/templates'));

tool('list_users', {
  title: 'List users (admin)',
  description: 'List all users. Requires the service account to have the SUPER_ADMIN role.',
}, async () => client.get('/users'));

// ---------------------------------------------------------------------------
// Action / write tools
// ---------------------------------------------------------------------------

tool('create_project', {
  title: 'Create project',
  description: 'Create a new project owned by the service account.',
  inputSchema: { title: z.string().min(1).describe('Project title.') },
}, async ({ title }) => client.post('/projects', { title }));

tool('delete_project', {
  title: 'Delete project',
  description: 'Delete a project and its case files. Irreversible.',
  inputSchema: projectId,
  destructive: true,
}, async ({ projectId }) => {
  await client.delete(`/projects/${projectId}`);
  return { deleted: projectId };
});

tool('write_case_file', {
  title: 'Write case file',
  description: 'Save text content to an existing case file (overwrites it).',
  inputSchema: {
    ...projectId,
    path: z.string().describe('Case-relative file path.'),
    content: z.string().describe('New full file content.'),
  },
  destructive: true,
}, async ({ projectId, path, content }) => {
  await client.putText(`/projects/${projectId}/files/content`, content, { path });
  return { saved: path };
});

tool('create_case_file', {
  title: 'Create case file',
  description: 'Create a new empty case file at the given path. Returns the refreshed tree.',
  inputSchema: {
    ...projectId,
    path: z.string().describe('Case-relative file path to create.'),
  },
}, async ({ projectId, path }) => client.post(`/projects/${projectId}/files/content`, { path }));

tool('delete_case_file', {
  title: 'Delete case file',
  description: 'Delete a single case file. Returns the refreshed tree.',
  inputSchema: {
    ...projectId,
    path: z.string().describe('Case-relative file path to delete.'),
  },
  destructive: true,
}, async ({ projectId, path }) =>
  client.delete(`/projects/${projectId}/files/content`, { path }));

tool('import_case_zip', {
  title: 'Import case (.zip)',
  description:
    'Import a .zip archive of an OpenFOAM case (or a polyMesh folder) from a local file path into the project.',
  inputSchema: {
    ...projectId,
    filePath: z.string().describe('Absolute path to a .zip archive on the machine running the MCP server.'),
  },
}, async ({ projectId, filePath }) =>
  client.postForm(`/projects/${projectId}/files/import`, {}, [{ field: 'archive', path: filePath }]));

tool('scaffold_case', {
  title: 'Scaffold base case files',
  description: 'Generate the missing mandatory OpenFOAM base files for the case.',
  inputSchema: projectId,
}, async ({ projectId }) => client.post(`/projects/${projectId}/files/scaffold`));

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
  return client.post(`/projects/${projectId}/runnable/scaffold`, body);
});

tool('sync_boundaries', {
  title: 'Sync boundaries',
  description: 'Apply the mesh boundary (patch names + types) to every 0/ field\'s boundaryField.',
  inputSchema: projectId,
}, async ({ projectId }) => client.post(`/projects/${projectId}/files/sync-boundaries`));

tool('start_run', {
  title: 'Start solver run',
  description:
    'Start a solver run in the case directory (spawns the solver, streams output to a persisted log). cores>1 runs in parallel (decomposePar + mpirun).',
  inputSchema: {
    ...projectId,
    solver: z.string().optional().describe('Solver id, e.g. "simpleFoam". Omit for the default.'),
    cores: z.number().int().positive().optional().describe('Parallel core count (>1 for MPI). Omit / 1 = serial.'),
  },
  destructive: true,
}, async ({ projectId, solver, cores }) => {
  const body: Record<string, unknown> = {};
  if (solver) body.solver = solver;
  if (cores && cores > 1) body.cores = cores;
  return client.post(`/projects/${projectId}/runs`, body);
});

tool('stop_run', {
  title: 'Stop solver run',
  description: 'Stop a running solver (graceful, with a SIGTERM fallback).',
  inputSchema: runParams,
  destructive: true,
}, async ({ projectId, runId }) => client.post(`/projects/${projectId}/runs/${runId}/stop`));

tool('convert_cgns', {
  title: 'Convert CGNS → Foam',
  description:
    'Run the CGNS→OpenFOAM conversion pipeline using an uploaded CGNS file and a template. Returns the per-step report (may report success:false with logs).',
  inputSchema: {
    ...projectId,
    cgnsFile: z.string().describe('Name of an already-uploaded CGNS source file (see list_cgns).'),
    templateId: z.string().describe('Template id to convert with.'),
  },
}, async ({ projectId, cgnsFile, templateId }) =>
  client.post(`/projects/${projectId}/cgns/convert`, { cgnsFile, templateId }));

tool('merge_meshes', {
  title: 'Merge meshes',
  description:
    'Run the multi-mesh merge pipeline with a MergePlan. Pass the plan as a JSON object (order, transforms, couples/patchPairs). Returns the per-step report.',
  inputSchema: {
    ...projectId,
    plan: z.record(z.string(), z.unknown()).describe('MergePlan object (same shape the web "Merge meshes" dialog sends).'),
  },
  destructive: true,
}, async ({ projectId, plan }) => client.post(`/projects/${projectId}/meshes/merge`, plan));

tool('auto_patch_mesh', {
  title: 'Auto-patch mesh',
  description:
    'Run autoPatch <featureAngle> -overwrite on the project mesh: split external boundary faces into patches by feature angle. Returns the report.',
  inputSchema: {
    ...projectId,
    featureAngle: z.number().describe('Feature angle in degrees (e.g. 45).'),
  },
  destructive: true,
}, async ({ projectId, featureAngle }) =>
  client.post(`/projects/${projectId}/mesh/auto-patch`, { featureAngle }));

tool('apply_boundary_conditions', {
  title: 'Apply boundary conditions',
  description:
    'Apply a component BC preset (Turbine / Pipe / DraftTube / Chamber + driving mode) to the case 0/ fields. Backs up the case first. Optionally attach a CSV (draft-tube inlet profile) from a local file path.',
  inputSchema: {
    ...projectId,
    payload: z.record(z.string(), z.unknown()).describe('ApplyBoundaryConditionsRequest object (same shape the web overlay sends).'),
    csvPath: z.string().optional().describe('Optional absolute path to a CSV file (draft-tube runner-exit profile).'),
  },
  destructive: true,
}, async ({ projectId, payload, csvPath }) =>
  client.postForm(
    `/projects/${projectId}/boundary-conditions/apply`,
    { payload: JSON.stringify(payload) },
    csvPath ? [{ field: 'csv', path: csvPath }] : [],
  ));

tool('run_export', {
  title: 'Run CFD-Post export',
  description:
    'Run the full OpenFOAM→CGNS export pipeline (inspect → convert → validate → cfdpost). Returns the per-step report with logs and produced artifacts.',
  inputSchema: projectId,
  destructive: true,
}, async ({ projectId }) => client.post(`/projects/${projectId}/export`));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe: stdout is the MCP transport channel.
  console.error(`[dive-mcp] connected — API base ${client.baseUrl}`);
}

main().catch((err) => {
  console.error('[dive-mcp] fatal:', err);
  process.exit(1);
});
