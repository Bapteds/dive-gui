import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RoleBadge } from '@/components/common/RoleBadge';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { User } from '@/lib/api/types';
import { SettingsSection } from './SettingsSection';
import { useUpdateProfile } from './useAccount';
import { profileSchema, type ProfileFormValues } from './schemas';

/**
 * ProfileSection - read-only account identity plus an editable display name.
 *
 * Email and role are shown as a definition list (not disabled inputs) because
 * they are administered through the back office, not self-editable; a muted
 * note states this. Only the full name is editable, with its own Save action
 * that is disabled until the field is dirty. On success the session user is
 * refreshed (so the header avatar/menu update) and the form re-baselines.
 */
interface ProfileSectionProps {
  user: User;
  /** Reports whether the name field has unsaved edits (drives the leave guard). */
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProfileSection({ user, onDirtyChange }: ProfileSectionProps) {
  const updateProfile = useUpdateProfile();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    mode: 'onBlur',
    defaultValues: { fullName: user.fullName },
  });

  // Re-baseline if the session name changes elsewhere (keeps isDirty honest).
  useEffect(() => {
    reset({ fullName: user.fullName });
  }, [user.fullName, reset]);

  // Surface the dirty state to the page-level unsaved-changes guard.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const submitting = updateProfile.isPending;

  const onValid = async (values: ProfileFormValues) => {
    try {
      const { user: updated } = await updateProfile.mutateAsync(values.fullName.trim());
      reset({ fullName: updated.fullName });
      toast.success('Profile updated.');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        setError('fullName', { type: 'server', message: error.message });
        setFocus('fullName');
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <SettingsSection title="Profile" description="Your identity on the platform.">
      <form onSubmit={handleSubmit(onValid)} noValidate>
        <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-text-secondary">Email</dt>
              <dd className="break-words text-sm text-text">{user.email}</dd>
            </div>
            <div className="flex flex-col items-start gap-1.5">
              <dt className="text-xs font-medium text-text-secondary">Role</dt>
              <dd>
                <RoleBadge role={user.role} />
              </dd>
            </div>
          </dl>

          <p className="text-xs text-text-secondary">
            Email and role are managed by your administrator.
          </p>

          <div className="h-px w-full bg-border" aria-hidden="true" />

          <Field label="Full name" error={errors.fullName?.message}>
            <Input
              autoComplete="name"
              spellCheck={false}
              disabled={submitting}
              {...register('fullName')}
            />
          </Field>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-4 sm:px-6">
          <Button type="submit" loading={submitting} disabled={!isDirty}>
            Save changes
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
