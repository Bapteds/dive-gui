// Tools for shared, reusable case templates: metadata CRUD and their file tree.
import { z } from 'zod';
import type { Api } from '../client.js';
import type { Registrar } from '../kit.js';
import { templateParams } from './params.js';

export function registerTemplateTools(tool: Registrar, api: Api): void {
  tool('list_templates', {
    title: 'List templates',
    description: 'List the shared case templates available to apply to a project.',
  }, async () => api.get('/templates'));

  tool('get_template', {
    title: 'Get template',
    description: 'Fetch a single template by id (metadata, tags, author).',
    inputSchema: templateParams,
  }, async ({ templateId }) => api.get(`/templates/${templateId}`));

  tool('create_template', {
    title: 'Create template',
    description: 'Create a new shared template. Optionally tag it and seed a first file inline.',
    inputSchema: {
      name: z.string().min(1).describe('Template name.'),
      description: z.string().optional().describe('Optional description.'),
      tags: z.array(z.string()).optional().describe('Optional tags (normalized to kebab-case server-side).'),
      file: z
        .object({ path: z.string().min(1), content: z.string() })
        .optional()
        .describe('Optional inline first file { path, content }.'),
    },
  }, async ({ name, description, tags, file }) => {
    const body: Record<string, unknown> = { name };
    if (description !== undefined) body.description = description;
    if (tags !== undefined) body.tags = tags;
    if (file !== undefined) body.file = file;
    return api.post('/templates', body);
  });

  tool('update_template', {
    title: 'Update template',
    description: "Update a template's metadata (name, description, tags). Provide at least one field.",
    inputSchema: {
      ...templateParams,
      name: z.string().min(1).optional().describe('New name.'),
      description: z.string().optional().describe('New description.'),
      tags: z.array(z.string()).optional().describe('New tags.'),
    },
  }, async ({ templateId, name, description, tags }) => {
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (tags !== undefined) body.tags = tags;
    return api.patch(`/templates/${templateId}`, body);
  });

  tool('delete_template', {
    title: 'Delete template',
    description: 'Delete a shared template and its files. Irreversible.',
    inputSchema: templateParams,
    destructive: true,
  }, async ({ templateId }) => {
    await api.delete(`/templates/${templateId}`);
    return { deleted: templateId };
  });

  // ---- Template files ---------------------------------------------------
  tool('list_template_files', {
    title: 'List template files',
    description: "List a template's file tree.",
    inputSchema: templateParams,
  }, async ({ templateId }) => api.get(`/templates/${templateId}/files`));

  tool('read_template_file', {
    title: 'Read a template file',
    description: "Read the text content of a single template file.",
    inputSchema: {
      ...templateParams,
      path: z.string().min(1).describe('Template-relative file path.'),
    },
  }, async ({ templateId, path }) => api.get(`/templates/${templateId}/files/content`, { path }));

  tool('write_template_file', {
    title: 'Write template file',
    description: 'Save text content to a template file, creating it if needed (overwrites existing content).',
    inputSchema: {
      ...templateParams,
      path: z.string().min(1).describe('Template-relative file path.'),
      content: z.string().describe('New full file content.'),
    },
    destructive: true,
  }, async ({ templateId, path, content }) => {
    await api.putText(`/templates/${templateId}/files/content`, content, { path });
    return { saved: path };
  });

  tool('create_template_file', {
    title: 'Create template file',
    description: 'Create a new empty template file at the given path.',
    inputSchema: {
      ...templateParams,
      path: z.string().min(1).describe('Template-relative file path to create.'),
    },
  }, async ({ templateId, path }) => api.post(`/templates/${templateId}/files/content`, { path }));

  tool('delete_template_file', {
    title: 'Delete template file',
    description: 'Delete a single template file.',
    inputSchema: {
      ...templateParams,
      path: z.string().min(1).describe('Template-relative file path to delete.'),
    },
    destructive: true,
  }, async ({ templateId, path }) => api.delete(`/templates/${templateId}/files/content`, { path }));

  tool('delete_template_dir', {
    title: 'Delete template folder',
    description: 'Delete a whole folder (and everything under it) from a template.',
    inputSchema: {
      ...templateParams,
      path: z.string().min(1).describe('Template-relative folder path to delete.'),
    },
    destructive: true,
  }, async ({ templateId, path }) => api.delete(`/templates/${templateId}/files/dir`, { path }));

  tool('move_template_entry', {
    title: 'Move / rename template entry',
    description: 'Move or rename a template file or folder.',
    inputSchema: {
      ...templateParams,
      from: z.string().min(1).describe('Current template-relative path.'),
      to: z.string().min(1).describe('New template-relative path.'),
    },
  }, async ({ templateId, from, to }) => api.post(`/templates/${templateId}/files/move`, { from, to }));

  tool('import_template_files', {
    title: 'Import template files (.zip)',
    description:
      'Import a folder or .zip of files into a template from a local file path on the machine running this server.',
    inputSchema: {
      ...templateParams,
      filePath: z.string().min(1).describe('Absolute path to a .zip archive on the machine running the MCP server.'),
    },
  }, async ({ templateId, filePath }) =>
    api.postForm(
      `/templates/${templateId}/files/import`,
      {},
      [{ field: 'archive', path: filePath }],
      undefined,
      { timeoutMs: api.slowTimeoutMs },
    ));
}
