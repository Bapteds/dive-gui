import { apiClient } from './client';
import type {
  CreateProjectInput,
  ListProjectsResponse,
  Project,
  ProjectResponse,
} from './types';

/**
 * projects.ts - project endpoints (authenticated, visibility-scoped).
 *
 * Typed wrappers around `/projects`. Each unwraps the `{ project }` / `{ projects }`
 * envelope so callers receive plain values.
 */

/** List the projects visible to the current user (newest first). */
export async function listProjects(): Promise<Project[]> {
  const data = await apiClient.get<ListProjectsResponse>('/projects');
  return data.projects;
}

/** Fetch a single project by id. */
export async function getProject(id: string): Promise<Project> {
  const data = await apiClient.get<ProjectResponse>(`/projects/${id}`);
  return data.project;
}

/** Create a project owned by the current user. */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const data = await apiClient.post<ProjectResponse>('/projects', input);
  return data.project;
}

/** Delete a project (owner or super-admin). */
export async function deleteProject(id: string): Promise<void> {
  await apiClient.delete<void>(`/projects/${id}`);
}

/** Add a collaborator to a project by email (owner or super-admin). */
export async function addCollaborator(id: string, email: string): Promise<Project> {
  const data = await apiClient.post<ProjectResponse>(`/projects/${id}/collaborators`, { email });
  return data.project;
}

/** Remove a collaborator from a project (owner or super-admin). */
export async function removeCollaborator(id: string, userId: string): Promise<Project> {
  const data = await apiClient.delete<ProjectResponse>(`/projects/${id}/collaborators/${userId}`);
  return data.project;
}
