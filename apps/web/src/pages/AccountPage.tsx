import { useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { useAuth } from '@/features/auth/AuthProvider';
import { ProfileSection } from '@/features/account/ProfileSection';
import { ChangePasswordSection } from '@/features/account/ChangePasswordSection';

/**
 * AccountPage - self-service account settings for any signed-in user.
 *
 * Reachable from the header user menu (not the primary sidebar, which is for
 * app destinations). Two stacked sections: Profile (read-only email/role +
 * editable name) and Password (change own password). The form column is capped
 * for readability and left-aligned to match the rest of the app shell.
 */
export function AccountPage() {
  const { user } = useAuth();

  // Track each form's dirty state so leaving the page with unsaved edits warns.
  const [profileDirty, setProfileDirty] = useState(false);
  const [passwordDirty, setPasswordDirty] = useState(false);

  // Guarded by RequireAuth; this is a defensive fallback for the brief window
  // before the bootstrapped user is available.
  if (!user) {
    return <FullPageLoader />;
  }

  return (
    <div className="flex flex-col gap-8">
      <UnsavedChangesPrompt when={profileDirty || passwordDirty} />
      <PageHeader title="Account" subtitle="Manage your profile and password." />
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <ProfileSection user={user} onDirtyChange={setProfileDirty} />
        <ChangePasswordSection onDirtyChange={setPasswordDirty} />
      </div>
    </div>
  );
}
