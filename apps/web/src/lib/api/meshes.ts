import { apiClient } from './client';
import type {
  DeleteMeshResponse,
  ImportMeshResponse,
  MergePlan,
  MergePlanResponse,
  MergeResponse,
  MergeRunResult,
  MeshPatch,
  MeshPatchesResponse,
  MeshSource,
  MeshesResponse,
} from './types';

/**
 * meshes.ts - multi-mesh library + merge endpoints (authenticated,
 * project-visibility scoped). Typed wrappers around `/projects/:id/meshes`.
 */

/** List the project's imported polyMesh sources (with their boundary patches). */
export async function listMeshes(projectId: string): Promise<MeshSource[]> {
  const data = await apiClient.get<MeshesResponse>(`/projects/${projectId}/meshes`);
  return data.meshes;
}

/** The boundary patches of a single mesh source (for the stitch-pair picker). */
export async function getMeshPatches(projectId: string, meshId: string): Promise<MeshPatch[]> {
  const data = await apiClient.get<MeshPatchesResponse>(
    `/projects/${projectId}/meshes/${meshId}/patches`,
  );
  return data.patches;
}

/** Top-level folder name of a folder upload (becomes the source's display name). */
function meshNameFromFolder(files: File[]): string {
  const first = files[0]?.webkitRelativePath ?? '';
  const top = first.split('/')[0];
  return top && top !== 'polyMesh' ? top : '';
}

/**
 * Import a polyMesh folder into the library. Each file carries its relative path
 * (webkitRelativePath) as the multipart part filename so the server keeps the
 * polyMesh tree; an explicit `name` (else the top folder name) is sent as the
 * source's display name and slug.
 */
export async function importMeshFolder(
  projectId: string,
  files: File[],
  name?: string,
): Promise<ImportMeshResponse> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file, file.webkitRelativePath || file.name);
  }
  const resolved = name?.trim() || meshNameFromFolder(files);
  if (resolved) form.append('name', resolved);
  return apiClient.postForm<ImportMeshResponse>(`/projects/${projectId}/meshes/import`, form);
}

/** Import a .zip of a polyMesh into the library (optionally named). */
export async function importMeshZip(
  projectId: string,
  file: File,
  name?: string,
): Promise<ImportMeshResponse> {
  const form = new FormData();
  form.append('archive', file, file.name);
  if (name?.trim()) form.append('name', name.trim());
  return apiClient.postForm<ImportMeshResponse>(`/projects/${projectId}/meshes/import`, form);
}

/**
 * Import a single .cgns / .msh mesh file into the library (converted to a
 * polyMesh). An explicit `name` (else the file basename) becomes its slug.
 */
export async function importMeshFile(
  projectId: string,
  file: File,
  name?: string,
): Promise<ImportMeshResponse> {
  const form = new FormData();
  form.append('meshFile', file, file.name);
  if (name?.trim()) form.append('name', name.trim());
  return apiClient.postForm<ImportMeshResponse>(`/projects/${projectId}/meshes/import`, form);
}

/** Remove a mesh source from the library. */
export async function deleteMesh(projectId: string, meshId: string): Promise<DeleteMeshResponse> {
  return apiClient.delete<DeleteMeshResponse>(`/projects/${projectId}/meshes/${meshId}`);
}

/**
 * Run the merge pipeline. Resolves with the per-step report even when a step
 * fails (result.success is false); only validation errors (empty/invalid plan,
 * unknown patch) reject as ApiError.
 */
export async function runMerge(projectId: string, plan: MergePlan): Promise<MergeRunResult> {
  const data = await apiClient.post<MergeResponse>(`/projects/${projectId}/meshes/merge`, plan);
  return data.result;
}

/** Read the last saved merge plan (to pre-fill the dialog), or null. */
export async function getMergePlan(projectId: string): Promise<MergePlan | null> {
  const data = await apiClient.get<MergePlanResponse>(`/projects/${projectId}/meshes/plan`);
  return data.plan;
}

/** Persist a merge-plan draft (without running it). */
export async function saveMergePlan(projectId: string, plan: MergePlan): Promise<MergePlan> {
  const data = await apiClient.put<MergePlanResponse>(`/projects/${projectId}/meshes/plan`, plan);
  return (data.plan ?? plan) as MergePlan;
}
