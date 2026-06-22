import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import type { Project } from '@/lib/api/types';
import { useCreateProject, useProjectsQuery } from '@/features/projects/useProjects';
import { createProjectSchema, type CreateProjectFormValues } from '@/features/projects/schemas';

/**
 * ProjectsPage - create and list the current user's projects.
 *
 * Any signed-in user can create a project; in this phase a project carries only
 * a title. The page is a single create form (one orange CTA) above the owner's
 * project list, which renders the four states: loading (skeleton rows), error
 * (inline retry), empty (invite to create the first one), and data.
 */

/** Stable formatter for the Created column (e.g. "07 Jun 2026"). */
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : dateFormatter.format(date);
}

export function ProjectsPage() {
  const { user } = useAuth();
  const { data: projects, isPending, isError, refetch, isRefetching } = useProjectsQuery();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Projects" subtitle="Create and track your projects." />

      <CreateProjectForm />

      {isPending ? (
        <ProjectsSkeleton />
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
              <p className="text-sm font-medium text-text">We could not load your projects.</p>
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
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          description="Create your first project with the form above."
        />
      ) : (
        <ProjectsTable projects={projects} currentUserId={user?.id ?? ''} />
      )}
    </div>
  );
}

/** The create-project form: a single title field and one orange CTA. */
function CreateProjectForm() {
  const createProject = useCreateProject();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<CreateProjectFormValues>({
    resolver: zodResolver(createProjectSchema),
    mode: 'onSubmit',
    defaultValues: { title: '' },
  });

  const submitting = createProject.isPending;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createProject.mutateAsync({ title: values.title.trim() });
      toast.success('Project created.');
      reset({ title: '' });
      setFocus('title');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        setError('title', { type: 'server', message: error.message });
        setFocus('title');
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
      className="rounded-md border border-border bg-surface p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Field label="Project title" error={errors.title?.message} className="flex-1">
          <Input
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            placeholder="e.g. Rotor stage tip-clearance study…"
            {...register('title')}
          />
        </Field>
        <Button type="submit" loading={submitting} className="sm:mt-[1.875rem]">
          Create project
        </Button>
      </div>
    </form>
  );
}

/** The visible project list. Titles link to the detail page. */
function ProjectsTable({
  projects,
  currentUserId,
}: {
  projects: Project[];
  currentUserId: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-bg">
            <TableHead scope="col">Title</TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Owner
            </TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              Created
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow key={project.id}>
              <TableCell className="font-medium">
                <Link
                  to={`/projects/${project.id}`}
                  className="inline-flex items-center gap-1 rounded-sm text-text hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                >
                  {project.title}
                  <ChevronRight className="size-4 text-neutral" strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </TableCell>
              <TableCell className="hidden text-text-secondary md:table-cell">
                {project.owner.id === currentUserId ? 'You' : project.owner.email}
              </TableCell>
              <TableCell className="hidden text-right text-text-secondary tabular-nums sm:table-cell">
                {formatCreated(project.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Loading placeholder mirroring the project list layout. */
function ProjectsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-bg">
            <TableHead scope="col">Title</TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              Owner
            </TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
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
              <TableCell className="hidden md:table-cell">
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
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
