import { Link } from 'react-router-dom';
import { BrandLockup } from '@/components/brand/BrandLockup';
import { MobileNav } from './MobileNav';
import { UserMenu } from './UserMenu';

/**
 * Header - fixed top bar (64px) for the authenticated shell (DESIGN.md section 5).
 *
 * Left: the mobile nav trigger (below lg) plus the brand lockup linking Home.
 * Right: the user menu. Surface background with a bottom hairline; stays a
 * single line. No search in this phase.
 */
export function Header() {
  return (
    <header className="sticky top-0 z-sticky h-16 border-b border-border bg-surface">
      <div className="flex h-full items-center justify-between gap-3 px-4 lg:px-6">
        <div className="flex items-center gap-1">
          <MobileNav />
          <Link
            to="/"
            aria-label="DIVE Turbinen home"
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <BrandLockup size="md" alt="" />
          </Link>
        </div>
        <UserMenu />
      </div>
    </header>
  );
}
