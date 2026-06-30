// HTTP controllers for the multi-mesh library + merge. Thin adapters over
// meshes.service; all routes run behind requireAuth and are project-visibility
// scoped in the service. The import reuses the shared multipart parser
// (parseCaseUpload) — a folder upload sends each file in the `files` field, a
// .zip in the `archive` field, with an optional `name` text field.
import type { Request, Response } from 'express';
import { AppError } from '../../lib/AppError';
import type { Viewer } from './projects.service';
import {
  autoPatchMeshSource,
  getMergePlan,
  getMeshPatches,
  importMesh,
  listMeshes,
  removeMesh,
  renameMeshSourcePatch,
  runMerge,
  saveMergePlan,
  type MeshImportPayload,
} from './meshes.service';
import type {
  MergePlanInput,
  MeshSourceAutoPatchInput,
  MeshSourceRenamePatchInput,
} from './meshes.schemas';

/** Build the acting viewer (id + role) or fail defensively. */
function requireViewer(req: Request): Viewer {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  }
  return { id: req.user.id, role: req.user.role };
}

/** Best-effort human name from a folder upload (its top directory). */
function folderNameOf(files: Express.Multer.File[]): string {
  const first = files[0]?.originalname ?? '';
  const top = first.replace(/\\/g, '/').split('/')[0];
  return top && top !== 'polyMesh' ? top : '';
}

/** GET /projects/:id/meshes — list the project's mesh library. */
export async function listMeshesController(req: Request, res: Response): Promise<void> {
  const meshes = await listMeshes(requireViewer(req), req.params.id);
  res.status(200).json({ meshes });
}

/** POST /projects/:id/meshes/import — import a polyMesh folder/.zip, or a .cgns/.msh file. */
export async function importMeshController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const meshFile = files.find((file) => file.fieldname === 'meshFile');
  const archive = files.find((file) => file.fieldname === 'archive');
  const folderFiles = files.filter((file) => file.fieldname === 'files');
  const providedName =
    typeof (req.body as { name?: unknown } | undefined)?.name === 'string'
      ? (req.body.name as string).trim()
      : '';

  let payload: MeshImportPayload;
  if (meshFile) {
    payload = {
      // Default to the file's basename without extension (rotor.cgns -> "rotor")
      // so the derived slug id is clean; an explicit `name` from the UI wins.
      name: providedName || meshFile.originalname.replace(/\.[^./\\]+$/, ''),
      meshFile: { name: meshFile.originalname, data: meshFile.buffer },
    };
  } else if (archive) {
    payload = {
      name: providedName || archive.originalname.replace(/\.zip$/i, '') || 'Imported mesh',
      archive: archive.buffer,
    };
  } else if (folderFiles.length > 0) {
    payload = {
      name: providedName || folderNameOf(folderFiles) || 'Imported mesh',
      files: folderFiles.map((file) => ({ relativePath: file.originalname, data: file.buffer })),
    };
  } else {
    throw new AppError(400, 'NO_FILES_UPLOADED', 'No mesh files were uploaded');
  }

  const result = await importMesh(requireViewer(req), req.params.id, payload);
  res.status(201).json(result);
}

/** DELETE /projects/:id/meshes/:meshId — remove a source from the library. */
export async function deleteMeshController(req: Request, res: Response): Promise<void> {
  const result = await removeMesh(requireViewer(req), req.params.id, req.params.meshId);
  res.status(200).json(result);
}

/** GET /projects/:id/meshes/:meshId/patches — the patches of one source. */
export async function getMeshPatchesController(req: Request, res: Response): Promise<void> {
  const patches = await getMeshPatches(requireViewer(req), req.params.id, req.params.meshId);
  res.status(200).json({ patches });
}

/** POST /projects/:id/meshes/:meshId/auto-patch — split a library mesh by feature angle. */
export async function autoPatchMeshSourceController(req: Request, res: Response): Promise<void> {
  const { featureAngle } = req.body as MeshSourceAutoPatchInput;
  const result = await autoPatchMeshSource(
    requireViewer(req),
    req.params.id,
    req.params.meshId,
    featureAngle,
  );
  res.status(200).json(result);
}

/** POST /projects/:id/meshes/:meshId/patches/rename — name a library mesh patch. */
export async function renameMeshSourcePatchController(req: Request, res: Response): Promise<void> {
  const { from, to } = req.body as MeshSourceRenamePatchInput;
  const result = await renameMeshSourcePatch(
    requireViewer(req),
    req.params.id,
    req.params.meshId,
    from,
    to,
  );
  res.status(200).json(result);
}

/** POST /projects/:id/meshes/merge — run the merge pipeline. */
export async function mergeMeshesController(req: Request, res: Response): Promise<void> {
  const result = await runMerge(requireViewer(req), req.params.id, req.body as MergePlanInput);
  res.status(200).json({ result });
}

/** GET /projects/:id/meshes/plan — read the last saved merge plan (or null). */
export async function getMergePlanController(req: Request, res: Response): Promise<void> {
  const plan = await getMergePlan(requireViewer(req), req.params.id);
  res.status(200).json({ plan });
}

/** PUT /projects/:id/meshes/plan — save a merge-plan draft (no run). */
export async function saveMergePlanController(req: Request, res: Response): Promise<void> {
  const plan = await saveMergePlan(requireViewer(req), req.params.id, req.body as MergePlanInput);
  res.status(200).json({ plan });
}
