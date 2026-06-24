import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import { useRenamePatch } from './useMesh';

/**
 * RenamePatchDialog - rename a boundary patch from the Visualize tab.
 *
 * Open while `from` is non-null. The new name must be a valid OpenFOAM word and
 * must not collide with another patch (checked client-side, re-checked by the
 * server). On success the rename mutation drops the render cache so the manifest
 * rebuilds with the new name; the caller remaps the current selection.
 */

const PATCH_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function RenamePatchDialog({
  projectId,
  from,
  existingNames,
  onClose,
  onRenamed,
}: {
  projectId: string;
  /** The patch being renamed, or null when the dialog is closed. */
  from: string | null;
  /** All current patch names, for the client-side collision check. */
  existingNames: string[];
  onClose: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}) {
  const rename = useRenamePatch(projectId);

  const schema = z.object({
    name: z
      .string()
      .trim()
      .min(1, 'Enter a patch name.')
      .max(80, 'That name is too long.')
      .regex(PATCH_NAME_RE, 'Use letters, digits, or underscore; it must not start with a digit.')
      .refine(
        (value) => value === from || !existingNames.includes(value),
        'A patch with that name already exists.',
      ),
  });
  type Values = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onSubmit',
    defaultValues: { name: from ?? '' },
  });

  // Re-seed the field whenever a different patch is targeted.
  useEffect(() => {
    reset({ name: from ?? '' });
  }, [from, reset]);

  const onSubmit = handleSubmit(async (values) => {
    if (!from) return;
    const to = values.name.trim();
    if (to === from) {
      onClose();
      return;
    }
    try {
      await rename.mutateAsync({ from, to });
      toast.success(`Renamed “${from}” to “${to}”.`);
      onRenamed(from, to);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PATCH_EXISTS') {
        setError('name', { type: 'server', message: 'A patch with that name already exists.' });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not rename the patch. Please try again.');
    }
  });

  return (
    <Dialog
      open={from !== null}
      onOpenChange={(open) => {
        if (!open && !rename.isPending) onClose();
      }}
    >
      <DialogContent className="overscroll-contain">
        <DialogHeader>
          <DialogTitle>Rename patch</DialogTitle>
          <DialogDescription>
            Renames the boundary patch in the mesh and in every field&rsquo;s boundaryField, then
            rebuilds the 3D preview.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field label="Patch name" error={errors.name?.message}>
            <Input
              autoFocus
              spellCheck={false}
              autoComplete="off"
              translate="no"
              disabled={rename.isPending}
              {...register('name')}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={rename.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={rename.isPending}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
