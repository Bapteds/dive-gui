import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Gauge,
  Loader2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { Diamond } from '@/components/brand/Diamond';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import type {
  MeshQualityCriterionId,
  MeshQualityGrade,
  MeshQualityMetric,
  MeshQualityResult,
} from '@/lib/api/types';
import { useIsRating, useMeshQualityQuery, useRunMeshQuality } from './useMeshQuality';

/**
 * NotationTab - the "Notation" tab body: rate the case mesh quality.
 *
 * One primary action ("Rate the mesh") runs `checkMesh -allGeometry` server-side;
 * the result is an overall grade (A-E + 0-100) and one graded card per criterion
 * (skewness, non-orthogonality, minimum volume, cell-size uniformity,
 * twisting/folding, aspect ratio, openness), plus the notes and the raw log.
 * The last rating is persisted and re-served on revisit, with its timestamp so
 * a stale rating (mesh changed since) is visible and re-runnable.
 */

/** Display metadata per criterion (labels, one-line meaning, value formatting). */
const CRITERIA: Record<
  MeshQualityCriterionId,
  { label: string; meaning: string; format: (value: number) => string }
> = {
  skewness: {
    label: 'Skewness',
    meaning: 'How far each face centre strays off the cell-centre line (alarm at 4).',
    format: (v) => v.toFixed(2),
  },
  nonOrthogonality: {
    label: 'Non-orthogonality',
    meaning: 'Angle between face normal and cell-centre line (alarm at 70°).',
    format: (v) => `${v.toFixed(1)}°`,
  },
  minVolume: {
    label: 'Minimum volume',
    meaning: 'Smallest cell volume; slivers wreck the time step, negative = inverted.',
    format: (v) => `${v.toExponential(2)} m³`,
  },
  sizeUniformity: {
    label: 'Cell-size uniformity',
    meaning: 'Volume jump between adjacent cells (1 = uniform, alarm below 0.01).',
    format: (v) => v.toFixed(3),
  },
  twisting: {
    label: 'Twisting / folding',
    meaning: 'Face flatness (1 = flat, 0 = butterfly) plus the pyramid fold check.',
    format: (v) => v.toFixed(3),
  },
  aspectRatio: {
    label: 'Aspect ratio',
    meaning: 'Longest over shortest cell dimension (alarm at 1000).',
    format: (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)),
  },
  openness: {
    label: 'Cell openness',
    meaning: 'How far the faces are from closing each cell (machine epsilon is healthy).',
    format: (v) => v.toExponential(1),
  },
};

export function NotationTab({ projectId }: { projectId: string }) {
  const status = useMeshQualityQuery(projectId);
  const run = useRunMeshQuality(projectId);
  // Global (mutation-cache) running flag: survives a tab switch that unmounts
  // this tab, so returning to it cannot launch a second checkMesh run.
  const isRating = useIsRating(projectId);

  // The live run (this session) takes precedence; otherwise the persisted rating.
  const quality = run.data ?? status.data ?? null;

  const handleRun = () => {
    run.mutate(undefined, {
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'Could not rate the mesh.'),
    });
  };

  return (
    <section
      aria-label="Mesh quality rating"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Mesh quality rating</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Grade the case mesh with checkMesh: skewness, orthogonality, volumes, cell-size
            uniformity and twisting, each scored against OpenFOAM’s own alarm levels.
          </p>
        </div>
        <Button
          type="button"
          onClick={handleRun}
          loading={isRating}
          disabled={isRating}
          className="shrink-0"
        >
          <Gauge strokeWidth={1.75} aria-hidden="true" />
          {quality ? 'Re-rate the mesh' : 'Rate the mesh'}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 sm:p-5">
        {isRating ? (
          <RunningState />
        ) : status.isLoading ? (
          <LoadingState />
        ) : !quality ? (
          <NoRatingYet />
        ) : !quality.available ? (
          <UnavailableCard quality={quality} />
        ) : (
          <RatingReport quality={quality} />
        )}
      </div>
    </section>
  );
}

