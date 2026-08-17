// HTTP controllers for the standalone Meshing feature. Thin adapters over
// meshing.service; every route runs behind requireAuth. STL upload reuses the
// shared multipart parser (parseCaseUpload) — each surface is sent in the
// `files` field with its filename as the part name.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import {
  addStlFiles,
  copyMeshingSession,
  createMeshingSession,
  downloadSessionZip,
  getMeshingSession,
  getResultEdges,
  getResultGeometry,
  getMeshingLog,
  getResultManifest,
  importChamberIntoMeshing,
  listMeshingSessions,
  readStlBytes,
  removeMeshingSession,
  removeStlFile,
  renameMeshingSession,
  saveMeshingConfig,
  startMeshingRun,
  stopMeshingRun,
  type StlUpload,
} from './meshing.service';
import type {
  CopySessionInput,
  CreateSessionInput,
  FromChamberInput,
  MeshingConfigInput,
  RenameSessionInput,
  StlNameQuery,
} from './meshing.schemas';

/** GET /meshing — list all sessions (summaries). */
export async function listSessionsController(_req: Request, res: Response): Promise<void> {
  const sessions = await listMeshingSessions();
  res.status(200).json({ sessions });
}

/** POST /meshing — create a session with its engine. */
export async function createSessionController(req: Request, res: Response): Promise<void> {
  const { name, engine } = req.body as CreateSessionInput;
  const session = await createMeshingSession(name, engine);
  res.status(201).json({ session });
}

/** POST /meshing/copy — duplicate a session's engine + config + surfaces. */
export async function copySessionController(req: Request, res: Response): Promise<void> {
  const { sourceId, name } = req.body as CopySessionInput;
  const session = await copyMeshingSession(sourceId, name);
  res.status(201).json({ session });
}

/** POST /meshing/from-chamber — import a chamber build's patches into a session. */
export async function fromChamberController(req: Request, res: Response): Promise<void> {
  const session = await importChamberIntoMeshing(req.body as FromChamberInput);
  res.status(201).json({ session });
}

/** GET /meshing/:id — one session's detail. */
export async function getSessionController(req: Request, res: Response): Promise<void> {
  const session = await getMeshingSession(req.params.id);
  res.status(200).json({ session });
}

/** PATCH /meshing/:id — rename a session (display name only). */
export async function renameSessionController(req: Request, res: Response): Promise<void> {
  const { name } = req.body as RenameSessionInput;
  const session = await renameMeshingSession(req.params.id, name);
  res.status(200).json({ session });
}

/** DELETE /meshing/:id — delete a session. */
export async function deleteSessionController(req: Request, res: Response): Promise<void> {
  await removeMeshingSession(req.params.id);
  res.status(200).json({ ok: true });
}

/** POST /meshing/:id/stl — upload one or more STL surfaces. */
export async function uploadStlController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const uploads: StlUpload[] = files
    .filter((file) => file.fieldname === 'files' || file.fieldname === 'stl')
    .map((file) => ({ name: file.originalname, data: file.buffer }));
  if (uploads.length === 0) {
    throw new AppError(400, 'NO_STL', 'No STL files were uploaded.');
  }
  const session = await addStlFiles(req.params.id, uploads);
  res.status(201).json({ session });
}

/** GET /meshing/:id/stl?name=<file> — download one raw STL (for the client viewer). */
export async function downloadStlController(req: Request, res: Response): Promise<void> {
  const { name } = req.query as unknown as StlNameQuery;
  const bytes = await readStlBytes(req.params.id, name);
  res.setHeader('Content-Type', 'application/sla');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(bytes);
}

/** DELETE /meshing/:id/stl?name=<file> — remove one STL. */
export async function deleteStlController(req: Request, res: Response): Promise<void> {
  const { name } = req.query as unknown as StlNameQuery;
  const session = await removeStlFile(req.params.id, name);
  res.status(200).json({ session });
}

/** POST /meshing/:id/run — START the session's mesher as a background job. */
export async function runSnappyController(req: Request, res: Response): Promise<void> {
  const config = req.body as MeshingConfigInput;
  const { session, status } = await startMeshingRun(req.params.id, config);
  res.status(202).json({ session, status });
}

/** GET /meshing/:id/run/log — poll the live log + lifecycle status of the run. */
export async function getRunLogController(req: Request, res: Response): Promise<void> {
  const log = await getMeshingLog(req.params.id);
  res.status(200).json({ log });
}

/** POST /meshing/:id/run/stop — request a stop of the running mesh. */
export async function stopRunController(req: Request, res: Response): Promise<void> {
  const { session } = await stopMeshingRun(req.params.id);
  res.status(200).json({ session });
}

/** PUT /meshing/:id/config — autosave the edited config (no run). */
export async function saveConfigController(req: Request, res: Response): Promise<void> {
  const config = req.body as MeshingConfigInput;
  const session = await saveMeshingConfig(req.params.id, config);
  res.status(200).json({ session });
}

/** GET /meshing/:id/mesh/manifest — build-on-demand, return the result patch manifest. */
export async function getMeshManifestController(req: Request, res: Response): Promise<void> {
  const manifest = await getResultManifest(req.params.id);
  res.status(200).json({ manifest });
}

/** GET /meshing/:id/mesh/geometry — stream the rendered GLB. */
export async function getMeshGeometryController(req: Request, res: Response): Promise<void> {
  const glb = await getResultGeometry(req.params.id);
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(glb);
}

/** GET /meshing/:id/mesh/edges — stream the cell-edge buffer (204 if none). */
export async function getMeshEdgesController(req: Request, res: Response): Promise<void> {
  const edges = await getResultEdges(req.params.id);
  if (!edges) {
    res.status(204).end();
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(edges);
}

/** GET /meshing/:id/download — stream a .zip of the session case. */
export async function downloadSessionController(req: Request, res: Response): Promise<void> {
  const archive = await downloadSessionZip(req.params.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="meshing-${req.params.id}.zip"`);
  res.status(200).send(archive);
}
