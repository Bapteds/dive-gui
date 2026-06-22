import { apiClient } from './client';
import type {
  CreateUserInput,
  ListUsersResponse,
  UpdateUserInput,
  User,
  UserResponse,
} from './types';

/**
 * users.ts - account management endpoints (super-admin only).
 *
 * Typed wrappers around `/users`. The admin screens (built later) consume
 * these directly; each unwraps the `{ user }` / `{ users }` envelope so callers
 * receive plain `User` values.
 */

/** List all platform accounts. */
export async function listUsers(): Promise<User[]> {
  const data = await apiClient.get<ListUsersResponse>('/users');
  return data.users;
}

/** Fetch a single account by id. */
export async function getUser(id: string): Promise<User> {
  const data = await apiClient.get<UserResponse>(`/users/${id}`);
  return data.user;
}

/** Create a new account. */
export async function createUser(input: CreateUserInput): Promise<User> {
  const data = await apiClient.post<UserResponse>('/users', input);
  return data.user;
}

/** Update an existing account (any subset of fields). */
export async function updateUser(id: string, input: UpdateUserInput): Promise<User> {
  const data = await apiClient.patch<UserResponse>(`/users/${id}`, input);
  return data.user;
}

/** Delete an account. */
export async function deleteUser(id: string): Promise<void> {
  await apiClient.delete<void>(`/users/${id}`);
}
