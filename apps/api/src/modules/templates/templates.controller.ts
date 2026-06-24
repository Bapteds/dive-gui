// HTTP controllers for templates. Thin adapters over templates.service; all
// routes run behind requireAuth. Read/apply are open to any authenticated user;
// mutations are guarded by template ownership inside the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from '../projects/projects.service';
import type { ImportPayload } from '../projects/files.service';
import {
  applyTemplate,
  createTemplate,
  createTemplateFile,
  deleteTemplate,
  deleteTemplateDirContent,
  deleteTemplateFileContent,
  getTemplate,
  getTemplateFiles,
  importTemplateFiles,
  listTemplates,
  moveTemplateEntry,
  previewApplyTemplate,
  readTemplateFileContent,
  saveTemplateFileContent,
  updateTemplate,
} from './templates.service';
import type {
  ApplyDecision,
  CreateTemplateInput,
  UpdateTemplateInput,
} from './templates.schemas';
import type { MovePathInput } from '../projects/files.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /templates — list every (shared) template. */
export async function listTemplatesController(_req: Request, res: Response): Promise<void> {
  const templates = await listTemplates();
  res.status(200).json({ templates });
}

/** GET /templates/:id — fetch a single template. */
export async function getTemplateController(req: Request, res: Response): Promise<void> {
  const template = await getTemplate(req.params.id);
  res.status(200).json({ template });
}

/** POST /templates — create a template owned by the viewer. */
export async function createTemplateController(req: Request, res: Response): Promise<void> {
  const template = await createTemplate(requireViewer(req), req.body as CreateTemplateInput);
  res.status(201).json({ template });
}

/** PATCH /templates/:id — update a template's metadata. */
export async function updateTemplateController(req: Request, res: Response): Promise<void> {
  const template = await updateTemplate(
    requireViewer(req),
    req.params.id,
    req.body as UpdateTemplateInput,
  );
  res.status(200).json({ template });
}

/** DELETE /templates/:id — delete a template (guards apply in the service). */
export async function deleteTemplateController(req: Request, res: Response): Promise<void> {
  await deleteTemplate(requireViewer(req), req.params.id);
  res.status(204).send();
}

/** GET /templates/:id/files — list a template's file tree. */
export async function getTemplateFilesController(req: Request, res: Response): Promise<void> {
  const entries = await getTemplateFiles(req.params.id);
  res.status(200).json({ entries });
}

/** POST /templates/:id/files/import — import a folder or a .zip. */
export async function importTemplateFilesController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const archive = files.find((file) => file.fieldname === 'archive');

  const payload: ImportPayload = archive
    ? { archive: archive.buffer }
    : {
        files: files
          .filter((file) => file.fieldname === 'files')
          .map((file) => ({ relativePath: file.originalname, data: file.buffer })),
      };

  const result = await importTemplateFiles(requireViewer(req), req.params.id, payload);
  res.status(201).json({ written: result.written, entries: result.entries });
}

/** GET /templates/:id/files/content?path=… — read a single file's text content. */
export async function getTemplateFileContentController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const file = await readTemplateFileContent(req.params.id, path);
  res.status(200).json({ file });
}

/** PUT /templates/:id/files/content?path=… — save edited text content (text/plain body). */
export async function saveTemplateFileContentController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const content = typeof req.body === 'string' ? req.body : '';
  const file = await saveTemplateFileContent(requireViewer(req), req.params.id, path, content);
  res.status(200).json({ file });
}

/** POST /templates/:id/files/content — create a new (empty) file. */
export async function createTemplateFileController(req: Request, res: Response): Promise<void> {
  const { path } = req.body as { path: string };
  const result = await createTemplateFile(requireViewer(req), req.params.id, path);
  res.status(201).json(result);
}

/** DELETE /templates/:id/files/content?path=… — delete a single file. */
export async function deleteTemplateFileController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const result = await deleteTemplateFileContent(requireViewer(req), req.params.id, path);
  res.status(200).json(result);
}

/** DELETE /templates/:id/files/dir?path=… — delete a whole folder. */
export async function deleteTemplateDirController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const result = await deleteTemplateDirContent(requireViewer(req), req.params.id, path);
  res.status(200).json(result);
}

/** POST /templates/:id/files/move — move/rename a file or folder. */
export async function moveTemplateEntryController(req: Request, res: Response): Promise<void> {
  const { from, to } = req.body as MovePathInput;
  const result = await moveTemplateEntry(requireViewer(req), req.params.id, from, to);
  res.status(200).json(result);
}

/**
 * GET /projects/:id/apply-template/:templateId/preview — preview applying a
 * template to a project's case (conflicts + new files). Mounted on the projects
 * router; authorization is project visibility.
 */
export async function previewApplyTemplateController(req: Request, res: Response): Promise<void> {
  const preview = await previewApplyTemplate(
    requireViewer(req),
    req.params.id,
    req.params.templateId,
  );
  res.status(200).json({ preview });
}

/**
 * POST /projects/:id/apply-template/:templateId — apply a template to a
 * project's case, resolving conflicts with the provided per-file decisions.
 */
export async function applyTemplateController(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { decisions?: Record<string, ApplyDecision> };
  const result = await applyTemplate(
    requireViewer(req),
    req.params.id,
    req.params.templateId,
    body.decisions ?? {},
  );
  res.status(200).json(result);
}
