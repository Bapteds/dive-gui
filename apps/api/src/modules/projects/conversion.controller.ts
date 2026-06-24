// HTTP controllers for CGNS upload and CGNS -> OpenFOAM conversion. Thin
// adapters over conversion.service; all routes run behind requireAuth and are
// project-visibility scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  convertCgnsToFoam,
  listCgns,
  removeCgns,
  uploadCgns,
} from './conversion.service';
import type { ConvertCgnsInput } from './conversion.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/cgns — list the project's CGNS source files. */
export async function listCgnsController(req: Request, res: Response): Promise<void> {
  const files = await listCgns(requireViewer(req), req.params.id);
  res.status(200).json({ files });
}

/** POST /projects/:id/cgns — upload a single CGNS file (multipart). */
export async function uploadCgnsController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  // Accept the part named "file" or, failing that, the first uploaded part.
  const file = files.find((f) => f.fieldname === 'file') ?? files[0];
  if (!file) {
    throw new AppError(400, 'NO_FILES_UPLOADED', 'No CGNS file was uploaded');
  }

  const result = await uploadCgns(requireViewer(req), req.params.id, {
    name: file.originalname,
    data: file.buffer,
  });
  res.status(201).json(result);
}

/** DELETE /projects/:id/cgns?name=… — remove a CGNS source file. */
export async function deleteCgnsController(req: Request, res: Response): Promise<void> {
  const name = (req.query.name as string | undefined) ?? '';
  const result = await removeCgns(requireViewer(req), req.params.id, name);
  res.status(200).json(result);
}

/** POST /projects/:id/cgns/convert — run the CGNS -> OpenFOAM pipeline. */
export async function convertCgnsController(req: Request, res: Response): Promise<void> {
  const result = await convertCgnsToFoam(
    requireViewer(req),
    req.params.id,
    req.body as ConvertCgnsInput,
  );
  res.status(200).json({ result });
}
