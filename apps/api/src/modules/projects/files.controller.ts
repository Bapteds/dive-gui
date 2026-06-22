// HTTP controllers for a project's case files. Thin adapters over
// files.service; all routes run behind requireAuth and are visibility-scoped.
import type { Request, RequestHandler, Response } from 'express';
import multer, { MulterError } from 'multer';
import { CASE_UPLOAD_MAX_BYTES } from '@dive/shared';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  buildCaseArchive,
  getCaseFiles,
  importCaseFiles,
  scaffoldCase,
  verifyCase,
  type ImportPayload,
} from './files.service';

/**
 * Multipart parser for case imports. Files are buffered in memory (mesh files
 * are written straight to disk afterwards). A folder upload sends each file in
 * the `files` field with its relative path as the part filename; a zip sends a
 * single `archive` field.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CASE_UPLOAD_MAX_BYTES, files: 5000 },
  // Keep the full relative path in `originalname`. A folder upload sends each
  // file's relative path (e.g. "polyMesh/points") as the part filename; without
  // this, busboy would strip the directory and we'd lose the tree structure.
  preservePath: true,
});

/**
 * Run the multipart parser and translate multer's own errors into the API's
 * normalized envelope (oversized payloads become 413 PAYLOAD_TOO_LARGE).
 */
export const parseCaseUpload: RequestHandler = (req, res, next) => {
  upload.any()(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'A file exceeds the maximum upload size'));
        return;
      }
      next(new AppError(400, 'INVALID_ARCHIVE', `Upload failed: ${err.message}`));
      return;
    }
    next(err);
  });
};

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/files — list the case tree. */
export async function getCaseFilesController(req: Request, res: Response): Promise<void> {
  const entries = await getCaseFiles(requireViewer(req), req.params.id);
  res.status(200).json({ entries });
}

/** POST /projects/:id/files/import — import a folder or a .zip. */
export async function importCaseFilesController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const archive = files.find((file) => file.fieldname === 'archive');

  const payload: ImportPayload = archive
    ? { archive: archive.buffer }
    : {
        files: files
          .filter((file) => file.fieldname === 'files')
          .map((file) => ({ relativePath: file.originalname, data: file.buffer })),
      };

  const result = await importCaseFiles(requireViewer(req), req.params.id, payload);
  res.status(201).json({ written: result.written, entries: result.entries });
}

/** GET /projects/:id/files/download — stream a .zip of the whole case. */
export async function downloadCaseController(req: Request, res: Response): Promise<void> {
  const archive = await buildCaseArchive(requireViewer(req), req.params.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="case-${req.params.id}.zip"`);
  res.status(200).send(archive);
}

/** GET /projects/:id/files/verify — report which mandatory files are present. */
export async function verifyCaseController(req: Request, res: Response): Promise<void> {
  const verification = await verifyCase(requireViewer(req), req.params.id);
  res.status(200).json({ verification });
}

/** POST /projects/:id/files/scaffold — generate the missing mandatory base files. */
export async function scaffoldCaseController(req: Request, res: Response): Promise<void> {
  const result = await scaffoldCase(requireViewer(req), req.params.id);
  res.status(201).json(result);
}
