// Zod schemas for the templates module (shared, reusable file templates).
import { z } from 'zod';
import { TEMPLATE_DESCRIPTION_MAX_LENGTH, TEMPLATE_NAME_MAX_LENGTH } from '@dive/shared';

/** Shared field validators. */
const name = z.string().trim().min(1, 'A name is required').max(TEMPLATE_NAME_MAX_LENGTH);
const description = z.string().trim().max(TEMPLATE_DESCRIPTION_MAX_LENGTH);

/** Body for creating a template (files are added afterwards). */
export const createTemplateSchema = z.object({
  name,
  description: description.optional(),
});

/** Body for updating a template's metadata. At least one field required. */
export const updateTemplateSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Route params carrying a template id. */
export const templateIdParamSchema = z.object({
  id: z.string().min(1, 'Template id is required'),
});

/** Body for creating a new (empty) template file from the editor. */
export const createFileSchema = z.object({
  path: z.string().trim().min(1, 'A file path is required'),
});

/** Per-file decision when a template file collides with an existing case file. */
export const applyDecisionSchema = z.enum(['overwrite', 'keep']);

/** Body for applying a template: a map of conflicting path -> decision. */
export const applyDecisionsSchema = z.object({
  decisions: z.record(applyDecisionSchema).optional(),
});

/** Route params for the project-mounted apply endpoints (project id + template id). */
export const applyTemplateParamSchema = z.object({
  id: z.string().min(1, 'Project id is required'),
  templateId: z.string().min(1, 'Template id is required'),
});

/** Inferred input types. */
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ApplyDecision = z.infer<typeof applyDecisionSchema>;
