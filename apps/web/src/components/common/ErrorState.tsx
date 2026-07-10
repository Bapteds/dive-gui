import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * ErrorState - the shared inline "could not load" block with a retry action.
 *
 * One title line, one muted guidance line, and a secondary "Try again" button,
 * on a danger-tinted surface with `role="alert"`. Previously this exact block
 * was duplicated verbatim across Admin / Projects / Templates / Meshing; every
 * list or panel error now renders through this single component.
 */
export interface ErrorStateProps {
  /** What failed, e.g. "We could not load your projects." */
  title: string;
  /** One short recovery line. Defaults to a connection hint. */
  description?: string;
  /** Retry callback; renders the "Try again" button when provided. */
  onRetry?: () => void;
  /** Show the retry button in its loading state. */
  retrying?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  description = 'Check your connection and try again.',
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-5 shrink-0 text-danger"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-text">{title}</p>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      {onRetry && (
        <Button
          type="button"
          variant="secondary"
          onClick={onRetry}
          loading={retrying}
          className="shrink-0"
        >
          Try again
        </Button>
      )}
    </div>
  );
}
