// Templates router, mounted at /api/v1/templates.
// Every route requires an authenticated user. Templates are shared: listing,
// reading, and applying are open to any authenticated user; mutating a template
// or its files is guarded by ownership inside the service (author/super-admin).
import express, { Router } from 'express';
import { EDITABLE_FILE_MAX_BYTES } from '@dive/shared';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import { validate } from '../../middleware/validate';
import { parseCaseUpload } from '../projects/files.controller';
import { filePathQuerySchema, movePathSchema } from '../projects/files.schemas';
import {
  createTemplateController,
  createTemplateFileController,
  deleteTemplateController,
  deleteTemplateDirController,
  deleteTemplateFileController,
  getTemplateController,
  getTemplateFileContentController,
  getTemplateFilesController,
  importTemplateFilesController,
  listTemplatesController,
  moveTemplateEntryController,
  saveTemplateFileContentController,
  updateTemplateController,
} from './templates.controller';
import {
  createFileSchema,
  createTemplateSchema,
  templateIdParamSchema,
  updateTemplateSchema,
} from './templates.schemas';

/**
 * Raw-text body parser for the file-save route (the editor sends file content as
 * text, and the global JSON limit is far too small). Mirrors the projects router.
 */
const parseFileContent = express.text({ type: '*/*', limit: EDITABLE_FILE_MAX_BYTES });

/** Build the templates router (authenticated; shared read, owner-scoped writes). */
export function createTemplatesRouter(): Router {
  const router = Router();

  router.use(asyncHandler(requireAuth));

  // Template metadata CRUD.
  router.get('/', asyncHandler(listTemplatesController));
  router.post('/', validate({ body: createTemplateSchema }), asyncHandler(createTemplateController));
  router.get(
    '/:id',
    validate({ params: templateIdParamSchema }),
    asyncHandler(getTemplateController),
  );
  router.patch(
    '/:id',
    validate({ params: templateIdParamSchema, body: updateTemplateSchema }),
    asyncHandler(updateTemplateController),
  );
  router.delete(
    '/:id',
    validate({ params: templateIdParamSchema }),
    asyncHandler(deleteTemplateController),
  );

  // Template files: list, import (folder or .zip), single-file read/save/create/delete.
  router.get(
    '/:id/files',
    validate({ params: templateIdParamSchema }),
    asyncHandler(getTemplateFilesController),
  );
  router.post(
    '/:id/files/import',
    validate({ params: templateIdParamSchema }),
    parseCaseUpload,
    asyncHandler(importTemplateFilesController),
  );
  router.get(
    '/:id/files/content',
    validate({ params: templateIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(getTemplateFileContentController),
  );
  router.put(
    '/:id/files/content',
    validate({ params: templateIdParamSchema, query: filePathQuerySchema }),
    parseFileContent,
    asyncHandler(saveTemplateFileContentController),
  );
  router.post(
    '/:id/files/content',
    validate({ params: templateIdParamSchema, body: createFileSchema }),
    asyncHandler(createTemplateFileController),
  );
  router.delete(
    '/:id/files/content',
    validate({ params: templateIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(deleteTemplateFileController),
  );
  // Delete a whole folder, or move/rename a file or folder.
  router.delete(
    '/:id/files/dir',
    validate({ params: templateIdParamSchema, query: filePathQuerySchema }),
    asyncHandler(deleteTemplateDirController),
  );
  router.post(
    '/:id/files/move',
    validate({ params: templateIdParamSchema, body: movePathSchema }),
    asyncHandler(moveTemplateEntryController),
  );

  return router;
}
