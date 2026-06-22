import { z } from 'zod';
import { PROJECT_TITLE_MAX_LENGTH } from '@dive/shared';

/**
 * schemas.ts - zod schema for the create-project form.
 *
 * A project needs only a non-empty title in this phase; the maximum length
 * comes from the shared contract so the API and the form agree.
 */
export const createProjectSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Enter a project title.')
    .max(PROJECT_TITLE_MAX_LENGTH, `Use ${PROJECT_TITLE_MAX_LENGTH} characters or fewer.`),
});

export type CreateProjectFormValues = z.infer<typeof createProjectSchema>;
