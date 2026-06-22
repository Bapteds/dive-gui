import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Loader2, Trash2, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { Project, UserSummary } from '@/lib/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  useAddCollaborator,
  useDeleteProject,
  useProjectQuery,
  useRemoveCollaborator,
} from '@/features/projects/useProjects';
import { CaseFilesSection } from '@/features/projects/CaseFilesSection';

/**
 * ProjectDetailPage - a single project's details and collaborator management.
 *
 * Reached by clicking a project in the list. Shows the owner, creation date, and
 * collaborators. The owner (or a super-admin) can add collaborators by email,
 * remove them, and delete the project (confirmed). Visibility is enforced by the
 * API: a project the viewer may not see returns 404, rendered as a not-found
 * state. States: loading, not-found / error, and data.
 */

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : dateTimeFormatter.format(date);
}

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data: project, isPending, isError, error } = useProjectQuery(id);

  if (isPending) {
    return <FullPageLoader />;
  }

  if (isError) {
    const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <div className="rounded-md border border-border bg-surface px-6 py-12 text-center shadow-sm">
          <p className="text-lg font-semibold text-text">
            {notFound ? 'Project not found' : 'We could not load this project'}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {notFound
              ? 'It may have been deleted, or you do not have access to it.'
              : 'Check your connection and try again.'}
          </p>
        </div>
      </div>
    );
  }

  const canManage =
    !!user && (project.owner.id === user.id || user.role === 'SUPER_ADMIN');

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <PageHeader title={project.title} subtitle={`Created ${formatDateTime(project.createdAt)}`} />

      <div className="flex w-full max-w-3xl flex-col gap-6">
        <section className="rounded-md border border-border bg-surface shadow-sm">
          <header className="border-b border-border px-5 py-4 sm:px-6">
            <h2 className="text-lg font-semibold text-text">Details</h2>
          </header>
          <dl className="grid gap-4 px-5 py-5 sm:grid-cols-2 sm:px-6">
            <div className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-text-secondary">Owner</dt>
              <dd className="break-words text-sm text-text">
                {project.owner.fullName} ({project.owner.email})
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-text-secondary">Created</dt>
              <dd className="text-sm text-text tabular-nums">{formatDateTime(project.createdAt)}</dd>
            </div>
          </dl>
        </section>

        <CaseFilesSection projectId={project.id} />

        <CollaboratorsSection project={project} canManage={canManage} />

        {canManage && <DangerZone project={project} />}
      </div>
    </div>
  );
}

/**
 * Danger zone: destructive actions live at the bottom of the page, spatially and
 * visually separated from the title/navigation and the rest of the content
 * (a danger-colored hairline), so a delete is never mistaken for a primary action.
 */
function DangerZone({ project }: { project: Project }) {
  return (
    <section className="rounded-md border border-danger/40 bg-surface shadow-sm">
      <div className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-text">Delete this project</h2>
          <p className="text-sm text-text-secondary">
            This permanently removes the project for everyone. It cannot be undone.
          </p>
        </div>
        <div className="shrink-0">
          <DeleteProjectButton project={project} />
        </div>
      </div>
    </section>
  );
}

/** Back to the project list. */
function BackLink() {
  return (
    <Link
      to="/projects"
      className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-text-secondary transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      Projects
    </Link>
  );
}

/** The "Delete project" trigger + its confirmation dialog. */
function DeleteProjectButton({ project }: { project: Project }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const deleteProject = useDeleteProject();

  const handleConfirm = async () => {
    try {
      await deleteProject.mutateAsync(project.id);
      toast.success('Project deleted.');
      navigate('/projects', { replace: true });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="secondary"
        className="border-danger/50 text-danger hover:bg-danger-tint"
        onClick={() => setOpen(true)}
      >
        <Trash2 strokeWidth={1.75} aria-hidden="true" />
        Delete project
      </Button>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {project.title}? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteProject.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={deleteProject.isPending}
            aria-busy={deleteProject.isPending || undefined}
          >
            {deleteProject.isPending && (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const addCollaboratorSchema = z.object({
  email: z.string().trim().min(1, 'Enter an email address.').email('Enter a valid email address.'),
});
type AddCollaboratorValues = z.infer<typeof addCollaboratorSchema>;

/** Collaborators list + (for managers) an add-by-email form and remove actions. */
function CollaboratorsSection({
  project,
  canManage,
}: {
  project: Project;
  canManage: boolean;
}) {
  return (
    <section className="rounded-md border border-border bg-surface shadow-sm">
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold text-text">Collaborators</h2>
        <p className="mt-1 text-sm text-text-secondary">
          People who can see this project, in addition to the owner.
        </p>
      </header>

      <div className="flex flex-col gap-5 px-5 py-5 sm:px-6">
        {canManage && <AddCollaboratorForm projectId={project.id} />}

        {project.collaborators.length === 0 ? (
          <p className="text-sm text-text-secondary">No collaborators yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {project.collaborators.map((collaborator) => (
              <li
                key={collaborator.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-text">
                    {collaborator.fullName}
                  </span>
                  <span className="truncate text-xs text-text-secondary">{collaborator.email}</span>
                </div>
                {canManage && (
                  <RemoveCollaboratorButton projectId={project.id} collaborator={collaborator} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Add a collaborator by email. */
function AddCollaboratorForm({ projectId }: { projectId: string }) {
  const addCollaborator = useAddCollaborator(projectId);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<AddCollaboratorValues>({
    resolver: zodResolver(addCollaboratorSchema),
    mode: 'onSubmit',
    defaultValues: { email: '' },
  });

  const submitting = addCollaborator.isPending;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await addCollaborator.mutateAsync(values.email.trim());
      toast.success('Collaborator added.');
      reset({ email: '' });
      setFocus('email');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'USER_NOT_FOUND') {
        setError('email', { type: 'server', message: 'No account exists with that email.' });
        setFocus('email');
        return;
      }
      if (err instanceof ApiError && err.code === 'COLLABORATOR_EXISTS') {
        setError('email', { type: 'server', message: 'That user already has access.' });
        setFocus('email');
        return;
      }
      toast.error(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Field label="Add collaborator by email" error={errors.email?.message} className="flex-1">
        <Input
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          placeholder="name@dive-turbinen.de…"
          {...register('email')}
        />
      </Field>
      <Button type="submit" loading={submitting} className="sm:mt-[1.875rem]">
        <UserPlus strokeWidth={1.75} aria-hidden="true" />
        Add
      </Button>
    </form>
  );
}

/** Remove a single collaborator. */
function RemoveCollaboratorButton({
  projectId,
  collaborator,
}: {
  projectId: string;
  collaborator: UserSummary;
}) {
  const removeCollaborator = useRemoveCollaborator(projectId);

  const handleRemove = async () => {
    try {
      await removeCollaborator.mutateAsync(collaborator.id);
      toast.success('Collaborator removed.');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
      );
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${collaborator.fullName}`}
          className="text-text-secondary hover:bg-danger-tint hover:text-danger"
          loading={removeCollaborator.isPending}
          onClick={() => void handleRemove()}
        >
          <Trash2 strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Remove collaborator</TooltipContent>
    </Tooltip>
  );
}
