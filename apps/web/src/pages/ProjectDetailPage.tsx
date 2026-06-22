import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Loader2, Settings, Trash2, UserPlus, Users } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
 * ProjectDetailPage - a single project's details, case files, and collaborators.
 *
 * Owners and super-admins get a settings "gear" in the header that opens a small
 * menu: "Manage collaborators" (a dialog to add by email / remove) and "Delete
 * project" (a destructive confirmation, separated by a menu divider + danger
 * color). The page body shows the project details, the OpenFOAM case files, and
 * a read-only collaborators list so everyone with access can see who is on it.
 * Visibility is enforced by the API: a project the viewer may not see returns
 * 404, rendered as a not-found state. States: loading, not-found / error, data.
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

  const canManage = !!user && (project.owner.id === user.id || user.role === 'SUPER_ADMIN');

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <PageHeader
        title={project.title}
        subtitle={`Created ${formatDateTime(project.createdAt)}`}
        action={canManage ? <ProjectSettingsMenu project={project} /> : undefined}
      />

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

        <CollaboratorsCard project={project} />
      </div>
    </div>
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

/**
 * The header settings "gear" (owner / super-admin only). Opens a small menu;
 * each item launches a focused overlay. "Delete project" is separated from the
 * routine action by a divider and rendered in the danger color.
 */
function ProjectSettingsMenu({ project }: { project: Project }) {
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Project settings">
            <Settings strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Defer opening so the menu finishes closing (and releases focus)
              before the dialog traps it — avoids a focus/aria-hidden race. */}
          <DropdownMenuItem onSelect={() => setTimeout(() => setCollaboratorsOpen(true), 0)}>
            <Users strokeWidth={1.75} aria-hidden="true" />
            Manage collaborators
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setTimeout(() => setDeleteOpen(true), 0)}>
            <Trash2 strokeWidth={1.75} aria-hidden="true" />
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ManageCollaboratorsDialog
        project={project}
        open={collaboratorsOpen}
        onOpenChange={setCollaboratorsOpen}
      />
      <DeleteProjectDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
}

/** Manager overlay: add a collaborator by email and remove existing ones. */
function ManageCollaboratorsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overscroll-contain">
        <DialogHeader>
          <DialogTitle>Collaborators</DialogTitle>
          <DialogDescription>
            People who can see this project, in addition to the owner.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <AddCollaboratorForm projectId={project.id} />

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
                    <span className="truncate text-xs text-text-secondary">
                      {collaborator.email}
                    </span>
                  </div>
                  <RemoveCollaboratorButton projectId={project.id} collaborator={collaborator} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The "Delete project" destructive confirmation, opened from the settings menu. */
function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const deleteProject = useDeleteProject();

  const handleConfirm = async () => {
    try {
      await deleteProject.mutateAsync(project.id);
      toast.success('Project deleted.');
      navigate('/projects', { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete project</AlertDialogTitle>
          <AlertDialogDescription>
            Delete {project.title}? This permanently removes the project and its files for everyone.
            This action cannot be undone.
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

/** Read-only list of who has access (owner aside), visible to everyone. */
function CollaboratorsCard({ project }: { project: Project }) {
  return (
    <section className="rounded-md border border-border bg-surface shadow-sm">
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h2 className="text-lg font-semibold text-text">Collaborators</h2>
        <p className="mt-1 text-sm text-text-secondary">
          People who can see this project, in addition to the owner.
        </p>
      </header>

      <div className="px-5 py-5 sm:px-6">
        {project.collaborators.length === 0 ? (
          <p className="text-sm text-text-secondary">No collaborators yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {project.collaborators.map((collaborator) => (
              <li key={collaborator.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-text">
                    {collaborator.fullName}
                  </span>
                  <span className="truncate text-xs text-text-secondary">{collaborator.email}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const addCollaboratorSchema = z.object({
  email: z.string().trim().min(1, 'Enter an email address.').email('Enter a valid email address.'),
});
type AddCollaboratorValues = z.infer<typeof addCollaboratorSchema>;

/** Add a collaborator by email (inside the manage-collaborators dialog). */
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
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
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

/** Remove a single collaborator (inside the manage-collaborators dialog). */
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
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
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
