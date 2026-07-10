// Templates business logic: shared, reusable file templates.
//
// Access model:
//   - any authenticated user can list, read, and APPLY any template (templates
//     are shared across the team, with the author shown for attribution);
//   - only the author or a super-admin can edit/delete a template or change its
//     files (canManageTemplate);
//   - applying a template to a project is gated by *project* visibility (not
//     template ownership) via assertProjectVisible.
//
// Template files live on disk (templateStorage), mirroring how case files are
// stored. Applying copies files into the project's case; conflicts are resolved
// per file by the caller's decision map (default: keep the existing case file).
import type { Prisma } from '@prisma/client';
import { EDITABLE_FILE_MAX_BYTES, normalizeTags } from '@dive/shared';
import { AppError } from '../../lib/AppError';
import { assertNoActiveRun } from '../../lib/runGuard';
import { prisma } from '../../lib/prisma';
import { sanitizeRelative } from '../../lib/fileTreeStorage';
import {
  caseFileExists,
  listCaseTree,
  writeCaseFile,
  type CaseEntry,
} from '../../lib/caseStorage';
import {
  deleteTemplateDir,
  deleteTemplateFile,
  extractTemplateArchive,
  listTemplateTree,
  moveTemplatePath,
  readTemplateFile,
  removeTemplateStorage,
  templateFileExists,
  writeTemplateFile,
  writeUploadedTemplateFiles,
  type TemplateEntry,
} from '../../lib/templateStorage';
import { assertProjectVisible, type Viewer } from '../projects/projects.service';
import type { ImportPayload } from '../projects/files.service';
import type { ApplyDecision, CreateTemplateInput, UpdateTemplateInput } from './templates.schemas';

/** Minimal public user shape embedded in a template (its author). */
export interface UserSummary {
  id: string;
  fullName: string;
  email: string;
}

/** Public, wire-safe representation of a template. */
export interface PublicTemplate {
  id: string;
  name: string;
  description: string | null;
  /** Normalized tags for search + sort (may be empty). */
  tags: string[];
  owner: UserSummary;
  createdAt: string;
  updatedAt: string;
}

/** A single template file's text content (for the editor). */
export interface TemplateFileContent {
  path: string;
  content: string;
  size: number;
}

/** Result of importing files into a template. */
export interface TemplateImportResult {
  written: string[];
  entries: TemplateEntry[];
}

/** Preview of applying a template to a project's case. */
export interface ApplyPreview {
  /** Every file the template would contribute. */
  files: string[];
  /** Template files whose path already exists in the case (need a decision). */
  conflicts: string[];
  /** Template files not present in the case (always written). */
  newFiles: string[];
}

/** Result of applying a template to a project's case. */
export interface ApplyResult {
  applied: string[];
  skipped: string[];
  entries: CaseEntry[];
}

const templateInclude = { owner: true } satisfies Prisma.TemplateInclude;
type TemplateWithOwner = Prisma.TemplateGetPayload<{ include: typeof templateInclude }>;

function toUserSummary(user: { id: string; fullName: string; email: string }): UserSummary {
  return { id: user.id, fullName: user.fullName, email: user.email };
}

/** Parse the JSON-encoded tags column into a string[] (tolerant of bad data). */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function toPublicTemplate(template: TemplateWithOwner): PublicTemplate {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    tags: parseTags(template.tags),
    owner: toUserSummary(template.owner),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

/** Can the viewer edit/delete this template (author or super-admin)? */
function canManageTemplate(viewer: Viewer, template: { ownerId: string }): boolean {
  return viewer.role === 'SUPER_ADMIN' || template.ownerId === viewer.id;
}

/** Load a template (with owner) or throw 404. */
async function findOrThrow(id: string): Promise<TemplateWithOwner> {
  const template = await prisma.template.findUnique({ where: { id }, include: templateInclude });
  if (!template) {
    throw new AppError(404, 'NOT_FOUND', 'Template not found');
  }
  return template;
}

/** Load a template and assert the viewer may manage it. */
async function findManageableOrThrow(viewer: Viewer, id: string): Promise<TemplateWithOwner> {
  const template = await findOrThrow(id);
  if (!canManageTemplate(viewer, template)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the template author can change this template');
  }
  return template;
}

/** List every template (shared), newest first. */
export async function listTemplates(): Promise<PublicTemplate[]> {
  const templates = await prisma.template.findMany({
    include: templateInclude,
    orderBy: { createdAt: 'desc' },
  });
  return templates.map(toPublicTemplate);
}

/** Fetch a single template. */
export async function getTemplate(id: string): Promise<PublicTemplate> {
  return toPublicTemplate(await findOrThrow(id));
}

/**
 * Create a template owned by the viewer. An optional inline `file` seeds a
 * single-file template in one call (write whatever you want, tag it, done);
 * otherwise the template starts empty and files are added in the editor.
 */
export async function createTemplate(
  viewer: Viewer,
  input: CreateTemplateInput,
): Promise<PublicTemplate> {
  const template = await prisma.template.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() ? input.description.trim() : null,
      tags: JSON.stringify(normalizeTags(input.tags ?? [])),
      ownerId: viewer.id,
    },
    include: templateInclude,
  });

  if (input.file) {
    const safePath = sanitizeRelative(input.file.path);
    if (Buffer.byteLength(input.file.content, 'utf8') > EDITABLE_FILE_MAX_BYTES) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'The file content is too large to create here');
    }
    await writeTemplateFile(template.id, safePath, input.file.content);
  }

  return toPublicTemplate(template);
}

