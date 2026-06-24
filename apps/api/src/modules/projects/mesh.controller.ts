// HTTP controllers for the 3D mesh viewer ("Visualize" tab). Thin adapters over
// mesh.service; all routes run behind requireAuth and are project-visibility
// scoped in the service.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  autoPatchMesh,
  getMeshEdges,
  getMeshGeometry,
  getMeshManifest,
  rebuildMesh,
  renameMeshPatch,
} from './mesh.service';
import type { AutoPatchInput, RenamePatchInput } from './mesh.schemas';

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

/** POST /projects/:id/mesh/auto-patch — run autoPatch <featureAngle> -overwrite. */
export async function autoPatchController(req: Request, res: Response): Promise<void> {
  const { featureAngle } = req.body as AutoPatchInput;
  const result = await autoPatchMesh(requireViewer(req), req.params.id, featureAngle);
  res.status(200).json({ result });
}
