import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { cn } from '@/lib/utils';
import { useChamberSavesQuery } from '@/features/chamber/useChamberSaves';
import { StudyCreateForm } from './StudyCreateForm';
import { StudyPanel, StudyStatusBadge } from './StudyPanel';
import { isStudyActive, useStudiesQuery, useStudyQuery, useStudySetupQuery } from './useStudies';

/**
 * OptimisationTab - the project's "Optimisation" tab (WS-H, spec
 * 2026-09-29-optimisation-loop-design §0): optimisation studies that search
 * chamber designs minimising head loss and vortex in THIS project (each
 * evaluation replaces the case mesh and solves here). Left: the project's
 * studies; right: the shown study, or the inline creation / edit form.
 *
 * Visual contract: brain/design/design-system.md sections 2, 4 and 6.
 */

interface OptimisationTabProps {
  projectId: string;
  /** Switch the project page to the Solver tab (live residuals of the current solve). */
  onOpenSolver?: () => void;
}

type Mode = { kind: 'view' } | { kind: 'create' } | { kind: 'edit'; studyId: string };

export function OptimisationTab({ projectId, onOpenSolver }: OptimisationTabProps) {
  const studies = useStudiesQuery(projectId);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const formOpen = mode.kind !== 'view';
  const setup = useStudySetupQuery(projectId, formOpen);
  const saves = useChamberSavesQuery();

  const list = studies.data ?? [];
  const shownId =
    pickedId && list.some((s) => s.id === pickedId)
      ? pickedId
      : (list.find((s) => isStudyActive(s.status))?.id ?? list[0]?.id ?? null);
  const detail = useStudyQuery(projectId, shownId);

  if (studies.isPending) return <OptimisationSkeleton />;
  if (studies.isError) {
    return (
      <ErrorState
        title="We could not load the optimisation studies."
        onRetry={() => void studies.refetch()}
        retrying={studies.isFetching}
      />
    );
  }

  const editing =
    mode.kind === 'edit' && detail.data?.study.id === mode.studyId ? detail.data.study : undefined;

  const form = formOpen ? (
    setup.isPending || saves.isPending ? (
      <div
        className="flex flex-col gap-3 rounded-md border border-border bg-surface p-5"
        role="status"
        aria-label="Loading the study form"
      >
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    ) : setup.isError || !setup.data ? (
      <ErrorState
        title="We could not load the study setup."
        onRetry={() => void setup.refetch()}
        retrying={setup.isFetching}
      />
    ) : (
      <StudyCreateForm
        key={mode.kind === 'edit' ? mode.studyId : 'new'}
        projectId={projectId}
        setup={setup.data}
        saves={saves.data ?? []}
        study={editing}
        onDone={(study) => {
          setPickedId(study.id);
          setMode({ kind: 'view' });
        }}
        onCancel={() => setMode({ kind: 'view' })}
      />
    )
  ) : null;

  return (
    <div data-tab-root className="flex w-full flex-col gap-5 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-[-0.01em] text-text">Optimisation</h2>
          <p className="max-w-[75ch] text-sm text-text-secondary">
            Searches chamber designs around a base design that lower the head loss and the vortex
            metric, by building, meshing and solving each one in this project.
          </p>
        </div>
        {list.length > 0 && !formOpen && (
          <Button type="button" variant="secondary" onClick={() => setMode({ kind: 'create' })}>
            <Plus strokeWidth={1.75} aria-hidden="true" />
            New study
          </Button>
        )}
      </div>

      {list.length === 0 && !formOpen ? (
        <section className="rounded-md border border-border bg-surface">
          <EmptyState
            variant="inline"
            title="No optimisation study yet"
            description="Pick a base design and the parameters to vary; each design is built, meshed and solved here."
            action={
              <Button type="button" onClick={() => setMode({ kind: 'create' })}>
                <Plus strokeWidth={1.75} aria-hidden="true" />
                New study
              </Button>
            }
          />
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
          {list.length > 0 && (
            <section
              aria-labelledby="studies-title"
              className="h-fit rounded-md border border-border bg-surface lg:max-h-full lg:overflow-auto lg:overscroll-contain"
            >
              <h3
                id="studies-title"
                className="sticky top-0 border-b border-border bg-surface px-4 py-3 text-sm font-semibold text-text"
              >
                Studies{' '}
                <span className="font-normal tabular-nums text-text-secondary">{list.length}</span>
              </h3>
              <ul className="divide-y divide-border">
                {list.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedId(s.id);
                        setMode({ kind: 'view' });
                      }}
                      aria-current={s.id === shownId && !formOpen ? 'true' : undefined}
                      className={cn(
                        'flex w-full scroll-mt-12 flex-col items-start gap-1.5 px-4 py-3 text-left text-sm transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring',
                        s.id === shownId && !formOpen && 'bg-primary-tint',
                      )}
                    >
                      <span className="break-words font-medium text-text">{s.name}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-text-secondary">
                        <StudyStatusBadge status={s.status} />
                        {s.counted} / {s.maxEvaluations}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div
            className={cn(
              'flex min-w-0 flex-col gap-6 lg:min-h-0 lg:overflow-auto lg:overscroll-contain',
              list.length === 0 && 'lg:col-span-2',
            )}
          >
            {form ??
              (detail.isPending ? (
                <Skeleton className="h-96 w-full rounded-md" />
              ) : detail.isError || !detail.data ? (
                <ErrorState
                  title="We could not load this study."
                  onRetry={() => void detail.refetch()}
                  retrying={detail.isFetching}
                />
              ) : (
                <StudyPanel
                  projectId={projectId}
                  detail={detail.data}
                  onEdit={() => setMode({ kind: 'edit', studyId: detail.data.study.id })}
                  onDeleted={() => setPickedId(null)}
                  onOpenSolver={onOpenSolver}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OptimisationSkeleton() {
  return (
    <div
      data-tab-root
      className="flex w-full flex-col gap-5 lg:min-h-0 lg:flex-1"
      role="status"
      aria-label="Loading the optimisation studies"
    >
      <Skeleton className="h-7 w-40" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
        <Skeleton className="h-48 w-full rounded-md" />
        <Skeleton className="h-96 w-full rounded-md" />
      </div>
    </div>
  );
}
