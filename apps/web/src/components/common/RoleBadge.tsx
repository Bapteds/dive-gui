import { Badge } from '@/components/ui/badge';
import { Diamond } from '@/components/brand/Diamond';
import type { Role } from '@/lib/api/types';

/**
 * RoleBadge - semantic badge for a user's role (DESIGN.md section 6).
 *
 *  - SUPER_ADMIN: primary-tint badge with a tiny diamond glyph.
 *  - USER:        neutral outline badge.
 * The diamond is the only glyph used here; it reinforces the brand language for
 * the elevated role without relying on color alone (the label carries meaning).
 */
export interface RoleBadgeProps {
  role: Role;
}

export function RoleBadge({ role }: RoleBadgeProps) {
  if (role === 'SUPER_ADMIN') {
    return (
      <Badge variant="primary">
        <Diamond size={9} className="text-primary" />
        Super admin
      </Badge>
    );
  }
  return <Badge variant="neutral">User</Badge>;
}