/** The placeholder while checkMesh executes server-side. */
function RunningState() {
  return (
    <div className="grid place-items-center gap-3 py-16 text-center" role="status" aria-live="polite">
      <Loader2
        className="size-6 animate-spin text-primary motion-reduce:animate-none"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-medium text-text">Rating the mesh…</p>
        <p className="mt-1 text-xs text-text-secondary">
          Running checkMesh with every geometry test. This can take a while on a large mesh.
        </p>
      </div>
    </div>
  );
}

/** Skeleton while the persisted rating is being fetched (shape matches the report). */
function LoadingState() {
  return (
    <div
      className="flex animate-pulse flex-col gap-4 motion-reduce:animate-none"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading the last rating…</span>
      <div className="h-24 rounded-md border border-border bg-bg" aria-hidden="true" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="h-28 rounded-md border border-border bg-bg" />
        ))}
      </div>
    </div>
  );
}

/** The empty state before any rating has run. */
function NoRatingYet() {
  return (
    <EmptyState
      variant="inline"
      className="py-16"
      title="No rating yet"
      description="Run the rating to grade the case mesh on skewness, orthogonality, volumes, cell-size uniformity and twisting. checkMesh only reads the mesh - nothing is modified."
    />
  );
}

/** checkMesh is not installed on the server: say so instead of grading nothing. */
function UnavailableCard({ quality }: { quality: MeshQualityResult }) {
  return (
    <div className="rounded-md border border-accent/40 bg-accent-tint p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-cta-hover">
        <TriangleAlert className="size-3.5" strokeWidth={2} aria-hidden="true" />
        checkMesh unavailable
      </h3>
      <p className="mt-2 text-xs text-text">
        The server could not run <code className="font-mono">{quality.command}</code>. Install
        OpenFOAM (or set OPENFOAM_BASHRC) on the API host, then rate again.
      </p>
    </div>
  );
}

