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
import { useDeleteUser } from './useUsers';

/**
 * DeleteUserDialog - destructive confirmation for removing an account
 * (DESIGN.md section 7.3).
 *
 * Names the account being removed, confirms with a destructive button (the
 * pre-styled AlertDialog action) and a secondary cancel. The confirm click is
 * intercepted so the dialog stays open during the request and the button shows
 * a spinner; on success it toasts and closes (the roster query re-fetches via
 * the mutation hook). Protected / own-account rows can never open this dialog
 * (their Delete action is guarded), but the matching server error codes are
 * still handled defensively.
 */

interface DeleteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account to delete; null while the dialog is closing. */
  user: User | null;
}

export function DeleteUserDialog({ open, onOpenChange, user }: DeleteUserDialogProps) {
  const deleteUser = useDeleteUser();

  const handleConfirm = async () => {
    if (!user) return;
    try {
      await deleteUser.mutateAsync(user.id);
      toast.success('User deleted.');
      onOpenChange(false);
    } catch (error) {
      handleServerError(error);
    }
  };

  /** Map a thrown ApiError to a clear toast message (DESIGN.md section 7.3). */
  function handleServerError(error: unknown) {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'PROTECTED_ACCOUNT':
          toast.error('The super-admin account is permanent and cannot be removed.');
          return;
        case 'SELF_DELETE_FORBIDDEN':
          toast.error('You cannot delete your own account.');
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
          <AlertDialogTitle>Delete user</AlertDialogTitle>
          <AlertDialogDescription>
            {user ? (
              <>
                Delete {user.fullName} ({user.email})? This action cannot be undone.
              </>
            ) : (
              'This action cannot be undone.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteUser.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Keep the dialog open during the request so the button can show a
            // spinner and errors can be surfaced without losing context.
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={deleteUser.isPending}
            aria-busy={deleteUser.isPending || undefined}
          >
            {deleteUser.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Delete user
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
