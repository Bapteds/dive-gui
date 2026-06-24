import { apiClient } from './client';
import type {
  CgnsFile,
  CgnsListResponse,
  ConversionResult,
  ConvertCgnsInput,
  ConvertCgnsResponse,
  DeleteCgnsResponse,
  UploadCgnsResponse,
} from './types';

/**
 * conversion.ts - CGNS mesh source + CGNS -> OpenFOAM conversion endpoints
 * (authenticated, project-visibility scoped). Typed wrappers around
 * `/projects/:id/cgns`.
 */

/** List the project's CGNS source files. */
export async function listCgns(projectId: string): Promise<CgnsFile[]> {
  const data = await apiClient.get<CgnsListResponse>(`/projects/${projectId}/cgns`);
  return data.files;
}

/** Upload a single CGNS file to the project. */
export async function uploadCgns(projectId: string, file: File): Promise<UploadCgnsResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  return apiClient.postForm<UploadCgnsResponse>(`/projects/${projectId}/cgns`, form);
}

/** Delete a CGNS source file by name. */
export async function deleteCgns(projectId: string, name: string): Promise<DeleteCgnsResponse> {
  return apiClient.delete<DeleteCgnsResponse>(
    `/projects/${projectId}/cgns?name=${encodeURIComponent(name)}`,
  );
}

/**
 * Run the CGNS -> OpenFOAM conversion pipeline. Resolves with the per-step
 * report even when a step fails (result.success is false); only validation
 * errors (unknown project/template, missing CGNS) reject as ApiError.
 */
export async function convertCgnsToFoam(
  projectId: string,
  input: ConvertCgnsInput,
): Promise<ConversionResult> {
  const data = await apiClient.post<ConvertCgnsResponse>(
    `/projects/${projectId}/cgns/convert`,
    input,
  );
  return data.result;
}
