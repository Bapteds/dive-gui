import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { User } from '@/lib/api/types';
import { useUpdateUser } from './useUsers';

/**
 * DisableUserDialog - confirmation for disabling an account.
 *
 * Disabling is reversible but consequential: it signs the user out everywhere
 * and blocks future logins until re-enabled, so it is confirmed (re-enabling is
 * a direct, non-destructive action and needs no dialog). Protected / own-account
 * rows can never reach this dialog (their Disable action is guarded), but the
 * matching server error codes are still handled defensively.
 */

interface DisableUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account to disable; null while the dialog is closing. */
  user: User | null;
}

export function DisableUserDialog({ open, onOpenChange, user }: DisableUserDialogProps) {
  const updateUser = useUpdateUser();

  const handleConfirm = async () => {
    if (!user) return;
    try {
      await updateUser.mutateAsync({ id: user.id, input: { isActive: false } });
      toast.success('Account disabled.');
      onOpenChange(false);
    } catch (error) {
      handleServerError(error);
    }
  };

  function handleServerError(error: unknown) {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'PROTECTED_ACCOUNT':
          toast.error('The super-admin account is permanent and cannot be disabled.');
          return;
        case 'SELF_DISABLE_FORBIDDEN':
          toast.error('You cannot disable your own account.');
          return;
        default:
          toast.error(error.message);
          return;
      }
    }
    toast.error('Something went wrong. Please try again.');
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Disable account</AlertDialogTitle>
          <AlertDialogDescription>
            {user ? (
              <>
                Disable {user.fullName} ({user.email})? They will be signed out everywhere and
                cannot log in until you re-enable the account.
              </>
            ) : (
              'They will be signed out everywhere and cannot log in until re-enabled.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={updateUser.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Keep the dialog open during the request so the button can show a
            // spinner and errors can be surfaced without losing context.
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={updateUser.isPending}
            aria-busy={updateUser.isPending || undefined}
          >
            {updateUser.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Disable account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
