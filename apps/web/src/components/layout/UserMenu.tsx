import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleUserRound, LogOut } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RoleBadge } from '@/components/common/RoleBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { toast } from '@/components/ui/sonner';

/**
 * UserMenu - avatar button in the header that opens an account dropdown.
 *
 * The dropdown shows the signed-in user's name, email, role badge, and a
 * "Log out" action. The trigger is an icon-style avatar button with an
 * accessible label. Logout errors surface as a toast but the local session is
 * cleared regardless (handled in AuthProvider.logout).
 */

/** Derive up to two uppercase initials from a full name. */
function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  if (!user) return null;

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      toast.error('Could not reach the server, but you have been signed out.');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className="rounded-full transition-shadow duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          <Avatar>
            <AvatarFallback>{initialsOf(user.fullName)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem]">
        <div className="flex flex-col gap-2 px-2.5 py-2">
          <div className="flex flex-col gap-0.5">
            <p className="truncate text-sm font-medium text-text">{user.fullName}</p>
            <p className="truncate text-xs text-text-secondary">{user.email}</p>
          </div>
          <div>
            <RoleBadge role={user.role} />
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          {/* Navigation -> a real link (keyboard, middle/cmd-click); Radix still closes the menu on select. */}
          <Link to="/account">
            <CircleUserRound strokeWidth={1.75} aria-hidden="true" />
            Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={(event) => {
            // Keep the menu's selection from racing the async logout.
            event.preventDefault();
            void handleLogout();
          }}
          aria-disabled={loggingOut}
        >
          <LogOut strokeWidth={1.75} aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
