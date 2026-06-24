import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Loader2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { RunStatus } from '@/lib/api/types';

/**
 * Presentation for a run status, shared by the live badge and the history list.
 * Status is conveyed by color + icon + word (never color alone). The palette
 * stays on the brand functional tokens: primary for running, success (green) for
 * converged, the orange accent family for the "ran but did not converge" warning
 * states (text uses --color-cta for AA), danger red for failure.
 */
export interface RunStatusMeta {
  /** Human label shown in the badge / history. */
  label: string;
  /** lucide icon for the status. */
  icon: LucideIcon;
  /** Spin the icon (running only). */
  spin?: boolean;
  /** Badge container classes (border + tinted surface + text). */
  badgeClass: string;
}

export const runStatusMeta: Record<RunStatus, RunStatusMeta> = {
  queued: {
    label: 'Queued',
    icon: Clock,
    badgeClass: 'border-border bg-bg text-text-secondary',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    spin: true,
    badgeClass: 'border-primary/30 bg-primary-tint text-primary',
  },
  converged: {
    label: 'Converged',
    icon: CheckCircle2,
    badgeClass: 'border-success/30 bg-success-tint text-success',
  },
  completed: {
    label: 'Completed',
    icon: AlertTriangle,
    badgeClass: 'border-accent/40 bg-accent-tint text-cta',
  },
  diverged: {
    label: 'Diverged',
    icon: AlertTriangle,
    badgeClass: 'border-accent/40 bg-accent-tint text-cta',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    badgeClass: 'border-danger/30 bg-danger-tint text-danger',
  },
  stopped: {
    label: 'Stopped',
    icon: CircleSlash,
    badgeClass: 'border-border bg-bg text-text-secondary',
  },
};