/** Update a template's metadata. Author or super-admin only. */
export async function updateTemplate(
  viewer: Viewer,
  id: string,
  input: UpdateTemplateInput,
): Promise<PublicTemplate> {
  await findManageableOrThrow(viewer, id);

  const data: Prisma.TemplateUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) {
    data.description = input.description.trim() ? input.description.trim() : null;
  }
  if (input.tags !== undefined) data.tags = JSON.stringify(normalizeTags(input.tags));

  const updated = await prisma.template.update({ where: { id }, data, include: templateInclude });
  return toPublicTemplate(updated);
}

/** Delete a template (and its on-disk files). Author or super-admin only. */
export async function deleteTemplate(viewer: Viewer, id: string): Promise<void> {
  await findManageableOrThrow(viewer, id);
  await prisma.template.delete({ where: { id } });
  // Best-effort disk cleanup; never fail the delete on it.
  await removeTemplateStorage(id).catch(() => undefined);
}

/** List a template's file tree. Any authenticated user may read. */
export async function getTemplateFiles(id: string): Promise<TemplateEntry[]> {
  await findOrThrow(id);
  return listTemplateTree(id);
}

/** Import a folder or .zip into a template. Author or super-admin only. */
export async function importTemplateFiles(
  viewer: Viewer,
  id: string,
  payload: ImportPayload,
): Promise<TemplateImportResult> {
  await findManageableOrThrow(viewer, id);

  let written: string[];
  if (payload.archive) {
    written = await extractTemplateArchive(id, payload.archive);
  } else if (payload.files && payload.files.length > 0) {
    written = await writeUploadedTemplateFiles(
      id,
      payload.files.map((f) => ({ relativePath: f.relativePath, data: f.data })),
    );
  } else {
    throw new AppError(400, 'NO_FILES_UPLOADED', 'No files were uploaded');
  }

  return { written, entries: await listTemplateTree(id) };
}

/** Read a single template file's content for the editor. */
export async function readTemplateFileContent(
  id: string,
  relPath: string,
): Promise<TemplateFileContent> {
  await findOrThrow(id);

  const buffer = await readTemplateFile(id, relPath);
  if (!buffer) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  if (buffer.length > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'This file is too large to edit in the browser');
  }
  return { path: relPath, content: buffer.toString('utf8'), size: buffer.length };
}

/** Save edited content to an existing template file. Author or super-admin only. */
export async function saveTemplateFileContent(
  viewer: Viewer,
  id: string,
  relPath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  await findManageableOrThrow(viewer, id);

  if (!(await templateFileExists(id, relPath))) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The edited content is too large to save');
  }
  await writeTemplateFile(id, relPath, content);
  return { path: relPath, size };
}

/** Create a new, empty template file. Author or super-admin only. */
export async function createTemplateFile(
  viewer: Viewer,
  id: string,
  relPath: string,
  content = '',
): Promise<{ path: string; entries: TemplateEntry[] }> {
  await findManageableOrThrow(viewer, id);

  const safePath = sanitizeRelative(relPath);
  if (await templateFileExists(id, safePath)) {
    throw new AppError(409, 'FILE_EXISTS', 'A file already exists at that path');
  }
  if (Buffer.byteLength(content, 'utf8') > EDITABLE_FILE_MAX_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', 'The file content is too large to create here');
  }

  await writeTemplateFile(id, safePath, content);
  return { path: safePath, entries: await listTemplateTree(id) };
}

