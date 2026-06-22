import { useEffect, useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { UnsavedChangesPrompt } from '@/components/common/UnsavedChangesPrompt';
import { ApiError } from '@/lib/api/client';
import type { CreateUserInput, Role, UpdateUserInput, User } from '@/lib/api/types';
import { useCreateUser, useUpdateUser } from './useUsers';
import { userFormSchema } from './schemas';

/**
 * UserFormDialog - unified create / edit account dialog (DESIGN.md section 7.3).
 *
 * Driven by react-hook-form + a zod resolver chosen by `mode`. On create the
 * password is required; on edit it is optional ("leave blank to keep") and the
 * fields are prefilled from `user`. Editing the protected super-admin locks the
 * Role select to "Super admin". Submit shows a loading button, disables inputs,
 * focuses the first invalid field on validation failure, and maps server error
 * codes to field errors / toasts. On success it toasts and closes; the roster
 * query is invalidated by the mutation hooks.
 */

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the dialog is in edit mode for this account; otherwise create. */
  user?: User | null;
}

/** Shape backing the form fields (password is always a string in the inputs). */
interface UserFormFields {
  fullName: string;
  email: string;
  role: Role;
  password: string;
}

const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super admin',
  USER: 'User',
};

/** Field focus order, used to focus the first invalid field on submit failure. */
const FIELD_ORDER: (keyof UserFormFields)[] = ['fullName', 'email', 'role', 'password'];

export function UserFormDialog({ open, onOpenChange, user }: UserFormDialogProps) {
  const mode = user ? 'edit' : 'create';
  const isEdit = mode === 'edit';
  // The permanent super-admin cannot be downgraded: lock its role in edit mode.
  const roleLocked = isEdit && Boolean(user?.isProtected);

  const createUser = useCreateUser();
  const updateUser = useUpdateUser();

  // Ref to the first field so we can move initial focus there on open.
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<UserFormFields>({
    // Cast keeps a single field shape while the resolver enforces per-mode rules.
    resolver: zodResolver(userFormSchema(mode)) as never,
    mode: 'onBlur',
    defaultValues: {
      fullName: '',
      email: '',
      role: 'USER',
      password: '',
    },
  });

  // Reset the form whenever the dialog opens so create starts blank and edit
  // prefills from the selected account (and stale errors never linger).
  useEffect(() => {
    if (!open) return;
    reset({
      fullName: user?.fullName ?? '',
      email: user?.email ?? '',
      role: user?.role ?? 'USER',
      password: '',
    });
  }, [open, user, reset]);

  const { ref: fullNameRef, ...fullNameField } = register('fullName');

  // Mutation pending drives the loading / disabled states.
  const submitting = createUser.isPending || updateUser.isPending;

  const onValid = async (values: UserFormFields) => {
    try {
      if (isEdit && user) {
        const input: UpdateUserInput = {
          fullName: values.fullName.trim(),
          email: values.email.trim(),
          // Protected accounts always remain SUPER_ADMIN regardless of the form.
          role: roleLocked ? 'SUPER_ADMIN' : values.role,
        };
        // Only send a password when the operator actually typed a new one.
        if (values.password && values.password.length > 0) {
          input.password = values.password;
        }
        await updateUser.mutateAsync({ id: user.id, input });
        toast.success('Changes saved.');
      } else {
        const input: CreateUserInput = {
          fullName: values.fullName.trim(),
          email: values.email.trim(),
          role: values.role,
          password: values.password,
        };
        await createUser.mutateAsync(input);
        toast.success('User created.');
      }
      onOpenChange(false);
    } catch (error) {
      handleServerError(error);
    }
  };

  /** After a failed validation pass, focus the first field that has an error. */
  const onInvalid = () => {
    const first = FIELD_ORDER.find((name) => errors[name]);
    if (first) setFocus(first);
  };

  /** Map a thrown ApiError to the right field error or toast (DESIGN.md section 7.3). */
  function handleServerError(error: unknown) {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'EMAIL_TAKEN':
          setError('email', { type: 'server', message: 'This email is already in use.' });
          setFocus('email');
          return;
        case 'VALIDATION_ERROR':
          // A general form-level problem: surface it on the first field.
          setError('fullName', {
            type: 'server',
            message: error.message || 'Please check the form and try again.',
          });
          setFocus('fullName');
          return;
        case 'PROTECTED_ROLE':
          toast.error('The super-admin account role cannot be changed.');
          return;
        default:
          toast.error(error.message);
          return;
      }
    }
    toast.error('Something went wrong. Please try again.');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Warn before navigating away from a dialog with unsaved edits. */}
      <UnsavedChangesPrompt when={open && isDirty && !submitting} />
      <DialogContent
        // Move initial focus to the first field instead of the close button.
        // On touch devices, skip this so the soft keyboard does not pop open;
        // let Radix focus the dialog container instead.
        onOpenAutoFocus={(event) => {
          if (window.matchMedia('(pointer: coarse)').matches) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          firstFieldRef.current?.focus();
        }}
        className="overscroll-contain"
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit user' : 'Add user'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this account and save your changes.'
              : 'Create an account that can access the platform.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onValid, onInvalid)} noValidate className="flex flex-col gap-4">
          <Field label="Full name" required error={errors.fullName?.message}>
            <Input
              autoComplete="name"
              spellCheck={false}
              disabled={submitting}
              placeholder="e.g. Katharina Vogel…"
              {...fullNameField}
              ref={(node) => {
                fullNameRef(node);
                firstFieldRef.current = node;
              }}
            />
          </Field>

          <Field label="Email" required error={errors.email?.message}>
            <Input
              type="email"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              disabled={submitting}
              placeholder="name@dive-turbinen.de…"
              {...register('email')}
            />
          </Field>

          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <Field
                label="Role"
                required
                error={errors.role?.message}
                helperText={
                  roleLocked
                    ? 'The super-admin account is permanent and keeps this role.'
                    : undefined
                }
              >
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={submitting || roleLocked}
                >
                  <SelectTrigger aria-label="Role" onBlur={field.onBlur} ref={field.ref}>
                    <SelectValue placeholder="Choose a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SUPER_ADMIN">{ROLE_LABELS.SUPER_ADMIN}</SelectItem>
                    <SelectItem value="USER">{ROLE_LABELS.USER}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          />

          <Field
            label="Password"
            required={!isEdit}
            error={errors.password?.message}
            helperText={isEdit ? 'Leave blank to keep the current password.' : undefined}
          >
            <PasswordInput
              autoComplete="new-password"
              disabled={submitting}
              {...register('password')}
            />
          </Field>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {isEdit ? 'Save changes' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
