import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { SettingsSection } from './SettingsSection';
import { useChangePassword } from './useAccount';
import { changePasswordSchema, type ChangePasswordFormValues } from './schemas';

/**
 * ChangePasswordSection - self-service password change.
 *
 * Current + new + confirm, each with a show/hide toggle. Validation runs on
 * blur (matching length, confirmation, and new-differs-from-current). On submit
 * a wrong current password maps to a field error on that input; success clears
 * the fields and toasts. The server revokes the user's other sessions on a
 * password change, which the helper line states plainly.
 */

/** Field focus order, used to focus the first invalid field on submit failure. */
const FIELD_ORDER: (keyof ChangePasswordFormValues)[] = [
  'currentPassword',
  'newPassword',
  'confirmPassword',
];

interface ChangePasswordSectionProps {
  /** Reports whether any password field has input (drives the leave guard). */
  onDirtyChange?: (dirty: boolean) => void;
}

export function ChangePasswordSection({ onDirtyChange }: ChangePasswordSectionProps = {}) {
  const changePassword = useChangePassword();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    mode: 'onBlur',
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  // Surface the dirty state to the page-level unsaved-changes guard.
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const submitting = changePassword.isPending;

  const onValid = async (values: ChangePasswordFormValues) => {
    try {
      await changePassword.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Password updated.');
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'INVALID_PASSWORD') {
          setError('currentPassword', { type: 'server', message: 'That password is incorrect.' });
          setFocus('currentPassword');
          return;
        }
        if (error.code === 'VALIDATION_ERROR') {
          setError('newPassword', { type: 'server', message: error.message });
          setFocus('newPassword');
          return;
        }
        toast.error(error.message);
        return;
      }
      toast.error('Something went wrong. Please try again.');
    }
  };

  /** After a failed validation pass, focus the first field that has an error. */
  const onInvalid = () => {
    const first = FIELD_ORDER.find((name) => errors[name]);
    if (first) setFocus(first);
  };

  return (
    <SettingsSection title="Password" description="Change the password you use to sign in.">
      <form onSubmit={handleSubmit(onValid, onInvalid)} noValidate>
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
          <Field label="Current password" error={errors.currentPassword?.message}>
            <PasswordInput
              autoComplete="current-password"
              disabled={submitting}
              {...register('currentPassword')}
            />
          </Field>

          <Field
            label="New password"
            error={errors.newPassword?.message}
            helperText="Use at least 8 characters."
          >
            <PasswordInput
              autoComplete="new-password"
              disabled={submitting}
              {...register('newPassword')}
            />
          </Field>

          <Field label="Confirm new password" error={errors.confirmPassword?.message}>
            <PasswordInput
              autoComplete="new-password"
              disabled={submitting}
              {...register('confirmPassword')}
            />
          </Field>

          <p className="text-xs text-text-secondary">
            Changing your password signs out your other devices.
          </p>
        </div>

        <div className="flex justify-end border-t border-border px-5 py-4 sm:px-6">
          <Button type="submit" loading={submitting}>
            Update password
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