/** Delete a single template file. Author or super-admin only. */
export async function deleteTemplateFileContent(
  viewer: Viewer,
  id: string,
  relPath: string,
): Promise<{ entries: TemplateEntry[] }> {
  await findManageableOrThrow(viewer, id);

  if (!(await templateFileExists(id, relPath))) {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  await deleteTemplateFile(id, relPath);
  return { entries: await listTemplateTree(id) };
}

/** Delete a whole template directory subtree. Author or super-admin only. */
export async function deleteTemplateDirContent(
  viewer: Viewer,
  id: string,
  relPath: string,
): Promise<{ entries: TemplateEntry[] }> {
  await findManageableOrThrow(viewer, id);
  await deleteTemplateDir(id, relPath);
  return { entries: await listTemplateTree(id) };
}

/** Move (or rename) a template file or directory. Author or super-admin only. */
export async function moveTemplateEntry(
  viewer: Viewer,
  id: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string; entries: TemplateEntry[] }> {
  await findManageableOrThrow(viewer, id);
  const result = await moveTemplatePath(id, from, to);
  return { from: result.from, to: result.to, entries: await listTemplateTree(id) };
}

/** List a template's files (file paths only). */
async function templateFilePaths(id: string): Promise<string[]> {
  const tree = await listTemplateTree(id);
  return tree.filter((entry) => entry.type === 'file').map((entry) => entry.path);
}

/**
 * Preview applying a template to a project's case: which files are new and which
 * collide with existing case files. Gated by project visibility.
 */
export async function previewApplyTemplate(
  viewer: Viewer,
  projectId: string,
  templateId: string,
): Promise<ApplyPreview> {
  await assertProjectVisible(viewer, projectId);
  await findOrThrow(templateId);

  const files = await templateFilePaths(templateId);
  const presence = await Promise.all(files.map((path) => caseFileExists(projectId, path)));
  const conflicts = files.filter((_, i) => presence[i]);
  const newFiles = files.filter((_, i) => !presence[i]);
  return { files, conflicts, newFiles };
}

/**
 * Apply a template to a project's case. New files are always written; for a file
 * that already exists in the case it is overwritten only when the decision map
 * says so (default: keep the existing file). Conflicts are recomputed on the
 * server, so the client cannot force an unintended overwrite. Gated by project
 * visibility.
 */
export async function applyTemplate(
  viewer: Viewer,
  projectId: string,
  templateId: string,
  decisions: Record<string, ApplyDecision> = {},
  // convertCgnsToFoam already asserted no active run at entry; it passes skipRunGuard.
  opts: { skipRunGuard?: boolean } = {},
): Promise<ApplyResult> {
  await assertProjectVisible(viewer, projectId);
  if (!opts.skipRunGuard) await assertNoActiveRun(projectId); // overwrites case files (M1)
  await findOrThrow(templateId);

  const files = await templateFilePaths(templateId);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const path of files) {
    const exists = await caseFileExists(projectId, path);
    if (exists && decisions[path] !== 'overwrite') {
      skipped.push(path);
      continue;
    }
    const buffer = await readTemplateFile(templateId, path);
    if (buffer === null) {
      // The file vanished between listing and copy; skip rather than fail.
      skipped.push(path);
      continue;
    }
    // Binary copy: templates may hold non-editable files, so no editor size cap.
    await writeCaseFile(projectId, path, buffer);
    applied.push(path);
  }

  return { applied, skipped, entries: await listCaseTree(projectId) };
}

/**
 * Import SELECTED template files into a project's case (the "Add from template
 * file" flow, used from the solver setup editor). Only the given paths that really
 * exist in the template are copied; each overwrites the case file at the same path
 * (the user picked them on purpose). Paths not in the template are reported as
 * skipped rather than failing. Gated by project visibility.
 */
export async function applyTemplateFiles(
  viewer: Viewer,
  projectId: string,
  templateId: string,
  paths: string[],
): Promise<ApplyResult> {
  await assertProjectVisible(viewer, projectId);
  await assertNoActiveRun(projectId); // overwrites case files a live solver reads (M1)
  await findOrThrow(templateId);

  const available = new Set(await templateFilePaths(templateId));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const rawPath of paths) {
    const path = sanitizeRelative(rawPath);
    if (!available.has(path)) {
      skipped.push(rawPath);
      continue;
    }
    const buffer = await readTemplateFile(templateId, path);
    if (buffer === null) {
      skipped.push(path);
      continue;
    }
    await writeCaseFile(projectId, path, buffer);
    applied.push(path);
  }

  return { applied, skipped, entries: await listCaseTree(projectId) };
}
