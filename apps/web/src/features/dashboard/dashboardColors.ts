import type { RunStatus } from '@/lib/api/types';

/**
 * Dashboard palette, mapped onto the brand tokens (never raw hex). The imported
 * "command center" design used a brighter blue / purple / green / orange set; each
 * is mapped here to the DIVE brand scale so the dashboard keeps the design's look
 * while staying on-brand (blue primary, orange accent, green success, grey neutral).
 */
export const TONE = {
  primary: 'var(--color-primary)',
  primaryLight: 'var(--color-primary-light)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  neutral: 'var(--color-neutral)',
} as const;

/** Usage colour by health: blue (calm) -> orange (busy) -> red (saturated). */
export function usageColor(pct: number): string {
  if (pct >= 90) return TONE.danger;
  if (pct >= 75) return TONE.accent;
  return TONE.primary;
}

/** Per-status stroke/fill colour (CSS var) for dots, donuts, and bars. */
export const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  queued: TONE.neutral,
  running: TONE.primaryLight,
  converged: TONE.success,
  completed: TONE.primary,
  diverged: TONE.accent,
  failed: TONE.danger,
  stopped: TONE.neutral,
};

/** Per-status pill classes (Tailwind brand tokens) for status chips. */
export const RUN_STATUS_PILL: Record<RunStatus, string> = {
  queued: 'bg-bg text-text-secondary',
  running: 'bg-primary-tint text-primary',
  converged: 'bg-success-tint text-success',
  completed: 'bg-primary-tint text-primary',
  diverged: 'bg-accent-tint text-accent',
  failed: 'bg-danger-tint text-danger',
  stopped: 'bg-bg text-text-secondary',
};
