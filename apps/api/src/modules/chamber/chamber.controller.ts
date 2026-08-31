// HTTP controllers for the standalone Chamber Creation feature. Thin adapters
// over chamber.service; every route runs behind requireAuth. The GLB is served
// as a raw Buffer with the glTF-binary content type (no express.static), exactly
// like the mesh viewer.
import type { Request, Response } from 'express';
import {
  buildChamber,
  getChamberEdges,
  getChamberExport,
  getChamberGeometry,
  getChamberManifest,
} from './chamber.service';
import type { ChamberBuildInput, ChamberExportParam } from './chamber.schemas';

/** Download metadata per export kind. */
const EXPORT_META: Record<ChamberExportParam['kind'], { contentType: string; filename: string }> = {
  stl: { contentType: 'application/sla', filename: 'chamber.stl' },
  step: { contentType: 'application/step', filename: 'chamber.step' },
  trisurface: { contentType: 'application/zip', filename: 'chamber-trisurface.zip' },
};

/** POST /chamber/build — compute the 12 outputs and build the geometry. */
export async function buildChamberController(req: Request, res: Response): Promise<void> {
  const input = req.body as ChamberBuildInput;
  const { hash, outputs, warnings } = await buildChamber(input);
  res.status(200).json({ hash, outputs, warnings });
}

/** GET /chamber/:hash/manifest — the patch manifest for a build. */
export async function getChamberManifestController(req: Request, res: Response): Promise<void> {
  const manifest = await getChamberManifest(req.params.hash);
  res.status(200).json({ manifest });
}

/** GET /chamber/:hash/geometry — stream the rendered GLB. */
export async function getChamberGeometryController(req: Request, res: Response): Promise<void> {
  const glb = await getChamberGeometry(req.params.hash);
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(glb);
}

/** GET /chamber/:hash/edges — stream the cell-edge buffer (204 when none). */
export async function getChamberEdgesController(req: Request, res: Response): Promise<void> {
  const edges = await getChamberEdges(req.params.hash);
  if (!edges) {
    res.status(204).end();
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(edges);
}

/** GET /chamber/:hash/export/:kind — download an STL / STEP / triSurface zip. */
export async function getChamberExportController(req: Request, res: Response): Promise<void> {
  const { hash, kind } = req.params as unknown as ChamberExportParam;
  const buf = await getChamberExport(hash, kind);
  const meta = EXPORT_META[kind];
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
  res.status(200).send(buf);
}
