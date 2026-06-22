import { createContext } from 'react';
import type { User } from '@/lib/api/types';

/**
 * auth-context.ts - the AuthContext object and its value shape.
 *
 * Kept in its own module (no component export) so the provider file can be a
 * clean component module and React Fast Refresh stays happy.
 */

/** Session lifecycle status. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  /** The signed-in user, or null when not authenticated. */
  user: User | null;
  /** Current session status. */
  status: AuthStatus;
  /** Sign in; resolves once the user is set (throws ApiError on failure). */
  login: (email: string, password: string) => Promise<void>;
  /** Sign out; clears the session locally even if the network call fails. */
  logout: () => Promise<void>;
  /** Replace the cached session user after a self-service profile/password change. */
  setUser: (user: User) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
