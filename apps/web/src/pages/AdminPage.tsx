import { useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import { ApiError } from '@/lib/api/client';
import type { User } from '@/lib/api/types';
import { useUpdateUser, useUsersQuery } from '@/features/admin/useUsers';
import { UsersTable } from '@/features/admin/UsersTable';
import { UsersTableSkeleton } from '@/features/admin/UsersTableSkeleton';
import { UserFormDialog } from '@/features/admin/UserFormDialog';
import { DeleteUserDialog } from '@/features/admin/DeleteUserDialog';
import { DisableUserDialog } from '@/features/admin/DisableUserDialog';

/**
 * AdminPage - account management back office (DESIGN.md section 7.3).
 *
 * Guarded to super-admins by the router. Orchestrates the roster query and the
 * create / edit / delete dialogs, and renders the four table states: loading
 * (skeleton rows), error (inline retry block), empty (invite to add the first
 * account), and data (the users table). The single orange CTA for the zone is
 * the header "Add user" button; the dialog primary actions are the single
 * primary within their own dialog.
 */
export function AdminPage() {
  const { user } = useAuth();
  const { data: users, isPending, isError, refetch, isRefetching } = useUsersQuery();

  // Create / edit dialog state. `editingUser` null => create mode.
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // Delete confirmation state. `deletingUser` holds the targeted account.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);

  // Disable confirmation state. `disablingUser` holds the targeted account.
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablingUser, setDisablingUser] = useState<User | null>(null);

  const updateUser = useUpdateUser();

  const openCreate = () => {
    setEditingUser(null);
    setFormOpen(true);
  };

  const openEdit = (target: User) => {
    setEditingUser(target);
    setFormOpen(true);
  };

  const openDelete = (target: User) => {
    setDeletingUser(target);
    setDeleteOpen(true);
  };

  /**
   * Disabling is confirmed in a dialog (it revokes sessions); re-enabling is a
   * direct, non-destructive action with a success toast.
   */
  const toggleActive = async (target: User) => {
    if (target.isActive) {
      setDisablingUser(target);
      setDisableOpen(true);
      return;
    }
    try {
      await updateUser.mutateAsync({ id: target.id, input: { isActive: true } });
      toast.success('Account enabled.');
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  };

  const addUserButton = (
    <Button type="button" onClick={openCreate}>
      Add user
    </Button>
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Administration"
        subtitle="Manage who can access the platform."
        action={addUserButton}
      />

      {isPending ? (
        <UsersTableSkeleton />
      ) : isError ? (
        <ErrorState
          title="We could not load the accounts."
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : users.length === 0 ? (
        <EmptyState
          title="No users yet."
          description="Add the first account."
          action={addUserButton}
        />
      ) : (
        <UsersTable
          users={users}
          currentUserId={user?.id ?? ''}
          onEdit={openEdit}
          onDelete={openDelete}
          onToggleActive={toggleActive}
        />
      )}

      <UserFormDialog open={formOpen} onOpenChange={setFormOpen} user={editingUser} />
      <DeleteUserDialog open={deleteOpen} onOpenChange={setDeleteOpen} user={deletingUser} />
      <DisableUserDialog open={disableOpen} onOpenChange={setDisableOpen} user={disablingUser} />
    </div>
  );
}
