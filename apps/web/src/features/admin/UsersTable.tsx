import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Pencil,
  Search,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RoleBadge } from '@/components/common/RoleBadge';
import { StatusBadge } from '@/components/common/StatusBadge';
import { cn } from '@/lib/utils';
import type { User } from '@/lib/api/types';

/**
 * UsersTable - the account roster table (DESIGN.md sections 6 and 7.3).
 *
 * Columns: Name, Email, Role, Status, Last login, Created, Actions. Rows
 * separate with hairlines (no zebra), highlight on hover, and use tabular
 * figures for dates. A search box filters by name + email; column headers sort
 * with `aria-sort`. Row actions (Edit, Disable/Enable, Delete) are ghost icon
 * buttons; guarded actions use `aria-disabled` + an onClick no-op (instead of
 * the native `disabled` attribute) so the explanatory Tooltip still appears and
 * the control stays in the tab order:
 *  - the protected super-admin cannot be removed or disabled, and
 *  - the operator cannot delete or disable their own account.
 * Created hides below `md` and Last login below `lg` so the table never forces
 * horizontal scroll on a 375px viewport.
 */

interface UsersTableProps {
  users: User[];
  /** Id of the signed-in operator, used to guard self-targeted actions. */
  currentUserId: string;
  onEdit: (user: User) => void;
  onDelete: (user: User) => void;
  /** Toggle an account's active status (disable when active, enable when not). */
  onToggleActive: (user: User) => void;
}

/** Sortable column keys. */
type SortKey = 'fullName' | 'email' | 'role' | 'isActive' | 'lastLoginAt' | 'createdAt';
type SortDirection = 'asc' | 'desc';
interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/** Stable formatter for date columns (e.g. "07 Jun 2026"). */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : dateFormatter.format(date);
}

/** Compare two users by the active sort key (nulls/never sort last on asc). */
function compareUsers(a: User, b: User, key: SortKey): number {
  switch (key) {
    case 'fullName':
      return a.fullName.localeCompare(b.fullName);
    case 'email':
      return a.email.localeCompare(b.email);
    case 'role':
      // SUPER_ADMIN sorts before USER on ascending.
      return a.role.localeCompare(b.role);
    case 'isActive':
      // Active (true) before disabled (false) on ascending.
      return Number(b.isActive) - Number(a.isActive);
    case 'lastLoginAt':
    case 'createdAt': {
      const av = a[key];
      const bv = b[key];
      // "Never" (null) always sorts to the bottom regardless of direction sign;
      // it is re-flipped with the rest below, which is acceptable for this view.
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return new Date(av).getTime() - new Date(bv).getTime();
    }
    default:
      return 0;
  }
}

