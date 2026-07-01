import { Suspense, lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  Box,
  Boxes,
  Info,
  Loader2,
  Play,
  Settings,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { FullPageLoader } from '@/components/common/FullPageLoader';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { useCaseFilesQuery } from '@/features/projects/useCaseFiles';
import { useMeshesQuery } from '@/features/projects/useMeshes';

/**
 * The 3D viewer pulls in three.js, so it is code-split and only loaded when the
 * user opens the Visualize tab (never on the initial detail render).
 */
const MeshViewer = lazy(() =>
  import('@/features/visualize/MeshViewer').then((module) => ({ default: module.MeshViewer })),
);

/**
 * The Solver tab pulls in the residual chart and run machinery, so it is
 * code-split and only loaded when the user opens it (never on the initial render).
 */
const SolverTab = lazy(() =>
  import('@/features/solver/SolverTab').then((module) => ({ default: module.SolverTab })),
);

/**
 * The Export tab runs the OpenFOAM -> CGNS (CFD-Post) pipeline and shows its
 * report; code-split so its machinery only loads when the tab is opened.
 */
const ExportTab = lazy(() =>
  import('@/features/export/ExportTab').then((module) => ({ default: module.ExportTab })),
);

/**
 * The Assemble tab pulls in three.js (a live multi-part canvas), so it is
 * code-split and only loaded when the user opens it (never on the initial render).
 */
const AssemblyWorkspace = lazy(() =>
  import('@/features/assemble/AssemblyWorkspace').then((module) => ({
    default: module.AssemblyWorkspace,
  })),
);

/**
 * ProjectDetailPage - a single project's details and case files.
 *
 * Owners and super-admins get a settings "gear" in the header that opens a small
 * menu: "Manage collaborators" (a dialog to add by email / remove) and "Delete
 * project" (a destructive confirmation, separated by a menu divider + danger
 * color). The page body shows the project details and the OpenFOAM case files;
 * importing, verifying, and converting a CGNS mesh all live in the Case files
 * card. From `lg` up the page is pinned to the viewport and only that card
 * scrolls (see AppShell), so the page itself never scrolls.
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
    <div className="flex flex-col gap-6 lg:min-h-0 lg:flex-1">
      <BackLink />
      <PageHeader
        title={project.title}
        subtitle={`Created ${formatDateTime(project.createdAt)}`}
        action={<ProjectSettingsMenu project={project} canManage={canManage} />}
      />

      <ProjectTabs project={project} />
    </div>
  );
}

/**
 * The Detail / Visualize tab strip and bodies. "Visualize" is gated on the case
 * having an imported mesh (constant/polyMesh/): until then it is disabled, with a
 * tooltip explaining how to enable it. Opening it swaps the whole detail body for
 * the lazy-loaded 3D viewer, which fills the pinned region at lg+.
 */
type ProjectView = 'detail' | 'visualize' | 'assemble' | 'solver' | 'export';

function ProjectTabs({ project }: { project: Project }) {
  const [view, setView] = useState<ProjectView>('detail');
  const { data: entries } = useCaseFilesQuery(project.id);
  const hasPolyMesh = !!entries?.some((entry) => entry.path.startsWith('constant/polyMesh/'));
  // The Assemble tab works on the mesh LIBRARY (imported parts), not the case
  // mesh, so it is gated on the library having at least one source.
  const { data: sources } = useMeshesQuery(project.id);
  const hasSources = (sources?.length ?? 0) > 0;

  return (
    <Tabs
      value={view}
      onValueChange={(value) => setView(value as ProjectView)}
      className="flex w-full flex-col gap-6 lg:min-h-0 lg:flex-1"
    >
      <TabsList className="shrink-0">
        <TabsTrigger value="detail">
          <Info strokeWidth={1.75} aria-hidden="true" />
          Detail
        </TabsTrigger>
        <VisualizeTab disabled={!hasPolyMesh} />
        <AssembleTab disabled={!hasSources} />
        <SolverTabTrigger disabled={!hasPolyMesh} />
        <ExportTabTrigger disabled={!hasPolyMesh} />
      </TabsList>

      <TabsContent
        value="detail"
        className="mt-0 flex-col data-[state=active]:flex lg:min-h-0 lg:flex-1"
      >
        {/* Project details (owner / created) live behind the header gear menu, so
            the case files get the full height on every tab. */}
        <CaseFilesSection projectId={project.id} className="lg:min-h-0 lg:flex-1" />
      </TabsContent>

      <TabsContent
        value="visualize"
        className="mt-0 data-[state=active]:flex lg:min-h-0 lg:flex-1"
      >
        {/* Mount the viewer only when the tab is open: it triggers the server
            build, so it must not run while the user is on Detail. */}
        {view === 'visualize' && (
          <Suspense fallback={<ViewerLoading />}>
            <MeshViewer projectId={project.id} />
          </Suspense>
        )}
      </TabsContent>

      <TabsContent
        value="assemble"
        className="mt-0 data-[state=active]:flex lg:min-h-0 lg:flex-1"
      >
        {/* Mount only when open: the workspace loads three.js and builds each
            source's preview on the server, so it must not run on other tabs. */}
        {view === 'assemble' && (
          <Suspense fallback={<ViewerLoading />}>
            <AssemblyWorkspace projectId={project.id} />
          </Suspense>
        )}
      </TabsContent>

      <TabsContent
        value="solver"
        className="mt-0 flex-col data-[state=active]:flex lg:min-h-0 lg:flex-1"
      >
        {/* Mount only when open: the tab polls the run log while a run is active. */}
        {view === 'solver' && (
          <Suspense fallback={<ViewerLoading />}>
            <SolverTab projectId={project.id} />
          </Suspense>
        )}
      </TabsContent>

      <TabsContent
        value="export"
        className="mt-0 flex-col data-[state=active]:flex lg:min-h-0 lg:flex-1"
      >
        {view === 'export' && (
          <Suspense fallback={<ViewerLoading />}>
            <ExportTab projectId={project.id} />
          </Suspense>
        )}
      </TabsContent>
    </Tabs>
  );
}

/**
 * The Visualize trigger. When the project has no mesh yet, it is disabled and
 * wrapped so a tooltip can explain how to enable it (a disabled control emits no
 * hover events itself, so the wrapping span carries the tooltip).
 */
function VisualizeTab({ disabled }: { disabled: boolean }) {
  const trigger = (
    <TabsTrigger value="visualize" disabled={disabled}>
      <Box strokeWidth={1.75} aria-hidden="true" />
      Visualize
    </TabsTrigger>
  );

  if (!disabled) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable wrapper so keyboard users can reach the tooltip even though
            the disabled trigger emits no pointer/focus events of its own. */}
        <span
          tabIndex={0}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent>Import a polyMesh to enable 3D</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Assemble trigger. Gated on the mesh LIBRARY having at least one imported
 * source (parts to compose), not on the case mesh; when disabled, a tooltip
 * explains how to enable it. Opening it swaps the detail body for the lazy-loaded
 * multi-part assembly workspace.
 */
function AssembleTab({ disabled }: { disabled: boolean }) {
  const trigger = (
    <TabsTrigger value="assemble" disabled={disabled}>
      <Boxes strokeWidth={1.75} aria-hidden="true" />
      Assemble
    </TabsTrigger>
  );

  if (!disabled) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent>Import a mesh part to enable assembly</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Solver trigger. Gated on the project having a mesh (you cannot run a solver
 * without one); when disabled, a tooltip explains how to enable it. Whether the
 * case has the solver files is handled inside the tab (which offers to generate
 * them), so the tab stays reachable as soon as a mesh exists.
 */
function SolverTabTrigger({ disabled }: { disabled: boolean }) {
  const trigger = (
    <TabsTrigger value="solver" disabled={disabled}>
      <Play strokeWidth={1.75} aria-hidden="true" />
      Solver
    </TabsTrigger>
  );

  if (!disabled) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent>Import a polyMesh to enable the solver</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Export trigger. Gated on the project having a mesh; the export needs SOLVED
 * results, which the pipeline reports on if missing (run the solver first). When
 * disabled, a tooltip explains how to enable it.
 */
function ExportTabTrigger({ disabled }: { disabled: boolean }) {
  const trigger = (
    <TabsTrigger value="export" disabled={disabled}>
      <Upload strokeWidth={1.75} aria-hidden="true" />
      Export
    </TabsTrigger>
  );

  if (!disabled) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent>Import a polyMesh to enable export</TooltipContent>
    </Tooltip>
  );
}

/** Suspense fallback while the three.js viewer chunk loads. */
function ViewerLoading() {
  return (
    <div
      className="flex min-h-[40vh] items-center justify-center lg:min-h-0 lg:flex-1"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-5 animate-spin text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">Loading the 3D viewer</span>
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
 * The header "gear" menu. "Project details" (owner / created) is available to
 * every member, so the details no longer take a card in the page body. Managers
 * (owner / super-admin) additionally get "Manage collaborators" and, separated
 * by a divider and rendered in the danger color, "Delete project".
 */
function ProjectSettingsMenu({ project, canManage }: { project: Project; canManage: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Project menu">
            <Settings strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Defer opening so the menu finishes closing (and releases focus)
              before the dialog traps it — avoids a focus/aria-hidden race. */}
          <DropdownMenuItem onSelect={() => setTimeout(() => setDetailsOpen(true), 0)}>
            <Info strokeWidth={1.75} aria-hidden="true" />
            Project details
          </DropdownMenuItem>
          {canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTimeout(() => setCollaboratorsOpen(true), 0)}>
                <Users strokeWidth={1.75} aria-hidden="true" />
                Manage collaborators
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setTimeout(() => setDeleteOpen(true), 0)}>
                <Trash2 strokeWidth={1.75} aria-hidden="true" />
                Delete project
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectDetailsDialog project={project} open={detailsOpen} onOpenChange={setDetailsOpen} />
      {canManage && (
        <>
          <ManageCollaboratorsDialog
            project={project}
            open={collaboratorsOpen}
            onOpenChange={setCollaboratorsOpen}
          />
          <DeleteProjectDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
        </>
      )}
    </>
  );
}

/** Read-only overlay: the project's owner and creation date (any member). */
function ProjectDetailsDialog({
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
          <DialogTitle>Project details</DialogTitle>
          <DialogDescription>Who owns this project and when it was created.</DialogDescription>
        </DialogHeader>

        <dl className="grid gap-4 sm:grid-cols-2">
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
      </DialogContent>
    </Dialog>
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
