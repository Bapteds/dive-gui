import { useMutation } from '@tanstack/react-query';
import { changePassword, updateMe } from '@/lib/api/auth';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * useAccount - mutations for the self-service account page.
 *
 * Both mutations refresh the cached session user on success (the server returns
 * the updated user), so the header avatar / menu reflect a renamed account and
 * the in-memory access token stays current after a password change. Errors are
 * not swallowed here: callers catch the thrown `ApiError` (via `mutateAsync`)
 * to map error codes to field errors / toasts.
 */

/** Update the current user's own display name, then sync the session user. */
export function useUpdateProfile() {
  const { setUser } = useAuth();
  return useMutation({
    mutationFn: (fullName: string) => updateMe(fullName),
    onSuccess: ({ user }) => setUser(user),
  });
}

/** Change the current user's own password, then sync the session user. */
export function useChangePassword() {
  const { setUser } = useAuth();
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword(input.currentPassword, input.newPassword),
    onSuccess: ({ user }) => setUser(user),
  });
}
