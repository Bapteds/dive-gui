import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from '@/lib/api/users';
import type { CreateUserInput, UpdateUserInput, User } from '@/lib/api/types';

/**
 * useUsers - React Query hooks for the admin account roster.
 *
 * One query key (`['users']`) backs the table; every mutation invalidates it on
 * success so the list re-fetches and stays in sync. Errors are not swallowed
 * here: the calling components catch the thrown `ApiError` (via `mutateAsync`)
 * to map error codes to field errors / toasts. The shared QueryClient defaults
 * (staleTime 30s, retry 1) come from the app providers.
 */

/** Single source for the users query key, reused by hooks and manual invalidation. */
export const usersQueryKey = ['users'] as const;

/** Load the full account roster. */
export function useUsersQuery() {
  return useQuery<User[]>({
    queryKey: usersQueryKey,
    queryFn: listUsers,
  });
}

/** Create a new account, then refresh the roster. */
export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => createUser(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: usersQueryKey });
    },
  });
}

/** Update an existing account, then refresh the roster. */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
      updateUser(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: usersQueryKey });
    },
  });
}

/** Delete an account, then refresh the roster. */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: usersQueryKey });
    },
  });
}
