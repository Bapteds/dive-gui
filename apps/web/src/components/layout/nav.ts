import { FolderKanban, Home, LayoutTemplate, Users, type LucideIcon } from 'lucide-react';
import type { Role } from '@/lib/api/types';

/**
 * nav.ts - the authenticated navigation model.
 *
 * Single source of truth for sidebar / mobile-nav items so the desktop sidebar
 * and the mobile slide-over never drift. Items can declare a required role;
 * `visibleNavItems` filters by the current user's role (Home is always shown,
 * Administration is super-admin only).
 */
export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** When set, the item is only shown to users with this role. */
  requiredRole?: Role;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: '/', icon: Home },
  { label: 'Projects', to: '/projects', icon: FolderKanban },
  { label: 'Templates', to: '/templates', icon: LayoutTemplate },
  { label: 'Administration', to: '/admin', icon: Users, requiredRole: 'SUPER_ADMIN' },
];

/** Return the nav items visible to a user with the given role. */
export function visibleNavItems(role: Role | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.requiredRole || item.requiredRole === role);
}
