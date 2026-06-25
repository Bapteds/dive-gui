// HTTP controllers for the 3D mesh viewer ("Visualize" tab). Thin adapters over
// mesh.service; all routes run behind requireAuth and are project-visibility
// scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  autoPatchMesh,
  editMeshPatches,
  getMeshBackup,
  getMeshEdges,
  getMeshGeometry,
  getMeshManifest,
  rebuildMesh,
  renameMeshPatch,
  restoreMeshBackup,
  saveMeshBackup,
  setPatchType,
} from './mesh.service';
import type {
  AutoPatchInput,
  EditPatchesInput,
  RenamePatchInput,
  SetPatchTypeInput,
} from './mesh.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** GET /projects/:id/mesh/manifest — build-on-demand, return the patch manifest. */
export async function getMeshManifestController(req: Request, res: Response): Promise<void> {
  const manifest = await getMeshManifest(requireViewer(req), req.params.id);
  res.status(200).json({ manifest });
}

/** GET /projects/:id/mesh/geometry — stream the rendered GLB (model/gltf-binary). */
export async function getMeshGeometryController(req: Request, res: Response): Promise<void> {
  const glb = await getMeshGeometry(requireViewer(req), req.params.id);
  // Served from project storage as a Buffer (no express.static, no path exposure),
  // same posture as the case-zip download. Private + must-revalidate: the client
  // re-validates rather than trusting a long-lived copy if the mesh changes.
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(glb);
}

/** GET /projects/:id/mesh/edges — stream the raw cell-edge buffer (404 if none). */
export async function getMeshEdgesController(req: Request, res: Response): Promise<void> {
  const edges = await getMeshEdges(requireViewer(req), req.params.id);
  if (!edges) {
    throw new AppError(404, 'NOT_FOUND', 'No edge data for this mesh.');
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.status(200).send(edges);
}

/** POST /projects/:id/mesh/rebuild — force a rebuild, return the fresh manifest. */
export async function rebuildMeshController(req: Request, res: Response): Promise<void> {
  const manifest = await rebuildMesh(requireViewer(req), req.params.id);
  res.status(200).json({ manifest });
}

/** POST /projects/:id/mesh/patches/rename — rename a boundary patch. */
export async function renameMeshPatchController(req: Request, res: Response): Promise<void> {
  const { from, to } = req.body as RenamePatchInput;
  const result = await renameMeshPatch(requireViewer(req), req.params.id, from, to);
  res.status(200).json(result);
}

/** POST /projects/:id/mesh/patches/type — set a boundary patch's geometric type. */
export async function setMeshPatchTypeController(req: Request, res: Response): Promise<void> {
  const { patch, type } = req.body as SetPatchTypeInput;
  const result = await setPatchType(requireViewer(req), req.params.id, patch, type);
  res.status(200).json(result);
}

/** POST /projects/:id/mesh/auto-patch — run autoPatch <featureAngle> -overwrite. */
export async function autoPatchController(req: Request, res: Response): Promise<void> {
  const { featureAngle } = req.body as AutoPatchInput;
  const result = await autoPatchMesh(requireViewer(req), req.params.id, featureAngle);
  res.status(200).json({ result });
}

/** PUT /projects/:id/mesh/patches — apply a batch of name/type edits at once. */
export async function editMeshPatchesController(req: Request, res: Response): Promise<void> {
  const { edits } = req.body as EditPatchesInput;
  const result = await editMeshPatches(requireViewer(req), req.params.id, edits);
  res.status(200).json(result);
}

/** GET /projects/:id/mesh/backup — status of the single backup slot (or null). */
export async function getMeshBackupController(req: Request, res: Response): Promise<void> {
  const backup = await getMeshBackup(requireViewer(req), req.params.id);
  res.status(200).json({ backup });
}

/** POST /projects/:id/mesh/backup — overwrite the backup slot with the current case. */
export async function saveMeshBackupController(req: Request, res: Response): Promise<void> {
  const backup = await saveMeshBackup(requireViewer(req), req.params.id);
  res.status(200).json({ backup });
}

/** POST /projects/:id/mesh/backup/restore — restore the case from the backup slot. */
export async function restoreMeshBackupController(req: Request, res: Response): Promise<void> {
  const manifest = await restoreMeshBackup(requireViewer(req), req.params.id);
  res.status(200).json({ manifest });
}
