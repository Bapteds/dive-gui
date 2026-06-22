import { z } from 'zod';
import { PASSWORD_MIN_LENGTH, ROLES } from '@dive/shared';

/**
 * schemas.ts - zod schemas for the user create / edit form.
 *
 * The two modes share the same fields but differ on the password rule:
 *  - create: password is required and must be at least 8 characters.
 *  - edit:   password is optional ("leave blank to keep"), but when the field
 *            is filled it must still be at least 8 characters.
 * `userFormSchema(mode)` returns the right schema so react-hook-form's resolver
 * enforces the correct rule per dialog. Role is constrained to the API enum.
 */

const fullName = z
  .string()
  .trim()
  .min(1, 'Enter a full name.')
  .max(120, 'Use 120 characters or fewer.');

const email = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .email('Enter a valid email address.');

const role = z.enum(ROLES, {
  required_error: 'Choose a role.',
  invalid_type_error: 'Choose a role.',
});

/** Password on create: required, minimum length from the shared contract. */
const createPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`);

/**
 * Password on edit: optional. An empty string means "keep current"; any
 * non-empty value must meet the shared minimum length. Empty is normalised to
 * `undefined` so the payload omits the field entirely.
 */
const editPassword = z
  .string()
  .refine((value) => value.length === 0 || value.length >= PASSWORD_MIN_LENGTH, {
    message: `Use at least ${PASSWORD_MIN_LENGTH} characters, or leave blank to keep the current password.`,
  })
  .transform((value) => (value.length === 0 ? undefined : value));

export const createUserSchema = z.object({
  fullName,
  email,
  role,
  password: createPassword,
});

export const editUserSchema = z.object({
  fullName,
  email,
  role,
  password: editPassword,
});

export type CreateUserFormValues = z.infer<typeof createUserSchema>;
export type EditUserFormValues = z.input<typeof editUserSchema>;

/** Pick the schema matching the dialog mode. */
export function userFormSchema(mode: 'create' | 'edit') {
  return mode === 'create' ? createUserSchema : editUserSchema;
}