export function UsersTable({
  users,
  currentUserId,
  onEdit,
  onDelete,
  onToggleActive,
}: UsersTableProps) {
  const [query, setQuery] = useState('');
  // No sort selected => preserve the server order (protected super-admin first).
  const [sort, setSort] = useState<SortState | null>(null);

  const visibleUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? users.filter(
          (user) =>
            user.fullName.toLowerCase().includes(needle) ||
            user.email.toLowerCase().includes(needle),
        )
      : users;

    if (!sort) return filtered;
    const sorted = [...filtered].sort((a, b) => compareUsers(a, b, sort.key));
    return sort.direction === 'desc' ? sorted.reverse() : sorted;
  }, [users, query, sort]);

  /** Toggle the sort: first click ascending, second descending, on the same key. */
  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const ariaSortFor = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort?.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  /** A header cell whose label is a button that sorts the column. */
  const SortableHead = ({
    sortKey,
    children,
    className,
  }: {
    sortKey: SortKey;
    children: React.ReactNode;
    className?: string;
  }) => {
    const state = ariaSortFor(sortKey);
    const Icon =
      state === 'ascending' ? ChevronUp : state === 'descending' ? ChevronDown : ChevronsUpDown;
    return (
      <TableHead scope="col" aria-sort={state} className={className}>
        <button
          type="button"
          onClick={() => toggleSort(sortKey)}
          className={cn(
            'group -mx-2 inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-left',
            'transition-colors duration-fast ease-out hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
          )}
        >
          {children}
          <Icon
            className={cn('size-3.5', state === 'none' && 'text-neutral')}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </button>
      </TableHead>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <Input
            type="search"
            name="user-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search name or email…"
            aria-label="Search accounts by name or email"
            className="pl-9"
          />
        </div>
        <p className="shrink-0 text-sm text-text-secondary" aria-live="polite">
          {visibleUsers.length} of {users.length}
        </p>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-bg">
              <SortableHead sortKey="fullName">Name</SortableHead>
              <SortableHead sortKey="email">Email</SortableHead>
              <SortableHead sortKey="role">Role</SortableHead>
              <SortableHead sortKey="isActive">Status</SortableHead>
              <SortableHead sortKey="lastLoginAt" className="hidden lg:table-cell">
                Last login
              </SortableHead>
              <SortableHead sortKey="createdAt" className="hidden md:table-cell">
                Created
              </SortableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleUsers.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-10 text-center text-sm text-text-secondary">
                  No accounts match &ldquo;{query.trim()}&rdquo;.
                </TableCell>
              </TableRow>
            ) : (
              visibleUsers.map((user) => {
                const isSelf = user.id === currentUserId;
                const isProtected = user.isProtected;
                const deleteGuardReason = isProtected
                  ? 'The super-admin account is permanent and cannot be removed or disabled.'
                  : isSelf
                    ? 'You cannot delete your own account.'
                    : null;
                const disableGuardReason = isProtected
                  ? 'The super-admin account is permanent and cannot be removed or disabled.'
                  : isSelf
                    ? 'You cannot disable your own account.'
                    : null;

                return (
                  <TableRow key={user.id} className={cn(isSelf && 'bg-primary-tint/40')}>
                    <TableCell className="font-medium text-text">{user.fullName}</TableCell>
                    <TableCell className="min-w-0 text-text-secondary">
                      <span className="break-words">{user.email}</span>
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge active={user.isActive} />
                    </TableCell>
                    <TableCell className="hidden text-text-secondary tabular-nums lg:table-cell">
                      {user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Never'}
                    </TableCell>
                    <TableCell className="hidden text-text-secondary tabular-nums md:table-cell">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${user.fullName}`}
                          onClick={() => onEdit(user)}
                        >
                          <Pencil strokeWidth={1.75} aria-hidden="true" />
                        </Button>

                        <GuardedIconButton
                          label={`${user.isActive ? 'Disable' : 'Enable'} ${user.fullName}`}
                          guardReason={user.isActive ? disableGuardReason : null}
                          onActivate={() => onToggleActive(user)}
                        >
                          {user.isActive ? (
                            <UserX strokeWidth={1.75} aria-hidden="true" />
                          ) : (
                            <UserCheck strokeWidth={1.75} aria-hidden="true" />
                          )}
                        </GuardedIconButton>

                        <GuardedIconButton
                          label={`Delete ${user.fullName}`}
                          guardReason={deleteGuardReason}
                          onActivate={() => onDelete(user)}
                          destructive
                        >
                          <Trash2 strokeWidth={1.75} aria-hidden="true" />
                        </GuardedIconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * A ghost icon button that is either active or guarded. When `guardReason` is
 * set the control becomes `aria-disabled` (still focusable) and a Tooltip
 * explains why; otherwise it fires `onActivate`. Destructive actions adopt the
 * danger hover treatment.
 */
function GuardedIconButton({
  label,
  guardReason,
  onActivate,
  destructive,
  children,
}: {
  label: string;
  guardReason: string | null;
  onActivate: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  if (guardReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled (not the native attribute) keeps the button focusable
              so the tooltip and keyboard users can reach the explanation. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-disabled="true"
            className="text-neutral hover:bg-transparent hover:text-neutral"
            onClick={(event) => event.preventDefault()}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{guardReason}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      className={cn(
        destructive
          ? 'text-text-secondary hover:bg-danger-tint hover:text-danger'
          : 'text-text-secondary hover:bg-bg hover:text-text',
      )}
      onClick={onActivate}
    >
      {children}
    </Button>
  );
}
