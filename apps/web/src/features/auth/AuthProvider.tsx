import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as authApi from '@/lib/api/auth';
import { setLogoutHandler } from '@/lib/api/client';
import type { User } from '@/lib/api/types';
import { AuthContext, type AuthStatus } from './auth-context';

/**
 * AuthProvider - owns the session and exposes login / logout via context.
 *
 * On mount it bootstraps the session: `refresh()` exchanges the httpOnly
 * refresh cookie for an access token, then `me()` loads the user. This restores
 * the session across reloads without ever persisting the access token (it lives
 * only in memory inside the API client). The client's "logout signal" is wired
 * here so a failed token refresh transitions the app to unauthenticated.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Guard against setting state after unmount (StrictMode double-invoke / async).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { user: signedIn } = await authApi.login(email, password);
    if (mountedRef.current) {
      setUser(signedIn);
      setStatus('authenticated');
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      if (mountedRef.current) {
        setUser(null);
        setStatus('unauthenticated');
      }
    }
  }, []);

  // Replace the cached session user after a self-service profile/password
  // update (the /account page calls this with the fresh user from the server).
  const applyUser = useCallback((next: User) => {
    if (mountedRef.current) {
      setUser(next);
    }
  }, []);

  // Wire the API client's logout signal: a failed refresh ends the session.
  useEffect(() => {
    setLogoutHandler(() => {
      if (mountedRef.current) {
        setUser(null);
        setStatus('unauthenticated');
      }
    });
    return () => setLogoutHandler(null);
  }, []);

  // Bootstrap the session once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // `refresh()` already returns the current user alongside the new access
        // token, so a separate `me()` round-trip is unnecessary on bootstrap.
        const { user: current } = await authApi.refresh();
        if (!cancelled && mountedRef.current) {
          setUser(current);
          setStatus('authenticated');
        }
      } catch {
        // No valid refresh cookie (or the server is unreachable): start signed out.
        if (!cancelled && mountedRef.current) {
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Memoize the context value so consumers re-render only when the session
  // actually changes (login / logout are already stable useCallback refs).
  const value = useMemo(
    () => ({ user, status, login, logout, setUser: applyUser }),
    [user, status, login, logout, applyUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * useAuth - read the session context.
 *
 * Throws if used outside an AuthProvider so misuse fails loudly in development.
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
