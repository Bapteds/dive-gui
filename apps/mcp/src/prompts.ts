// MCP prompts: reusable, parameterised workflows that steer Claude through the
// common multi-step CFD tasks using the tools this server exposes. Each returns
// a single user message with the ids already substituted in.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Api } from './client.js';

/** Build a one-message prompt result from a text body. */
function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer, _api: Api): void {
  server.registerPrompt(
    'diagnose_run',
    {
      title: 'Diagnose a solver run',
      description: 'Investigate why a solver run failed or is not converging, and propose fixes.',
      argsSchema: {
        projectId: z.string().describe('Project id.'),
        runId: z.string().describe('Solver run id.'),
      },
    },
    ({ projectId, runId }) =>
      userText(
        [
          `Diagnose solver run ${runId} in project ${projectId}.`,
          '',
          'Steps:',
          `1. Call get_run { projectId: "${projectId}", runId: "${runId}" } for status, timing and exit info.`,
          `2. Call get_run_log { projectId: "${projectId}", runId: "${runId}" } for the residual series and the log tail.`,
          '3. Judge convergence from the residual trend (falling and levelling = healthy; rising/oscillating/NaN = diverging).',
          '4. Read the log tail for the failure signature (floating point exception, bounding, courant number, missing field/BC, mesh error).',
          '5. If it points at the setup, inspect the relevant case files (read_case_file: system/controlDict, system/fvSolution, system/fvSchemes, 0/ fields).',
          '',
          'Report: a one-line verdict, the evidence, the likely cause, and concrete next actions (e.g. relax under-relaxation, fix a BC, refine the mesh). Do not change any files unless asked.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'prepare_runnable_case',
    {
      title: 'Prepare a runnable case',
      description: 'Take a project from an imported mesh to a solver-runnable case.',
      argsSchema: {
        projectId: z.string().describe('Project id.'),
        solver: z.string().optional().describe('Target solver (e.g. simpleFoam). Optional.'),
      },
    },
    ({ projectId, solver }) =>
      userText(
        [
          `Make project ${projectId} runnable${solver ? ` with the ${solver} solver` : ''}.`,
          '',
          'Steps:',
          `1. Call verify_case { projectId: "${projectId}" } to see which mandatory files are missing.`,
          `2. If base files are missing, call scaffold_case.`,
          `3. Call scaffold_solver { projectId: "${projectId}"${solver ? `, solver: "${solver}"` : ''} } to generate turbulence/transport + 0/ fields.`,
          `4. Call sync_boundaries so every 0/ field's boundaryField matches the mesh patches.`,
          `5. Call get_runnable and resolve anything it still reports as blocking.`,
          '',
          'Explain each gap you close. Stop once get_runnable reports the case can run; do not start a run unless asked.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'convert_cgns_workflow',
    {
      title: 'Convert a CGNS mesh to an OpenFOAM case',
      description: 'Upload (if needed) and convert a CGNS mesh into the project case.',
      argsSchema: {
        projectId: z.string().describe('Project id.'),
        cgnsPath: z.string().optional().describe('Local .cgns path to upload first. Optional.'),
      },
    },
    ({ projectId, cgnsPath }) =>
      userText(
        [
          `Convert a CGNS mesh into the OpenFOAM case for project ${projectId}.`,
          '',
          'Steps:',
          cgnsPath
            ? `1. Call upload_cgns { projectId: "${projectId}", filePath: "${cgnsPath}" }.`
            : `1. Call list_cgns { projectId: "${projectId}" } and pick the source to convert (upload_cgns first if none exist).`,
          `2. Call list_templates and choose a template that matches the intended physics.`,
          `3. Call convert_cgns { projectId: "${projectId}", cgnsFile: "<name>", templateId: "<id>" } and read the per-step report (it can report success:false with logs).`,
          `4. Call verify_case and get_mesh_manifest to confirm the mesh imported and the boundary patches look right.`,
          '',
          'If the conversion fails, surface the failing step and its log rather than retrying blindly.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'set_up_assembly',
    {
      title: 'Set up a multi-mesh assembly',
      description: 'Import parts, patch them, and merge/couple them into one case.',
      argsSchema: {
        projectId: z.string().describe('Project id.'),
      },
    },
    ({ projectId }) =>
      userText(
        [
          `Assemble a multi-part mesh for project ${projectId}.`,
          '',
          'Steps:',
          `1. Call list_meshes { projectId: "${projectId}" } to see the library; import_mesh any missing parts from local paths.`,
          '2. For each source, check its patches (get_mesh_source_patches). If a source is a single patch, run auto_patch_mesh_source to split it, then rename_mesh_source_patch / edit_mesh_source_patches to name the interfaces.',
          '3. Build a MergePlan: `order` (first entry is the base — use "__case__" to keep the existing case mesh), and `interfaces` pairing the patches to couple (coupling "nonConformal" is the v12-native default; "stitch" for a conformal fuse). Add `transforms` to place added parts.',
          `4. Optionally save_merge_plan first, then call merge_meshes { projectId: "${projectId}", plan: {…} } and read the per-step report.`,
          '5. Call verify_case and get_mesh_manifest to confirm the assembled mesh.',
          '',
          'Prefer non-conformal coupling; keep parts as separate zones. Report the plan you used and the merge result.',
        ].join('\n'),
      ),
  );
}
