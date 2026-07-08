import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronRight, Minus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import type { MeshingEngine } from '@/lib/api/types';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { MeshingSessionSummary } from '@/lib/api/types';
import { useCreateMeshingSession, useMeshingSessions } from '@/features/meshing/useMeshing';

/**
 * MeshingPage - create and list meshing sessions (STL -> snappyHexMesh ->
 * polyMesh). A standalone workspace, not tied to a project. Mirrors the Projects
 * page: one orange create CTA above the list, which renders loading / error /
 * empty / data states. Sessions are shared across the team.
 */

const createSessionSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(120, 'Name is too long'),
});
type CreateSessionValues = z.infer<typeof createSessionSchema>;

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : dateFormatter.format(date);
}

export function MeshingPage() {
  const { data: sessions, isPending, isError, refetch, isRefetching } = useMeshingSessions();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Meshing"
        subtitle="Turn surfaces into an OpenFOAM mesh with snappyHexMesh or cfMesh."
      />

      <CreateSessionForm />

      {isPending ? (
        <SessionsSkeleton />
      ) : isError ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-danger"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-text">We could not load your sessions.</p>
              <p className="text-sm text-text-secondary">Check your connection and try again.</p>
            </div>
          </div>
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
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No meshing sessions yet."
          description="Create your first session with the form above, then upload an STL surface."
        />
      ) : (
        <SessionsTable sessions={sessions} />
      )}
    </div>
  );
}

/** The create-session form: a name, an engine choice, and one orange CTA. */
function CreateSessionForm() {
  const create = useCreateMeshingSession();
  const [engine, setEngine] = useState<MeshingEngine>('snappy');

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<CreateSessionValues>({
    resolver: zodResolver(createSessionSchema),
    mode: 'onSubmit',
    defaultValues: { name: '' },
  });

  const submitting = create.isPending;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await create.mutateAsync({ name: values.name.trim(), engine });
      toast.success('Session created.');
      reset({ name: '' });
      setFocus('name');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        setError('name', { type: 'server', message: error.message });
        setFocus('name');
        return;
      }
      toast.error(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  });

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-md border border-border bg-surface p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Field label="Session name" error={errors.name?.message} className="flex-1">
          <Input
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            placeholder="e.g. Draft-tube internal flow…"
            {...register('name')}
          />
        </Field>
        <Button type="submit" loading={submitting} className="sm:mt-[1.875rem]">
          New session
        </Button>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-text">Mesh engine</legend>
        <SegmentedRadioGroup
          name="engine"
          value={engine}
          onChange={(value) => setEngine(value)}
          ariaLabel="Mesh engine"
          options={[
            { value: 'snappy', label: 'snappyHexMesh' },
            { value: 'cfmesh', label: 'cfMesh' },
          ]}
        />
        <p className="text-xs text-text-secondary">
          {engine === 'snappy'
            ? 'Hex-dominant mesh from STL surface(s). Runs in parallel (MPI).'
            : 'Hex-dominant cartesianMesh from a single STL or FMS file. Multithreaded.'}
        </p>
      </fieldset>
    </form>
  );
}

/** The visible session list. Names link to the detail page. */
function SessionsTable({ sessions }: { sessions: MeshingSessionSummary[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-bg">
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Engine</TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Surfaces
            </TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Meshed
            </TableHead>
            <TableHead scope="col" className="hidden text-right md:table-cell">
              Created
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.id}>
              <TableCell className="font-medium">
                <Link
                  to={`/meshing/${session.id}`}
                  className="inline-flex items-center gap-1 rounded-sm text-text hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                >
                  {session.name}
                  <ChevronRight className="size-4 text-neutral" strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center rounded-sm bg-primary-tint px-1.5 py-0.5 text-xs font-medium text-primary">
                  {session.engine === 'cfmesh' ? 'cfMesh' : 'snappyHexMesh'}
                </span>
              </TableCell>
              <TableCell className="hidden text-right text-text-secondary tabular-nums sm:table-cell">
                {session.stlCount}
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                {session.hasMesh ? (
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
                    <Check className="size-4" strokeWidth={2} aria-hidden="true" />
                    Yes
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm text-text-secondary">
                    <Minus className="size-4 text-neutral" strokeWidth={2} aria-hidden="true" />
                    No
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden text-right text-text-secondary tabular-nums md:table-cell">
                {formatCreated(session.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Loading placeholder mirroring the session list layout. */
function SessionsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-bg">
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Engine</TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Surfaces
            </TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Meshed
            </TableHead>
            <TableHead scope="col" className="hidden text-right md:table-cell">
              Created
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody aria-hidden="true">
          {Array.from({ length: rows }).map((_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              <TableCell>
                <Skeleton className="h-4 w-48" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="flex justify-end">
                  <Skeleton className="h-4 w-8" />
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="flex justify-end">
                  <Skeleton className="h-4 w-10" />
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <div className="flex justify-end">
                  <Skeleton className="h-4 w-20" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default MeshingPage;
