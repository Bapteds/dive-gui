import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SegmentedRadioGroup } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { MeshToProjectTarget } from '@/lib/api/types';
import { useProjectsQuery } from '@/features/projects/useProjects';
import { useImportMeshFromMeshing } from '@/features/projects/useMeshes';

/** Inline message for each API error the hand-off can answer with. */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'MESHING_NOT_MESHED':
        return 'This session has no mesh yet. Generate the mesh first.';
      case 'MESH_IN_PROGRESS':
        return 'A mesh run is in progress for this session. Wait for it to finish.';
      case 'RUN_IN_PROGRESS':
        return 'A solver run is active in this project. Stop it or wait for it to finish, or send the mesh to the library instead.';
      case 'NOT_FOUND':
        return 'This project or session is no longer available. Refresh and try again.';
      default:
        return err.message;
    }
  }
  return 'Could not send the mesh. Check your connection and try again.';
}

/**
 * SendToProjectDialog - send the meshing session's polyMesh into a project (WS-F,
 * `POST /projects/:id/mesh/from-meshing`). Mirrors SendToMeshingDialog: pick a
 * visible project, then the target: the project's case mesh (default; replaces
 * it, the original case is backed up once) or a new mesh-library part (named,
 * prefilled with the session name). One primary CTA. On success, toast and land
 * on the project's Visualize tab (`?view=visualize`); errors stay inline so the
 * user can retarget without losing the form.
 */
export function SendToProjectDialog({
  sessionId,
  sessionName,
  open,
  onOpenChange,
}: {
  sessionId: string;
  sessionName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjectsQuery();
  const send = useImportMeshFromMeshing();

  const [projectId, setProjectId] = useState('');
  const [target, setTarget] = useState<MeshToProjectTarget>('case');
  const [name, setName] = useState(sessionName);
  const [projectError, setProjectError] = useState<string | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const [apiError, setApiError] = useState<string | null>(null);

  // Start from a clean form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTarget('case');
    setName(sessionName);
    setProjectError(undefined);
    setNameError(undefined);
    setApiError(null);
  }, [open, sessionName]);

  const list = projects.data ?? [];

  async function onConfirm() {
    setApiError(null);
    const trimmed = name.trim();
    const missingProject = !projectId;
    const missingName = target === 'library' && !trimmed;
    setProjectError(missingProject ? 'Choose a project.' : undefined);
    setNameError(missingName ? 'Enter a name for the library part.' : undefined);
    if (missingProject || missingName) return;

    try {
      await send.mutateAsync(
        target === 'library'
          ? { projectId, sessionId, target, name: trimmed }
          : { projectId, sessionId, target },
      );
      const title = list.find((p) => p.id === projectId)?.title ?? 'the project';
      toast.success(`Mesh sent to ${title}.`);
      onOpenChange(false);
      navigate(`/projects/${projectId}?view=visualize`);
    } catch (err) {
      setApiError(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to project</DialogTitle>
          <DialogDescription>
            Copies this session&apos;s volume mesh (constant/polyMesh) into a project.
          </DialogDescription>
        </DialogHeader>

        {projects.isPending ? (
          <div className="flex flex-col gap-4" aria-hidden="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : projects.isError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-danger">
            <AlertCircle strokeWidth={1.75} aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Could not load your projects. Close the dialog and try again.
          </p>
        ) : list.length === 0 ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-text">No project yet.</p>
            <p className="text-text-secondary">
              Create a project first, then send the mesh to it.{' '}
              <Link to="/projects" className="font-medium text-primary underline-offset-4 hover:underline">
                Go to Projects
              </Link>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label="Project" error={projectError}>
              <NativeSelect
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setProjectError(undefined);
                }}
              >
                <option value="">Select a project…</option>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium text-text">Send as</legend>
              <SegmentedRadioGroup
                name="send-target"
                value={target}
                onChange={(v) => {
                  setTarget(v);
                  setNameError(undefined);
                }}
                ariaLabel="Send as"
                stretch
                options={[
                  { value: 'case', label: 'Case mesh' },
                  { value: 'library', label: 'Mesh library part' },
                ]}
              />
            </fieldset>

            {target === 'case' ? (
              <p className="flex items-start gap-2 text-xs text-text-secondary">
                <AlertTriangle
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="mt-px size-4 shrink-0 text-accent-strong"
                />
                <span>
                  Replaces the project&apos;s case mesh. The original case is backed up once;
                  boundary conditions of patches with the same name are kept.
                </span>
              </p>
            ) : (
              <Field
                label="Part name"
                error={nameError}
                helperText="Added to the project's mesh library, ready for Merge meshes and Assemble."
              >
                <Input
                  name="partName"
                  autoComplete="off"
                  value={name}
                  maxLength={120}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(undefined);
                  }}
                />
              </Field>
            )}

            {apiError && (
              <p role="alert" className="flex items-start gap-2 text-sm text-danger">
                <AlertCircle
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                {apiError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={send.isPending}
            disabled={list.length === 0}
            onClick={() => void onConfirm()}
          >
            Send to project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SendToProjectDialog;
