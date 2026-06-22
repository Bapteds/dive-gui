// Zod schemas for the auth module request bodies.
import { z } from 'zod';
import { FULL_NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@dive/shared';

/** Login request body: a valid email and a non-empty password. */
export const loginSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
  // We do not enforce a minimum here: an old account may have any length;
  // wrong credentials are reported uniformly by the service.
  password: z.string().min(1, 'Password is required'),
});

/**
 * Body for updating one's own profile via PATCH /auth/me.
 * Only the display name is self-editable; email and role stay administered by a
 * super-admin through the back office.
 */
export const updateMeSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(FULL_NAME_MAX_LENGTH),
});

/**
 * Body for changing one's own password via POST /auth/change-password.
 * The new-password rule mirrors the create/update rule in users.schemas via the
 * shared PASSWORD_MIN_LENGTH so the constraint stays uniform across the app.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required'),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH),
});

/** Inferred type of a validated login body. */
export type LoginInput = z.infer<typeof loginSchema>;
/** Inferred type of a validated profile-update body. */
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
/** Inferred type of a validated change-password body. */
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
