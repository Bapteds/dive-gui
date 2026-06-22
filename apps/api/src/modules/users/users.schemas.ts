// Zod schemas for the users module (back-office account management).
import { z } from 'zod';
import {
  FULL_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  roleSchema,
} from '@dive/shared';

/** Allowed roles for a user account (shared contract). */
export { roleSchema };

/** Shared field validators reused across schemas. */
const fullName = z.string().trim().min(1, 'Full name is required').max(FULL_NAME_MAX_LENGTH);
const email = z.string().trim().email('A valid email is required');
const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

/** Body for creating a user. All fields required. */
export const createUserSchema = z.object({
  fullName,
  email,
  password,
  role: roleSchema,
});

/**
 * Body for updating a user. All fields optional, but at least one must be
 * provided so an empty PATCH is rejected as a validation error.
 */
export const updateUserSchema = z
  .object({
    fullName: fullName.optional(),
    email: email.optional(),
    password: password.optional(),
    role: roleSchema.optional(),
    // Enable / disable the account. Disabling revokes the user's sessions and
    // blocks future logins; the protected super-admin can never be disabled.
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Route params carrying a user id. */
export const userIdParamSchema = z.object({
  id: z.string().min(1, 'User id is required'),
});

/** Inferred input types. */
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;
