import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addCollaborator,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  removeCollaborator,
} from '@/lib/api/projects';
import type { CreateProjectInput, Project } from '@/lib/api/types';

/**
 * useProjects - React Query hooks for projects.
 *
 * One key backs the list and one keyed entry backs each detail view. Mutations
 * invalidate the list (and update the affected detail) so views stay in sync.
 * Errors are not swallowed: callers catch the thrown ApiError via mutateAsync to
 * surface field errors / toasts.
 */

/** Query keys. */
export const projectsQueryKey = ['projects'] as const;
export const projectQueryKey = (id: string) => ['projects', id] as const;

/** Load the projects visible to the current user (newest first). */
export function useProjectsQuery() {
  return useQuery<Project[]>({
    queryKey: projectsQueryKey,
    queryFn: listProjects,
  });
}

/** Load a single project by id. */
export function useProjectQuery(id: string) {
  return useQuery<Project>({
    queryKey: projectQueryKey(id),
    queryFn: () => getProject(id),
  });
}

/** Create a project, then refresh the list. */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}

/** Delete a project, then refresh the list. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}

/** Add a collaborator by email; updates the detail and list. */
export function useAddCollaborator(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => addCollaborator(id, email),
    onSuccess: (project) => {
      queryClient.setQueryData(projectQueryKey(id), project);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}

/** Remove a collaborator; updates the detail and list. */
export function useRemoveCollaborator(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeCollaborator(id, userId),
    onSuccess: (project) => {
      queryClient.setQueryData(projectQueryKey(id), project);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
