import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { AlertCircle, FileText } from 'lucide-react';
import { EDITABLE_FILE_MAX_BYTES } from '@dive/shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Diamond } from '@/components/brand/Diamond';
import { getCaseFileContent } from '@/lib/api/projects';
import { caseFileContentQueryKey, useCaseFilesQuery } from '@/features/projects/useCaseFiles';
import { countFoamEntries, parseFoam, type FoamEntry } from '@/features/projects/foamSummary';

/**
 * CaseSummary - a read-only synthesis of the settings entered across a case's
 * readable dictionary files, for a glance at what is configured.
 *
 * It summarises only files that are editable (≤ the editor cap) and not mesh
 * data (constant/polyMesh/* is machine data, not "settings"). File contents are
 * fetched with `useQueries`, reusing the editor's content cache key so a file
 * opened here or in the editor is shared. Each file is parsed tolerantly (see
 * foamSummary) and rendered as key → value pairs, separated by hairlines.
 */

/** Is this a mesh file (machine data we never summarise)? */
function isMeshPath(path: string): boolean {
  return path.startsWith('constant/polyMesh/');
}

export function CaseSummary({ projectId }: { projectId: string }) {
  const { data: entries, isPending, isError, refetch, isRefetching } = useCaseFilesQuery(projectId);

  const files = useMemo(() => (entries ?? []).filter((entry) => entry.type === 'file'), [entries]);
  const summarisable = useMemo(
    () => files.filter((file) => file.size <= EDITABLE_FILE_MAX_BYTES && !isMeshPath(file.path)),
    [files],
  );

  const contents = useQueries({
    queries: summarisable.map((file) => ({
      queryKey: caseFileContentQueryKey(projectId, file.path),
      queryFn: () => getCaseFileContent(projectId, file.path),
    })),
  });

  if (isPending) {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between lg:my-auto"
      >
        <p className="text-sm text-text">We could not load the case files.</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void refetch()}
          loading={isRefetching}
          className="shrink-0"
        >
          Try again
        </Button>
      </div>
    );
  }

  const skipped = files.length - summarisable.length;

  if (summarisable.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border-strong px-6 py-12 text-center lg:my-auto">
        <span className="grid size-12 place-items-center rounded-md bg-primary-tint">
          <Diamond size={18} className="text-primary" />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <p className="text-lg font-semibold text-text">Nothing to summarise yet</p>
          <p className="text-sm text-text-secondary">
            {files.length === 0
              ? 'Import a case to see a synthesis of its settings here.'
              : 'The imported files are mesh or too large to read. Add configuration files to see them summarised.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
      {/* The summary scrolls within a bounded region so a long case never grows
          the page: the table itself scrolls, not the whole detail page. On a
          phone it is capped (max-h-96); from `lg` up it fills the pinned card
          and scrolls there instead. It is focusable (no focusable children
          otherwise) so keyboard users can scroll it; overscroll-contain keeps
          the scroll from chaining to the page once the ends are reached. */}
      <section
        aria-label="Case settings summary"
        tabIndex={0}
        className="max-h-96 divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring lg:max-h-none lg:min-h-0 lg:flex-1"
      >
        {summarisable.map((file, index) => (
          <FileSummary
            key={file.path}
            path={file.path}
            query={contents[index]}
          />
        ))}
      </section>
      {skipped > 0 && (
        <p className="text-xs text-text-secondary lg:shrink-0">
          {skipped} mesh or large file{skipped === 1 ? '' : 's'} not summarised.
        </p>
      )}
    </div>
  );
}

/** One file's parsed synthesis, or its loading / error state. */
function FileSummary({
  path,
  query,
}: {
  path: string;
  query: { data?: { content: string }; isPending: boolean; isError: boolean; refetch: () => void };
}) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const name = path.split('/').pop() ?? path;

  if (query.isPending) {
    return (
      <div className="px-4 py-3.5">
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <AlertCircle className="size-4 text-danger" strokeWidth={1.75} aria-hidden="true" />
          <span className="font-mono text-sm" translate="no">
            {path}
          </span>
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const summary = parseFoam(query.data.content);
  const count = countFoamEntries(summary.entries);

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
        <p className="min-w-0 text-sm font-medium text-text">
          {dir && (
            <span className="text-text-secondary" translate="no">
              {dir}
            </span>
          )}
          <span translate="no">{summary.object ?? name}</span>
        </p>
        {summary.className && (
          <span className="rounded-sm bg-primary-tint px-1.5 py-0.5 text-xs font-medium text-primary" translate="no">
            {summary.className}
          </span>
        )}
        <span className="ml-auto text-xs text-text-secondary tabular-nums">
          {count} {count === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {summary.entries.length > 0 ? (
        <FoamEntries entries={summary.entries} />
      ) : (
        <p className="text-sm text-text-secondary">No readable settings.</p>
      )}
    </div>
  );
}

/** Render parsed entries as key → value pairs; sub-dictionaries indent under a guide. */
function FoamEntries({ entries }: { entries: FoamEntry[] }) {
  return (
    <dl className="flex flex-col gap-1.5">
      {entries.map((entry, index) => (
        <div key={`${entry.key}-${index}`} className="flex flex-col gap-1.5">
          {entry.children ? (
            <div className="flex flex-col gap-1.5">
              <dt className="text-sm font-medium text-text" translate="no">
                {entry.key}
              </dt>
              <dd className="ml-1 border-l border-border pl-3">
                <FoamEntries entries={entry.children} />
              </dd>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 font-mono text-sm text-text-secondary" translate="no">
                {entry.key}
              </dt>
              <dd className="min-w-0 break-words text-right font-mono text-sm text-text" translate="no">
                {entry.value ?? '-'}
              </dd>
            </div>
          )}
        </div>
      ))}
    </dl>
  );
}
