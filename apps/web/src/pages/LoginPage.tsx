import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { useAuth } from '@/features/auth/AuthProvider';
import { ApiError } from '@/lib/api/client';

/**
 * LoginPage - the sign-in screen (DESIGN.md section 7.1).
 *
 * Calm full-height page on the page-bg tint with the faint blueprint ground; a
 * centered card (lg radius) holds the brand lockup, a "Sign in" title, the email
 * and password fields, and one full-width orange CTA. Validation is handled by
 * react-hook-form + zod. States: idle; submitting (button loading + fields
 * disabled); error (an inline role="alert" banner above the fields); success
 * (navigate to the intended path or Home).
 */

const loginSchema = z.object({
  email: z.string().min(1, 'Enter your email address.').email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginValues = z.infer<typeof loginSchema>;

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  // Rejected credentials mark both fields (not one) since the server never says
  // which is wrong. Cleared as soon as the operator edits either field so the
  // danger borders track the live input (DESIGN.md section 7.1).
  const [credentialsInvalid, setCredentialsInvalid] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  const emailField = register('email');
  const passwordField = register('password');

  /** Clear the credentials-error borders the moment the operator starts fixing it. */
  const clearCredentialsError = () => {
    if (credentialsInvalid) setCredentialsInvalid(false);
  };

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setCredentialsInvalid(false);
    try {
      await login(values.email, values.password);
      // Return the user to wherever they were headed before the guard kicked in.
      const target = (location.state as LocationState | null)?.from ?? '/';
      navigate(target, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
        setFormError('Invalid email or password.');
        setCredentialsInvalid(true);
      } else if (error instanceof ApiError && error.code === 'ACCOUNT_DISABLED') {
        // The credentials were correct but the account is disabled: explain why
        // rather than blaming the inputs (no red field borders here).
        setFormError('This account has been disabled. Contact your administrator.');
      } else if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
        setFormError('Unable to reach the server. Check your connection and try again.');
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  });

  return (
    <main className="bg-blueprint flex min-h-[100dvh] flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px] rounded-lg border border-border bg-surface p-8 shadow-md">
        <div className="flex flex-col gap-1">
          <BrandLockup size="md" />
          <h1 className="mt-5 text-2xl font-semibold text-text">Sign in</h1>
          <p className="text-sm text-text-secondary">
            Use your DIVE Turbinen account to continue.
          </p>
        </div>

        {/* Always-present live region so the error is announced reliably; the
            visual banner only renders when there is a message to show. */}
        <div role="alert" aria-live="assertive">
          {formError && (
            <div className="mt-6 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger-tint px-3 py-2.5 text-sm font-medium text-danger">
              <AlertCircle className="mt-px size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span>{formError}</span>
            </div>
          )}
        </div>

        <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
          <Field label="Email" error={errors.email?.message}>
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              spellCheck={false}
              placeholder="name@dive-turbinen.de…"
              disabled={isSubmitting}
              // Union of validation + credentials state so neither clobbers the
              // other (an explicit prop overrides the Field-context wiring).
              aria-invalid={errors.email || credentialsInvalid ? true : undefined}
              {...emailField}
              onChange={(event) => {
                void emailField.onChange(event);
                clearCredentialsError();
              }}
            />
          </Field>

          <Field label="Password" error={errors.password?.message}>
            <PasswordInput
              autoComplete="current-password"
              disabled={isSubmitting}
              aria-invalid={errors.password || credentialsInvalid ? true : undefined}
              {...passwordField}
              onChange={(event) => {
                void passwordField.onChange(event);
                clearCredentialsError();
              }}
            />
          </Field>

          <Button type="submit" className="mt-2 w-full" loading={isSubmitting}>
            Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
