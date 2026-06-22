import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * HomePage - the landing surface after sign-in (DESIGN.md section 7.2).
 *
 * Full shell, intentionally blank content: a page header that welcomes the user
 * by name, and a tasteful empty state explaining that the solver-control tools
 * arrive in a later phase. No fake widgets or placeholder charts.
 */
export function HomePage() {
  const { user } = useAuth();
  // Address the user by first name when available, else fall back gracefully.
  const firstName = user?.fullName.trim().split(/\s+/)[0];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Home"
        subtitle={
          firstName
            ? `Welcome back, ${firstName}. Your workspace is ready.`
            : 'Welcome back. Your workspace is ready.'
        }
      />
      <EmptyState
        title="Your workspace is ready."
        description="The solver-control tools for piloting openFOAM runs arrive in a later phase. For now, this is your secure home base."
      />
    </div>
  );
}