/** The full rating report: overall card, criterion grid, notes, raw log. */
function RatingReport({ quality }: { quality: MeshQualityResult }) {
  return (
    <div className="flex flex-col gap-4">
      <OverallCard quality={quality} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {quality.metrics.map((metric) => (
          <CriterionCard key={metric.id} metric={metric} />
        ))}
      </div>

      {quality.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-text-secondary">
          {quality.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5">
              <Diamond className="mt-0.5 size-3 shrink-0 text-neutral" aria-hidden="true" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      <LogDisclosure command={quality.command} log={quality.log} />
    </div>
  );
}

/** Overall grade + verdict + mesh size + when the rating ran. */
function OverallCard({ quality }: { quality: MeshQualityResult }) {
  const stats: Array<[string, number | null]> = [
    ['Cells', quality.cells],
    ['Points', quality.points],
    ['Faces', quality.faces],
  ];
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-bg p-4">
      <GradeBadge grade={quality.overall.grade} size="lg" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text tabular-nums">
          {quality.overall.score !== null ? `${quality.overall.score} / 100` : 'Not graded'}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          Overall quality · rated {formatWhen(quality.ranAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <VerdictChip quality={quality} />
      </div>
      <dl className="ml-auto flex flex-wrap items-center gap-x-6 gap-y-1">
        {stats
          .filter(([, value]) => value !== null)
          .map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-xs text-text-secondary">{label}</dt>
              <dd className="font-mono text-xs text-text tabular-nums">
                {(value as number).toLocaleString('en-US')}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

/** The checkMesh verdict: icon + words, never color alone. */
function VerdictChip({ quality }: { quality: MeshQualityResult }) {
  if (quality.negativeVolumeCells > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-danger-tint px-2 py-1 text-xs font-medium text-danger">
        <XCircle className="size-3.5" strokeWidth={2} aria-hidden="true" />
        {quality.negativeVolumeCells.toLocaleString('en-US')} inverted cell(s)
      </span>
    );
  }
  if (quality.meshOk) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-success-tint px-2 py-1 text-xs font-medium text-success">
        <CheckCircle2 className="size-3.5" strokeWidth={2} aria-hidden="true" />
        Mesh OK
      </span>
    );
  }
  if (quality.failedChecks > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-accent-tint px-2 py-1 text-xs font-medium text-cta-hover">
        <TriangleAlert className="size-3.5" strokeWidth={2} aria-hidden="true" />
        {quality.failedChecks} check(s) flagged
      </span>
    );
  }
  return null;
}

/** One graded criterion: value, meaning, score bar, grade, flag state. */
function CriterionCard({ metric }: { metric: MeshQualityMetric }) {
  const meta = CRITERIA[metric.id];
  const measured = metric.score !== null;
  return (
    <div className={cn('flex flex-col gap-2 rounded-md border border-border bg-bg p-4', !measured && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text">{meta.label}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">{meta.meaning}</p>
        </div>
        <GradeBadge grade={metric.grade} size="sm" />
      </div>

      <p className="font-mono text-sm text-text tabular-nums">
        {metric.value !== null ? meta.format(metric.value) : 'Not measured'}
        {metric.detail && (
          <span className="ml-2 font-sans text-xs text-text-secondary">{metric.detail}</span>
        )}
      </p>

      {measured && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
            <div
              className={cn('h-full rounded-full', barColor(metric.grade))}
              style={{ width: `${Math.max(metric.score as number, 3)}%` }}
            />
          </div>
          <span className="shrink-0 text-xs font-medium text-text-secondary tabular-nums">
            {metric.score}/100
          </span>
        </div>
      )}

      {metric.flagged && (
        <p className="flex items-center gap-1 text-xs font-medium text-danger">
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          Flagged by checkMesh
        </p>
      )}
    </div>
  );
}

/** Letter grade in a tinted square; the letter (not color) carries the meaning. */
function GradeBadge({ grade, size }: { grade: MeshQualityGrade | null; size: 'sm' | 'lg' }) {
  const classes = cn(
    'grid shrink-0 place-items-center rounded-sm font-bold',
    size === 'lg' ? 'size-12 text-2xl' : 'size-7 text-sm',
    grade === null && 'border border-border bg-surface text-text-secondary',
    (grade === 'A' || grade === 'B') && 'bg-success-tint text-success',
    grade === 'C' && 'bg-accent-tint text-cta-hover',
    (grade === 'D' || grade === 'E') && 'bg-danger-tint text-danger',
  );
  return (
    <span className={classes}>
      <span aria-hidden="true">{grade ?? '?'}</span>
      <span className="sr-only">{grade ? `Grade ${grade}` : 'Not graded'}</span>
    </span>
  );
}

/** Score bar fill per grade family (paired with the letter + number next to it). */
function barColor(grade: MeshQualityGrade | null): string {
  if (grade === 'A' || grade === 'B') return 'bg-success';
  if (grade === 'C') return 'bg-accent';
  return 'bg-danger';
}

/** The raw checkMesh output, collapsed by default. */
function LogDisclosure({ command, log }: { command: string; log: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs font-medium text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        {open ? (
          <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden="true" />
        )}
        {open ? 'Hide checkMesh log' : 'Show checkMesh log'}
      </button>
      {open && (
        <div className="border-t border-border">
          <div
            tabIndex={0}
            className="max-h-64 overflow-auto overscroll-contain px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
          >
            <p className="mb-1.5 font-mono text-xs text-text-secondary" translate="no">
              $ {command}
            </p>
            {log.trim().length > 0 ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text" translate="no">
                {log}
              </pre>
            ) : (
              <p className="text-xs text-text-secondary">No output.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "16 Jul 2026, 15:04" from an ISO timestamp (falls back to the raw string). */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
