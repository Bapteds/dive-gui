// HTTP controllers for the OpenFOAM -> CGNS export ("Export" tab). Thin adapters
// over export.service; routes run behind requireAuth and are project-visibility
// scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import { getExportStatus, readExportArtifact, runExport } from './export.service';
import { EXPORT_FILES } from '../../lib/exportStorage';
import type { ExportArtifactParam } from './export.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** POST /projects/:id/export — run the full OpenFOAM -> CGNS pipeline. */
export async function runExportController(req: Request, res: Response): Promise<void> {
  const result = await runExport(requireViewer(req), req.params.id);
  res.status(200).json({ result });
}

/** GET /projects/:id/export — the last export's profile/validation/artifacts (or null). */
export async function getExportStatusController(req: Request, res: Response): Promise<void> {
  const status = await getExportStatus(requireViewer(req), req.params.id);
  res.status(200).json({ status });
}

/** How each downloadable artifact is served (content type + download filename). */
const ARTIFACT_HEADERS: Record<
  ExportArtifactParam,
  { file: keyof typeof EXPORT_FILES; type: string; filename: string }
> = {
  cgns: { file: 'cgns', type: 'application/octet-stream', filename: EXPORT_FILES.cgns },
  session: { file: 'session', type: 'text/plain; charset=utf-8', filename: EXPORT_FILES.session },
  memo: { file: 'memo', type: 'text/markdown; charset=utf-8', filename: EXPORT_FILES.memo },
  report: { file: 'report', type: 'text/markdown; charset=utf-8', filename: EXPORT_FILES.report },
};

/** GET /projects/:id/export/download/:artifact — stream a produced export artifact. */
export async function downloadExportArtifactController(req: Request, res: Response): Promise<void> {
  const artifact = req.params.artifact as ExportArtifactParam;
  const spec = ARTIFACT_HEADERS[artifact];
  const bytes = await readExportArtifact(requireViewer(req), req.params.id, spec.file);
  // Served from project storage as a Buffer (no express.static, no path exposure).
  res.setHeader('Content-Type', spec.type);
  res.setHeader('Content-Disposition', `attachment; filename="${spec.filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(bytes);
}
