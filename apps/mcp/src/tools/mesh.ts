// Tools for the case mesh (patches, backup, auto-patch), CGNS sources and their
// conversion, the multi-mesh library, and the merge / assembly pipeline.
//
// Two tools here close a workflow gap: `upload_cgns` and `import_mesh` are the
// only way to get a source file into a project from Claude — without them
// `convert_cgns` and `merge_meshes` have nothing to act on.
import { z } from 'zod';
import type { Api } from '../client.js';
import { type Registrar, meshUploadField } from '../kit.js';
import { meshParams, patchEdits, projectId } from './params.js';

export function registerMeshTools(tool: Registrar, api: Api): void {
  const slow = { timeoutMs: api.slowTimeoutMs };

  // ---- Case mesh: view, patches, auto-patch -----------------------------
  tool('get_mesh_manifest', {
    title: 'Get mesh manifest',
    description:
      "Fetch the case mesh's patch manifest (builds the 3D render on demand; first call may be slow).",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/mesh/manifest`, undefined, slow));

  tool('rebuild_mesh', {
    title: 'Rebuild mesh render',
    description: "Force a fresh extraction of the case mesh's render (after the mesh changed on disk).",
    inputSchema: projectId,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/mesh/rebuild`, undefined, undefined, slow));

  tool('rename_mesh_patch', {
    title: 'Rename mesh patch',
    description: 'Rename a boundary patch on the case mesh and propagate the new name into the 0/ fields.',
    inputSchema: {
      ...projectId,
      from: z.string().min(1).describe('Current patch name.'),
      to: z.string().min(1).describe('New patch name (an OpenFOAM word).'),
    },
  }, async ({ projectId, from, to }) => api.post(`/projects/${projectId}/mesh/patches/rename`, { from, to }));

  tool('set_mesh_patch_type', {
    title: 'Set mesh patch type',
    description:
      "Set a boundary patch's geometric type or flow role (e.g. wall, patch, inlet, outlet); propagated into the 0/ fields.",
    inputSchema: {
      ...projectId,
      patch: z.string().min(1).describe('Patch whose type to change.'),
      type: z.string().min(1).describe('New geometric type or flow role (validated server-side).'),
    },
  }, async ({ projectId, patch, type }) => api.post(`/projects/${projectId}/mesh/patches/type`, { patch, type }));

  tool('edit_mesh_patches', {
    title: 'Batch-edit mesh patches',
    description:
      'Rename and/or retype many case-mesh patches at once. Backs up the case before the first edit so the change is reversible.',
    inputSchema: { ...projectId, edits: patchEdits },
  }, async ({ projectId, edits }) => api.put(`/projects/${projectId}/mesh/patches`, { edits }));

  tool('auto_patch_mesh', {
    title: 'Auto-patch mesh',
    description:
      'Run autoPatch <featureAngle> -overwrite on the case mesh: split external boundary faces into patches by feature angle. Returns the report.',
    inputSchema: {
      ...projectId,
      featureAngle: z.number().min(0).max(180).describe('Feature angle in degrees (e.g. 45).'),
    },
    destructive: true,
  }, async ({ projectId, featureAngle }) =>
    api.post(`/projects/${projectId}/mesh/auto-patch`, { featureAngle }, undefined, slow));

  // ---- Case mesh: single-slot backup ------------------------------------
  tool('get_mesh_backup', {
    title: 'Get mesh backup status',
    description: "Report the single-slot case backup's status (whether one exists and when it was taken).",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/mesh/backup`));

  tool('save_mesh_backup', {
    title: 'Save mesh backup',
    description: 'Overwrite the single backup slot with the current case (mesh + 0/ fields).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/mesh/backup`));

  tool('restore_mesh_backup', {
    title: 'Restore mesh backup',
    description: 'Restore the case (mesh + 0/ fields) from the backup slot, discarding current changes.',
    inputSchema: projectId,
    destructive: true,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/mesh/backup/restore`, undefined, undefined, slow));

  // ---- CGNS sources + conversion ----------------------------------------
  tool('list_cgns', {
    title: 'List CGNS sources',
    description: "List the project's uploaded CGNS mesh source files.",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/cgns`));

  tool('upload_cgns', {
    title: 'Upload CGNS source',
    description:
      'Upload a CGNS mesh file from a local path into the project so it can be converted (see convert_cgns).',
    inputSchema: {
      ...projectId,
      filePath: z
        .string()
        .min(1)
        .describe('Absolute path to a .cgns file on the machine running the MCP server.'),
    },
  }, async ({ projectId, filePath }) =>
    api.postForm(
      `/projects/${projectId}/cgns`,
      {},
      [{ field: 'file', path: filePath }],
      undefined,
      slow,
    ));

  tool('delete_cgns', {
    title: 'Delete CGNS source',
    description: 'Remove an uploaded CGNS source file from the project by name.',
    inputSchema: {
      ...projectId,
      name: z.string().min(1).describe('CGNS file name to delete (see list_cgns).'),
    },
    destructive: true,
  }, async ({ projectId, name }) => api.delete(`/projects/${projectId}/cgns`, { name }));

  tool('convert_cgns', {
    title: 'Convert CGNS → Foam',
    description:
      'Run the CGNS→OpenFOAM conversion pipeline using an uploaded CGNS file and a template. Returns the per-step report (may report success:false with logs).',
    inputSchema: {
      ...projectId,
      cgnsFile: z.string().min(1).describe('Name of an already-uploaded CGNS source file (see list_cgns / upload_cgns).'),
      templateId: z.string().min(1).describe('Template id to convert with (see list_templates).'),
    },
  }, async ({ projectId, cgnsFile, templateId }) =>
    api.post(`/projects/${projectId}/cgns/convert`, { cgnsFile, templateId }, undefined, slow));

  // ---- Mesh library (multi-mesh import) ---------------------------------
  tool('list_meshes', {
    title: 'List mesh sources',
    description: "List the project's imported polyMesh library sources with their boundary patches.",
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/meshes`));

  tool('import_mesh', {
    title: 'Import mesh source',
    description:
      "Import a mesh into the project's library from a local path: a .zip of a polyMesh folder, or a single .cgns/.msh file. Library meshes feed merge_meshes / assembly.",
    inputSchema: {
      ...projectId,
      filePath: z
        .string()
        .min(1)
        .describe('Absolute path to a .zip / .cgns / .msh file on the machine running the MCP server.'),
      name: z.string().optional().describe('Optional display name (defaults to the file basename).'),
    },
  }, async ({ projectId, filePath, name }) =>
    api.postForm(
      `/projects/${projectId}/meshes/import`,
      name ? { name } : {},
      [{ field: meshUploadField(filePath), path: filePath }],
      undefined,
      slow,
    ));

  tool('delete_mesh', {
    title: 'Delete mesh source',
    description: 'Remove a source from the project mesh library.',
    inputSchema: meshParams,
    destructive: true,
  }, async ({ projectId, meshId }) => api.delete(`/projects/${projectId}/meshes/${meshId}`));

  tool('get_mesh_source_patches', {
    title: 'Get mesh-source patches',
    description: 'List the boundary patches of one library mesh source.',
    inputSchema: meshParams,
  }, async ({ projectId, meshId }) => api.get(`/projects/${projectId}/meshes/${meshId}/patches`));

  tool('get_mesh_source_manifest', {
    title: 'Get mesh-source manifest',
    description: "Fetch a library source's patch manifest (builds its 3D render on demand; first call may be slow).",
    inputSchema: meshParams,
  }, async ({ projectId, meshId }) =>
    api.get(`/projects/${projectId}/meshes/${meshId}/manifest`, undefined, slow));

  tool('auto_patch_mesh_source', {
    title: 'Auto-patch mesh source',
    description:
      'Split a LIBRARY mesh source into patches by feature angle (so a single-patch .cgns import becomes stitchable). Returns the report.',
    inputSchema: {
      ...meshParams,
      featureAngle: z.number().min(0).max(180).describe('Feature angle in degrees (e.g. 45).'),
    },
    destructive: true,
  }, async ({ projectId, meshId, featureAngle }) =>
    api.post(`/projects/${projectId}/meshes/${meshId}/auto-patch`, { featureAngle }, undefined, slow));

  tool('rename_mesh_source_patch', {
    title: 'Rename mesh-source patch',
    description: 'Give a boundary patch on a library mesh source a name.',
    inputSchema: {
      ...meshParams,
      from: z.string().min(1).describe('Current patch name.'),
      to: z.string().min(1).describe('New patch name.'),
    },
  }, async ({ projectId, meshId, from, to }) =>
    api.post(`/projects/${projectId}/meshes/${meshId}/patches/rename`, { from, to }));

  tool('edit_mesh_source_patches', {
    title: 'Batch-edit mesh-source patches',
    description: "Rename and/or retype many of a library source's boundary patches at once (boundary-only; the source has no 0/ fields).",
    inputSchema: { ...meshParams, edits: patchEdits },
  }, async ({ projectId, meshId, edits }) =>
    api.put(`/projects/${projectId}/meshes/${meshId}/patches`, { edits }));

  // ---- Merge / assembly -------------------------------------------------
  tool('merge_meshes', {
    title: 'Merge meshes',
    description:
      'Run the multi-mesh merge / assembly pipeline with a MergePlan (order, interfaces/couples, transforms). Pass the plan as a JSON object — the same shape the web "Merge meshes" dialog sends. Returns the per-step report.',
    inputSchema: {
      ...projectId,
      plan: z.record(z.string(), z.unknown()).describe('MergePlan object: { order: string[], interfaces?, stitches?, transforms? }.'),
    },
    destructive: true,
  }, async ({ projectId, plan }) => api.post(`/projects/${projectId}/meshes/merge`, plan, undefined, slow));

  tool('get_merge_plan', {
    title: 'Get merge plan',
    description: 'Read the last saved merge-plan draft for the project (or null if none).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/meshes/plan`));

  tool('save_merge_plan', {
    title: 'Save merge plan',
    description: 'Save a merge-plan draft (without running it). Same MergePlan shape as merge_meshes.',
    inputSchema: {
      ...projectId,
      plan: z.record(z.string(), z.unknown()).describe('MergePlan object to persist as a draft.'),
    },
  }, async ({ projectId, plan }) => api.put(`/projects/${projectId}/meshes/plan`, plan));

  tool('get_assembly', {
    title: 'Get applied assembly',
    description: 'Fetch the applied-assembly record for the project (or null if the case is not an assembly).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/meshes/assembly`));
}
