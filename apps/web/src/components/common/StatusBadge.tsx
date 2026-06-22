import { CircleCheck, CircleSlash } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * StatusBadge - account active / disabled status (DESIGN.md section 6).
 *
 * Pairs an icon with text so the state never relies on color alone:
 *  - active:   muted success surface + "Active".
 *  - disabled: neutral surface + "Disabled" (an intentional state, not an error,
 *              so it is neutral rather than danger-colored).
 */
export interface StatusBadgeProps {
  active: boolean;
}

export function StatusBadge({ active }: StatusBadgeProps) {
  if (active) {
    return (
      <Badge variant="success">
        <CircleCheck className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        Active
      </Badge>
    );
  }
  return (
    <Badge variant="neutral">
      <CircleSlash className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      Disabled
    </Badge>
  );
}
