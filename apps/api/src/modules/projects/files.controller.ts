// HTTP controllers for a project's case files. Thin adapters over
// files.service; all routes run behind requireAuth and are visibility-scoped.
import type { Request, RequestHandler, Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  buildCaseArchive,
  createCaseFile,
  deleteCaseDirContent,
  deleteCaseFileContent,
  getCaseFiles,
  importCaseFiles,
  moveCaseEntry,
  readCaseFileContent,
  resetCase,
  saveCaseFileContent,
  scaffoldCase,
  scaffoldSolver,
  syncBoundaryFields,
  verifyCase,
  verifyRunnable,
  type ImportPayload,
} from './files.service';
import type { MovePathInput, ScaffoldSolverInput } from './files.schemas';

/**
 * Multipart parser for case imports. Files are buffered in memory. A folder
 * upload sends each file in the `files` field with its relative path as the part
 * filename; a zip sends a single `archive` field.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 5000 },
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

/** POST /projects/:id/files/import — import a case folder or a .zip. */
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

/** DELETE /projects/:id/files — remove all imported case files (reset). */
export async function resetCaseController(req: Request, res: Response): Promise<void> {
  const result = await resetCase(requireViewer(req), req.params.id);
  res.status(200).json(result);
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

/** GET /projects/:id/runnable — report whether the case is runnable by simpleFoam. */
export async function verifyRunnableController(req: Request, res: Response): Promise<void> {
  const runnable = await verifyRunnable(requireViewer(req), req.params.id);
  res.status(200).json({ runnable });
}

/** POST /projects/:id/runnable/scaffold — generate the missing files for a solver. */
export async function scaffoldSolverController(req: Request, res: Response): Promise<void> {
  const { solver } = req.body as ScaffoldSolverInput;
  const result = await scaffoldSolver(requireViewer(req), req.params.id, solver);
  res.status(201).json(result);
}

/** POST /projects/:id/files/sync-boundaries — align 0/ boundaryFields to the mesh. */
export async function syncBoundariesController(req: Request, res: Response): Promise<void> {
  const result = await syncBoundaryFields(requireViewer(req), req.params.id);
  res.status(200).json(result);
}

/** GET /projects/:id/files/content?path=… — read a single file's text content. */
export async function getCaseFileContentController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const file = await readCaseFileContent(requireViewer(req), req.params.id, path);
  res.status(200).json({ file });
}

/** PUT /projects/:id/files/content?path=… — save edited text content (text/plain body). */
export async function saveCaseFileContentController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const content = typeof req.body === 'string' ? req.body : '';
  const file = await saveCaseFileContent(requireViewer(req), req.params.id, path, content);
  res.status(200).json({ file });
}

/** POST /projects/:id/files/content — create a new (empty) file from the editor. */
export async function createCaseFileController(req: Request, res: Response): Promise<void> {
  const { path } = req.body as { path: string };
  const result = await createCaseFile(requireViewer(req), req.params.id, path);
  res.status(201).json(result);
}

/** DELETE /projects/:id/files/content?path=… — delete a single file from the editor. */
export async function deleteCaseFileController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const result = await deleteCaseFileContent(requireViewer(req), req.params.id, path);
  res.status(200).json(result);
}

/** DELETE /projects/:id/files/dir?path=… — delete a whole folder from the editor. */
export async function deleteCaseDirController(req: Request, res: Response): Promise<void> {
  const path = (req.query.path as string | undefined) ?? '';
  const result = await deleteCaseDirContent(requireViewer(req), req.params.id, path);
  res.status(200).json(result);
}

/** POST /projects/:id/files/move — move/rename a file or folder. */
export async function moveCaseEntryController(req: Request, res: Response): Promise<void> {
  const { from, to } = req.body as MovePathInput;
  const result = await moveCaseEntry(requireViewer(req), req.params.id, from, to);
  res.status(200).json(result);
}
