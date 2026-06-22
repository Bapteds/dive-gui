import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { User } from '@/lib/api/types';
import { UsersTable } from './UsersTable';

/**
 * UsersTable guard tests.
 *
 * Verifies the visible action guards required by DESIGN.md section 7.3:
 *  - the protected super-admin row cannot be deleted or disabled (guarded),
 *  - a normal account row can be deleted / disabled (enabled, fires handler),
 *  - the signed-in operator's own row cannot be deleted or disabled (guarded),
 *  - a disabled account exposes an (always allowed) Enable action.
 * Guarded actions use `aria-disabled="true"` (instead of the native attribute)
 * so they stay keyboard-reachable for their explanatory tooltip; the assertions
 * check that state plus the no-op click behavior.
 */

const protectedAdmin: User = {
  id: 'admin-1',
  email: 'admin@dive-turbinen.de',
  fullName: 'Katharina Vogel',
  role: 'SUPER_ADMIN',
  isProtected: true,
  isActive: true,
  lastLoginAt: '2026-06-20T08:15:00.000Z',
  createdAt: '2026-01-04T09:00:00.000Z',
  updatedAt: '2026-01-04T09:00:00.000Z',
};

const selfUser: User = {
  id: 'self-1',
  email: 'lukas.brandt@dive-turbinen.de',
  fullName: 'Lukas Brandt',
  role: 'SUPER_ADMIN',
  isProtected: false,
  isActive: true,
  lastLoginAt: '2026-06-19T17:40:00.000Z',
  createdAt: '2026-02-11T13:30:00.000Z',
  updatedAt: '2026-02-11T13:30:00.000Z',
};

const normalUser: User = {
  id: 'user-1',
  email: 'mara.henning@dive-turbinen.de',
  fullName: 'Mara Henning',
  role: 'USER',
  isProtected: false,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-03-22T08:15:00.000Z',
  updatedAt: '2026-03-22T08:15:00.000Z',
};

const disabledUser: User = {
  id: 'user-2',
  email: 'jonas.keller@dive-turbinen.de',
  fullName: 'Jonas Keller',
  role: 'USER',
  isProtected: false,
  isActive: false,
  lastLoginAt: '2026-05-02T10:05:00.000Z',
  createdAt: '2026-04-01T08:00:00.000Z',
  updatedAt: '2026-04-10T08:00:00.000Z',
};

function renderTable(overrides: Partial<Record<'onDelete' | 'onToggleActive', () => void>> = {}) {
  const onEdit = vi.fn();
  const onDelete = overrides.onDelete ?? vi.fn();
  const onToggleActive = overrides.onToggleActive ?? vi.fn();
  render(
    <TooltipProvider>
      <UsersTable
        users={[protectedAdmin, selfUser, normalUser, disabledUser]}
        currentUserId={selfUser.id}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggleActive={onToggleActive}
      />
    </TooltipProvider>,
  );
  return { onEdit, onDelete, onToggleActive };
}

describe('UsersTable delete guards', () => {
  it('guards the protected super-admin row from deletion', () => {
    renderTable();
    const deleteBtn = screen.getByRole('button', { name: `Delete ${protectedAdmin.fullName}` });
    expect(deleteBtn).toHaveAttribute('aria-disabled', 'true');
    // Guarded controls stay in the tab order so the tooltip is reachable.
    expect(deleteBtn).not.toBeDisabled();
  });

  it("guards the operator's own row from deletion", () => {
    renderTable();
    const deleteBtn = screen.getByRole('button', { name: `Delete ${selfUser.fullName}` });
    expect(deleteBtn).toHaveAttribute('aria-disabled', 'true');
  });

  it('allows deleting a normal account and fires the handler', () => {
    const { onDelete } = renderTable();
    const deleteBtn = screen.getByRole('button', { name: `Delete ${normalUser.fullName}` });
    expect(deleteBtn).not.toHaveAttribute('aria-disabled');
    expect(deleteBtn).toBeEnabled();
    deleteBtn.click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(normalUser);
  });

  it('does not fire delete for a guarded row when clicked', () => {
    const { onDelete } = renderTable();
    screen.getByRole('button', { name: `Delete ${protectedAdmin.fullName}` }).click();
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe('UsersTable disable / enable action', () => {
  it('guards the protected super-admin row from being disabled', () => {
    renderTable();
    const disableBtn = screen.getByRole('button', { name: `Disable ${protectedAdmin.fullName}` });
    expect(disableBtn).toHaveAttribute('aria-disabled', 'true');
  });

  it("guards the operator's own row from being disabled", () => {
    renderTable();
    const disableBtn = screen.getByRole('button', { name: `Disable ${selfUser.fullName}` });
    expect(disableBtn).toHaveAttribute('aria-disabled', 'true');
  });

  it('allows disabling a normal active account and fires the handler', () => {
    const { onToggleActive } = renderTable();
    const disableBtn = screen.getByRole('button', { name: `Disable ${normalUser.fullName}` });
    expect(disableBtn).toBeEnabled();
    disableBtn.click();
    expect(onToggleActive).toHaveBeenCalledWith(normalUser);
  });

  it('exposes an Enable action for a disabled account', () => {
    const { onToggleActive } = renderTable();
    const enableBtn = screen.getByRole('button', { name: `Enable ${disabledUser.fullName}` });
    expect(enableBtn).toBeEnabled();
    enableBtn.click();
    expect(onToggleActive).toHaveBeenCalledWith(disabledUser);
  });
});

describe('UsersTable presentation', () => {
  it('shows the active / disabled status for each account', () => {
    renderTable();
    // Three active accounts + one disabled.
    expect(screen.getAllByText('Active')).toHaveLength(3);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('renders sortable column headers with an initial unsorted state', () => {
    renderTable();
    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  });
});
