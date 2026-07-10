// Tools for projects, collaborators, the case-file tree, and applying a shared
// template to a project's case.
import { z } from 'zod';
import type { Api } from '../client.js';
import { type Registrar, saveDownload } from '../kit.js';
import { projectId } from './params.js';

export function registerProjectTools(tool: Registrar, api: Api): void {
  // ---- Projects ---------------------------------------------------------
  tool('list_projects', {
    title: 'List projects',
    description: 'List the projects visible to the service account (newest first).',
  }, async () => api.get('/projects'));

  tool('get_project', {
    title: 'Get project',
    description: 'Fetch a single project by id (metadata, owner, collaborators).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}`));

  tool('create_project', {
    title: 'Create project',
    description: 'Create a new project owned by the service account.',
    inputSchema: { title: z.string().min(1).describe('Project title.') },
  }, async ({ title }) => api.post('/projects', { title }));

  tool('delete_project', {
    title: 'Delete project',
    description: 'Delete a project and its case files. Irreversible.',
    inputSchema: projectId,
    destructive: true,
  }, async ({ projectId }) => {
    await api.delete(`/projects/${projectId}`);
    return { deleted: projectId };
  });

  tool('get_dashboard', {
    title: 'Get dashboard',
    description: 'Fetch aggregate dashboard stats (projects, runs, activity).',
  }, async () => api.get('/dashboard'));

  // ---- Collaborators ----------------------------------------------------
  tool('add_collaborator', {
    title: 'Add collaborator',
    description: 'Grant another user access to a project by their email address.',
    inputSchema: {
      ...projectId,
      email: z.string().email().describe("The collaborator's email address."),
    },
  }, async ({ projectId, email }) => api.post(`/projects/${projectId}/collaborators`, { email }));

  tool('remove_collaborator', {
    title: 'Remove collaborator',
    description: "Revoke a collaborator's access to a project.",
    inputSchema: {
      ...projectId,
      userId: z.string().min(1).describe('The collaborator user id to remove.'),
    },
    destructive: true,
  }, async ({ projectId, userId }) =>
    api.delete(`/projects/${projectId}/collaborators/${userId}`));

  // ---- Case files -------------------------------------------------------
  tool('list_case_files', {
    title: 'List case files',
    description: 'List the OpenFOAM case file tree for a project (empty until a case is imported).',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/files`));

  tool('read_case_file', {
    title: 'Read a case file',
    description: 'Read the text content of a single case file (e.g. system/controlDict, 0/U).',
    inputSchema: {
      ...projectId,
      path: z.string().min(1).describe('Case-relative file path, e.g. "system/controlDict".'),
    },
  }, async ({ projectId, path }) => api.get(`/projects/${projectId}/files/content`, { path }));

  tool('write_case_file', {
    title: 'Write case file',
    description: 'Save text content to a case file, creating it if needed (overwrites existing content).',
    inputSchema: {
      ...projectId,
      path: z.string().min(1).describe('Case-relative file path.'),
      content: z.string().describe('New full file content.'),
    },
    destructive: true,
  }, async ({ projectId, path, content }) => {
    await api.putText(`/projects/${projectId}/files/content`, content, { path });
    return { saved: path };
  });

  tool('create_case_file', {
    title: 'Create case file',
    description: 'Create a new empty case file at the given path. Returns the refreshed tree.',
    inputSchema: {
      ...projectId,
      path: z.string().min(1).describe('Case-relative file path to create.'),
    },
  }, async ({ projectId, path }) => api.post(`/projects/${projectId}/files/content`, { path }));

  tool('delete_case_file', {
    title: 'Delete case file',
    description: 'Delete a single case file. Returns the refreshed tree.',
    inputSchema: {
      ...projectId,
      path: z.string().min(1).describe('Case-relative file path to delete.'),
    },
    destructive: true,
  }, async ({ projectId, path }) => api.delete(`/projects/${projectId}/files/content`, { path }));

  tool('delete_case_dir', {
    title: 'Delete case folder',
    description: 'Delete a whole folder (and everything under it) from the case tree.',
    inputSchema: {
      ...projectId,
      path: z.string().min(1).describe('Case-relative folder path to delete.'),
    },
    destructive: true,
  }, async ({ projectId, path }) => api.delete(`/projects/${projectId}/files/dir`, { path }));

  tool('move_case_entry', {
    title: 'Move / rename case entry',
    description: 'Move or rename a case file or folder from one path to another.',
    inputSchema: {
      ...projectId,
      from: z.string().min(1).describe('Current case-relative path.'),
      to: z.string().min(1).describe('New case-relative path.'),
    },
  }, async ({ projectId, from, to }) => api.post(`/projects/${projectId}/files/move`, { from, to }));

  tool('reset_case', {
    title: 'Reset case',
    description: 'Remove ALL imported case files, returning the project to an empty case. Irreversible.',
    inputSchema: projectId,
    destructive: true,
  }, async ({ projectId }) => api.delete(`/projects/${projectId}/files`));

  tool('import_case_zip', {
    title: 'Import case (.zip)',
    description:
      'Import a .zip archive of an OpenFOAM case (or a polyMesh folder) from a local file path into the project.',
    inputSchema: {
      ...projectId,
      filePath: z
        .string()
        .min(1)
        .describe('Absolute path to a .zip archive on the machine running the MCP server.'),
    },
  }, async ({ projectId, filePath }) =>
    api.postForm(
      `/projects/${projectId}/files/import`,
      {},
      [{ field: 'archive', path: filePath }],
      undefined,
      { timeoutMs: api.slowTimeoutMs },
    ));

  tool('download_case', {
    title: 'Download case (.zip)',
    description:
      'Download the whole case as a .zip and save it to a local file path on the machine running this server.',
    inputSchema: {
      ...projectId,
      savePath: z.string().min(1).describe('Local file path to write the .zip to.'),
    },
  }, async ({ projectId, savePath }) =>
    saveDownload(
      savePath,
      await api.getBytes(`/projects/${projectId}/files/download`, undefined, {
        timeoutMs: api.slowTimeoutMs,
      }),
    ));

  tool('verify_case', {
    title: 'Verify case',
    description: 'Report which mandatory OpenFOAM files the case has / is missing.',
    inputSchema: projectId,
  }, async ({ projectId }) => api.get(`/projects/${projectId}/files/verify`));

  tool('scaffold_case', {
    title: 'Scaffold base case files',
    description: 'Generate the missing mandatory OpenFOAM base files for the case.',
    inputSchema: projectId,
  }, async ({ projectId }) => api.post(`/projects/${projectId}/files/scaffold`));

  // ---- Apply a template to this project's case --------------------------
  tool('preview_apply_template', {
    title: 'Preview applying a template',
    description:
      'Preview applying a shared template to this case: reports which files would be added and which conflict with existing case files.',
    inputSchema: {
      ...projectId,
      templateId: z.string().min(1).describe('Template id to preview (see list_templates).'),
    },
  }, async ({ projectId, templateId }) =>
    api.get(`/projects/${projectId}/apply-template/${templateId}/preview`));

  tool('apply_template', {
    title: 'Apply a template',
    description:
      "Apply a shared template's files to this case. `decisions` maps a conflicting path to 'overwrite' or 'keep' (default keeps existing files).",
    inputSchema: {
      ...projectId,
      templateId: z.string().min(1).describe('Template id to apply.'),
      decisions: z
        .record(z.string(), z.enum(['overwrite', 'keep']))
        .optional()
        .describe('Per-conflict decision map: path -> "overwrite" | "keep".'),
    },
    destructive: true,
  }, async ({ projectId, templateId, decisions }) =>
    api.post(`/projects/${projectId}/apply-template/${templateId}`, decisions ? { decisions } : {}));

  tool('apply_template_files', {
    title: 'Apply selected template files',
    description: 'Import a specific set of files from a template into this case (by case-relative path).',
    inputSchema: {
      ...projectId,
      templateId: z.string().min(1).describe('Template id to import from.'),
      paths: z.array(z.string().min(1)).min(1).describe('Template file paths to import.'),
    },
    destructive: true,
  }, async ({ projectId, templateId, paths }) =>
    api.post(`/projects/${projectId}/apply-template/${templateId}/files`, { paths }));
}
