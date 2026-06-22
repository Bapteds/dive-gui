import { z } from 'zod';
import { TEMPLATE_DESCRIPTION_MAX_LENGTH, TEMPLATE_NAME_MAX_LENGTH } from '@dive/shared';

/**
 * schemas.ts - zod schema for the template create / edit form.
 *
 * Name is required; description is optional. Lengths come from the shared
 * contract so the form and the API agree.
 */

const name = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(TEMPLATE_NAME_MAX_LENGTH, `Use ${TEMPLATE_NAME_MAX_LENGTH} characters or fewer.`);

const description = z
  .string()
  .trim()
  .max(TEMPLATE_DESCRIPTION_MAX_LENGTH, `Use ${TEMPLATE_DESCRIPTION_MAX_LENGTH} characters or fewer.`);

export const templateFormSchema = z.object({
  name,
  description: description.optional(),
});

export type TemplateFormValues = z.infer<typeof templateFormSchema>;
