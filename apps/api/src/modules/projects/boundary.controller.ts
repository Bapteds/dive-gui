// "Boundary conditions" overlay controller: parse the multipart request (a JSON
// `payload` field + an optional `csv` file) and delegate to boundary.service. Runs
// behind requireAuth; the service is visibility-scoped.
import type { Request, RequestHandler, Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { applyBoundaryConditions } from './boundary.service';
import { applyBoundaryConditionsSchema } from './boundary.schemas';
import type { Viewer } from './projects.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

/**
 * Parse the multipart body (an optional `csv` file + text fields), mapping multer's
 * own errors into the API's normalized envelope (oversized => 413).
 */
export const parseBoundaryUpload: RequestHandler = (req, res, next) => {
  upload.any()(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'The CSV exceeds the maximum upload size'));
        return;
      }
      next(new AppError(400, 'VALIDATION_ERROR', `Upload failed: ${err.message}`));
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

/** POST /projects/:id/boundary-conditions/apply — apply a component BC preset. */
export async function applyBoundaryConditionsController(req: Request, res: Response): Promise<void> {
  const rawPayload = typeof req.body?.payload === 'string' ? req.body.payload : '';
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawPayload);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', 'The boundary-condition payload is not valid JSON.');
  }
  const parsed = applyBoundaryConditionsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? 'Invalid boundary-condition payload.',
    );
  }

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const csv = files.find((file) => file.fieldname === 'csv')?.buffer;

  const result = await applyBoundaryConditions(requireViewer(req), req.params.id, parsed.data, csv);
  res.status(200).json({ result });
}
