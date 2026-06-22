import { z } from 'zod';
import { FULL_NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@dive/shared';

/**
 * schemas.ts - zod schemas for the self-service account forms.
 *
 * Profile: only the display name is self-editable (email and role are
 * administered through the back office). Password: current + new + confirm,
 * with the new password meeting the shared minimum length, required to match
 * the confirmation, and required to differ from the current one.
 */

export const profileSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Enter your full name.')
    .max(FULL_NAME_MAX_LENGTH, `Use ${FULL_NAME_MAX_LENGTH} characters or fewer.`),
});

export type ProfileFormValues = z.infer<typeof profileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`),
    confirmPassword: z.string().min(1, 'Re-enter your new password.'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'The passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'Choose a new password different from your current one.',
    path: ['newPassword'],
  });

export type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;
