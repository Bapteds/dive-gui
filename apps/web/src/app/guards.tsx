import { Link, Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/AuthProvider';
import type { Role } from '@/lib/api/types';

/**
 * guards.tsx - route guards for the protected branch.
 *
 *  - RequireAuth: while the session is bootstrapping ('loading') show the full
 *    page loader; if unauthenticated redirect to /login preserving the intended
 *    path in location state; otherwise render the protected tree.
 *  - RequireRole: render only for users with the required role; others get a
 *    clean 403 view with a way back Home (no silent redirect-to-nowhere).
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageLoader />;
  }

  if (status === 'unauthenticated') {
    // Preserve where the user was headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

/**
 * RedirectIfAuthenticated - public-route guard for /login.
 *
 * While bootstrapping show the loader; if already signed in, send the user to
 * the intended path (or Home) instead of showing the login form again.
 */
export function RedirectIfAuthenticated({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <FullPageLoader />;
  }

  if (status === 'authenticated') {
    const target = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={target} replace />;
  }

  return <>{children}</>;
}

export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { user } = useAuth();

  if (user?.role !== role) {
    return <Forbidden />;
  }

  return <>{children}</>;
}

/** A calm 403 view rendered inside the shell when a role check fails. */
function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="grid size-12 place-items-center rounded-md bg-danger-tint">
        <ShieldAlert className="size-6 text-danger" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <h1 className="text-2xl font-semibold text-text">Access restricted</h1>
        <p className="text-sm text-text-secondary">
          You do not have permission to view this page. If you think this is a mistake, contact a
          platform administrator.
        </p>
      </div>
      <Button asChild variant="secondary">
        <Link to="/">Back to Home</Link>
      </Button>
    </div>
  );
}
