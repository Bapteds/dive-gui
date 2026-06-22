import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Diamond } from '@/components/brand/Diamond';
import { useAuth } from '@/features/auth/AuthProvider';
import { visibleNavItems } from './nav';

/**
 * Sidebar - fixed left navigation (240px) for desktop (DESIGN.md section 5).
 *
 * Vertical nav with icon + label. The active item gets a primary-tint
 * background, primary text/icon, a 6px primary diamond marker at the left edge,
 * and `aria-current="page"`. Hover is the page-bg tint. Rendered only at
 * >= 1024px; below that the MobileNav slide-over takes over.
 */
export function Sidebar() {
  const { user } = useAuth();
  const items = visibleNavItems(user?.role);

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">
      <nav aria-label="Primary" className="flex flex-col gap-1 p-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              // `end` keeps Home from matching every nested route.
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-sm px-3 py-2 text-sm font-medium',
                  'transition-colors duration-fast ease-out',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
                  isActive
                    ? 'bg-primary-tint text-primary'
                    : 'text-text-secondary hover:bg-bg hover:text-text',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* 6px diamond marker at the left edge of the active item. */}
                  <span className="absolute left-0 top-1/2 -translate-y-1/2" aria-hidden="true">
                    {isActive && <Diamond size={6} className="text-primary" />}
                  </span>
                  <Icon
                    className={cn('size-[1.125rem] shrink-0', isActive ? 'text-primary' : '')}
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
