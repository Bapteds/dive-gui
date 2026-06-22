import { useEffect, useState } from 'react';
import { useLocation, NavLink } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { Diamond } from '@/components/brand/Diamond';
import { useAuth } from '@/features/auth/AuthProvider';
import { visibleNavItems } from './nav';

/**
 * MobileNav - the sidebar as a slide-over for < 1024px (DESIGN.md section 5).
 *
 * A `Menu`-triggered Radix Dialog panel that slides in from the left, holding
 * the same nav items as the desktop sidebar. It closes automatically on route
 * change and is fully keyboard accessible (focus trap + Esc from Radix). Hidden
 * at >= 1024px where the persistent sidebar is shown.
 */
export function MobileNav() {
  const { user } = useAuth();
  const items = visibleNavItems(user?.role);
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Close the panel whenever navigation occurs.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="Open navigation menu"
          className={cn(
            'grid size-10 place-items-center rounded-sm text-text-secondary lg:hidden',
            'transition-colors duration-fast ease-out hover:bg-bg hover:text-text',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
          )}
        >
          <Menu className="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-overlay bg-scrim lg:hidden',
            'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 left-0 z-modal flex w-[17rem] max-w-[85vw] flex-col border-r border-border bg-surface shadow-lg lg:hidden',
            'focus:outline-none',
            'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
          )}
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <div className="flex h-16 items-center justify-between border-b border-border px-4">
            <BrandLockup size="sm" />
            <DialogPrimitive.Close
              aria-label="Close navigation menu"
              className={cn(
                'grid size-9 place-items-center rounded-sm text-text-secondary',
                'transition-colors duration-fast ease-out hover:bg-bg hover:text-text',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
              )}
            >
              <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <nav aria-label="Primary" className="flex flex-col gap-1 p-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm font-medium',
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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
