import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, Scissors } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { useAutoPatchMeshSource } from '@/features/projects/useMeshes';
import { useAutoPatch } from './useMesh';
import type { MeshTarget } from './MeshViewer';

/**
 * AutoPatchDialog - run OpenFOAM `autoPatch <featureAngle> -overwrite` from the
 * Visualize tab.
 *
 * The feature angle (degrees, default 45) is the dihedral angle above which
 * adjacent external boundary faces are split into separate patches. autoPatch
 * rewrites constant/polyMesh/boundary in place, so each field's boundaryField
 * may need updating afterward (called out in the dialog).
 *
 * A tool failure does not throw: the run mutation resolves with
 * `result.success === false`, and the captured command + exit code + stderr are
 * shown inline while the dialog stays open. A successful run drops the render
 * cache (so the viewer rebuilds with the new patches), toasts, and closes.
 */

const DEFAULT_FEATURE_ANGLE = 45;

const schema = z.object({
  featureAngle: z
    .number({ invalid_type_error: 'Enter a feature angle.' })
    .min(0, 'Must be between 0 and 180.')
    .max(180, 'Must be between 0 and 180.'),
});
type Values = z.infer<typeof schema>;

/** The captured fields shown when an autoPatch run fails (case or source share these). */
type AutoPatchRunFailure = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export function AutoPatchDialog({
  projectId,
  target,
  open,
  onClose,
  onPatched,
}: {
  projectId: string;
  /** Which mesh to auto-patch: the project case mesh or a library source. */
  target: MeshTarget;
  open: boolean;
  onClose: () => void;
  /** Called after a successful run (the boundary changed), before closing. */
  onPatched?: () => void;
}) {
  // Both mutations exist every render (stable hook order); the active target runs.
  // The case path rewrites the boundary in place; a source re-patches its own copy.
  const caseAuto = useAutoPatch(projectId);
  const sourceAuto = useAutoPatchMeshSource(projectId);
  // The failed-run report shown inline (command + exit code + logs), or null.
  const [failure, setFailure] = useState<AutoPatchRunFailure | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    defaultValues: { featureAngle: DEFAULT_FEATURE_ANGLE },
  });

  // Re-seed the field and clear any previous failure each time the dialog opens.
  useEffect(() => {
    if (open) {
      reset({ featureAngle: DEFAULT_FEATURE_ANGLE });
      setFailure(null);
    }
  }, [open, reset]);

  const running = target.kind === 'source' ? sourceAuto.isPending : caseAuto.isPending;

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      let count: number;
      if (target.kind === 'source') {
        const res = await sourceAuto.mutateAsync({
          meshId: target.meshId,
          featureAngle: values.featureAngle,
        });
        if (!res.result.success) {
          setFailure(res.result);
          return;
        }
        count = res.mesh?.patches.length ?? 0;
      } else {
        const result = await caseAuto.mutateAsync(values.featureAngle);
        if (!result.success) {
          setFailure(result);
          return;
        }
        count = result.patches.length;
      }
      toast.success(
        `Boundaries patched at ${values.featureAngle}°. ${count} patch${count === 1 ? '' : 'es'} now in the mesh.`,
      );
      onPatched?.();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not run autoPatch. Please try again.',
      );
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onClose();
      }}
    >
      <DialogContent className="overscroll-contain">
        <DialogHeader>
          <DialogTitle>Auto-patch boundaries</DialogTitle>
          <DialogDescription>
            Runs OpenFOAM <code className="text-text">autoPatch</code> to split the external
            boundary faces into separate patches wherever adjacent faces meet at an angle above the
            feature angle.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field
            label="Feature angle (degrees)"
            error={errors.featureAngle?.message}
            helperText="Faces meeting at an angle above this are split apart. Typical values are 30 to 60."
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={180}
              step="any"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className="tabular-nums"
              disabled={running}
              {...register('featureAngle', { valueAsNumber: true })}
            />
          </Field>

          {/* Attention: -overwrite replaces the mesh boundary in place. */}
          <p className="flex items-start gap-2 rounded-sm bg-accent-tint px-3 py-2.5 text-xs leading-relaxed text-text">
            <AlertTriangle
              className="mt-px size-4 shrink-0 text-accent-hover"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <span>
              This rewrites <code>constant/polyMesh/boundary</code> in place with auto-generated
              patches. Each field&rsquo;s <code>boundaryField</code> may then need updating to match
              the new patch names.
            </span>
          </p>

          {failure && <AutoPatchFailure result={failure} />}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={running}>
              Cancel
            </Button>
            <Button type="submit" loading={running}>
              <Scissors strokeWidth={1.75} aria-hidden="true" />
              Run autoPatch
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline danger panel: the failed command, its exit code, and the captured logs.
 * Only the concise headline carries `role="alert"`, so a screen reader announces
 * "autoPatch failed" rather than reading the entire (possibly long) stderr.
 */
function AutoPatchFailure({ result }: { result: AutoPatchRunFailure }) {
  const log = (result.stderr || result.stdout || '').trim();
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-danger/40 bg-danger-tint px-3 py-3">
      <p role="alert" className="flex items-center gap-1.5 text-sm font-semibold text-danger">
        <AlertTriangle className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        autoPatch failed{result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}
      </p>
      <code className="block break-all text-xs text-text-secondary">{result.command}</code>
      {log && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface p-2 text-xs text-text-secondary">
          {log}
        </pre>
      )}
    </div>
  );
}
