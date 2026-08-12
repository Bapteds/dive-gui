// Zod schemas for the projects module.
import { z } from 'zod';
import { PROJECT_TITLE_MAX_LENGTH } from '@dive/shared';

/** Body for creating a project: just a non-empty title. */
export const createProjectSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(PROJECT_TITLE_MAX_LENGTH),
});

/** Body for renaming a project: a new non-empty title. */
export const renameProjectSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(PROJECT_TITLE_MAX_LENGTH),
});

/** Body for adding a collaborator: the target user's email. */
export const addCollaboratorSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
});

/** Route params carrying a project id. */
export const projectIdParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
});

/** Route params for a collaborator action (project id + collaborator user id). */
export const collaboratorParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  userId: z.string().min(1, 'User id is required'),
});

/** Inferred input types. */
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type RenameProjectInput = z.infer<typeof renameProjectSchema>;
export type AddCollaboratorInput = z.infer<typeof addCollaboratorSchema>;
