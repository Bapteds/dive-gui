// HTTP controllers for the OpenFOAM -> CGNS export ("Export" tab). Thin adapters
// over export.service; routes run behind requireAuth and are project-visibility
// scoped in the service.
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import { getExportStatus, readExportArtifact, resolveExportArtifact, runExport } from './export.service';
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

/** How the text artifacts are served (content type + download filename). */
const ARTIFACT_HEADERS: Record<
  Exclude<ExportArtifactParam, 'cgns'>,
  { file: keyof typeof EXPORT_FILES; type: string; filename: string }
> = {
  session: { file: 'session', type: 'text/plain; charset=utf-8', filename: EXPORT_FILES.session },
  memo: { file: 'memo', type: 'text/markdown; charset=utf-8', filename: EXPORT_FILES.memo },
  report: { file: 'report', type: 'text/markdown; charset=utf-8', filename: EXPORT_FILES.report },
};

/** Send a Buffer as a download attachment (no express.static, no path exposure). */
function sendDownload(res: Response, bytes: Buffer, type: string, filename: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(bytes);
}

/**
 * STREAM a file from disk as a download attachment, bounding memory to the stream
 * high-water mark instead of buffering the whole (possibly multi-GB) file (M20).
 * The caller has already resolved the path (visibility + existence checked).
 */
function streamDownload(res: Response, absPath: string, size: number, type: string, filename: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  const stream = createReadStream(absPath);
  // A read error after headers can't become a clean HTTP error — just tear down the
  // socket so the client sees a truncated (failed) download rather than a hang.
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: { code: 'DOWNLOAD_FAILED', message: 'Could not read the artifact.' } });
    res.destroy();
  });
  res.status(200);
  stream.pipe(res);
}

/** GET /projects/:id/export/download/:artifact — stream a produced export artifact. */
export async function downloadExportArtifactController(req: Request, res: Response): Promise<void> {
  const artifact = req.params.artifact as ExportArtifactParam;
  const viewer = requireViewer(req);
  const id = req.params.id;

  if (artifact === 'cgns') {
    // Prefer the single (transient) out.cgns; fall back to the per-timestep zip
    // (when the transient merge could not run). Both are STREAMED from disk — an
    // out.cgns can be several GB and must never be buffered in the API (M20).
    try {
      const { path, size } = await resolveExportArtifact(viewer, id, 'cgns');
      streamDownload(res, path, size, 'application/octet-stream', EXPORT_FILES.cgns);
    } catch (err) {
      if (err instanceof AppError && err.status === 404) {
        const { path, size } = await resolveExportArtifact(viewer, id, 'cgnsZip');
        streamDownload(res, path, size, 'application/zip', EXPORT_FILES.cgnsZip);
        return;
      }
      throw err;
    }
    return;
  }

  const spec = ARTIFACT_HEADERS[artifact];
  const bytes = await readExportArtifact(viewer, id, spec.file);
  sendDownload(res, bytes, spec.type, spec.filename);
}
