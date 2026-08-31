import { useState } from 'react';
import { Copy, MoreHorizontal, Pencil, Save, Trash2 } from 'lucide-react';
import { CHAMBER_SAVE_NAME_MAX } from '@dive/shared';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { ChamberInput, ChamberSaveSummary } from '@/lib/api/types';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  useChamberSavesQuery,
  useCreateChamberSave,
  useDeleteChamberSave,
  useUpdateChamberSave,
} from './useChamberSaves';

/** Which name dialog is open (Save reuses it for create/overwrite). */
type NameDialogMode = 'save' | 'rename' | 'duplicate' | null;

/**
 * ChamberSavesMenu - the saved-builds controls in the Chamber page header:
 * a dropdown that loads a save into the form, Save (create or overwrite the
 * loaded save by name), and a "more" menu with Rename / Duplicate / Delete.
 * Saves are team-shared; rename/overwrite/delete are author-or-admin only,
 * duplicate creates the current user's own copy. Saving is always optional —
 * Generate never needs it.
 */
export function ChamberSavesMenu({
  snapshot,
  onLoad,
}: {
  /** The current form as a build body, or null while the form is invalid. */
  snapshot: ChamberInput | null;
  /** Apply a loaded save to the form + constraints. */
  onLoad: (save: ChamberSaveSummary) => void;
}) {
  const { user } = useAuth();
  const savesQuery = useChamberSavesQuery();
  const createSave = useCreateChamberSave();
  const updateSave = useUpdateChamberSave();
  const deleteSave = useDeleteChamberSave();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NameDialogMode>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const saves = savesQuery.data ?? [];
  const selected = saves.find((s) => s.id === selectedId) ?? null;
  const canManage = (save: ChamberSaveSummary) =>
    user != null && (user.role === 'SUPER_ADMIN' || save.owner.id === user.id);

  const pending = createSave.isPending || updateSave.isPending;

  const placeholder = savesQuery.isPending
    ? 'Loading saved builds…'
    : savesQuery.isError
      ? 'Could not load saved builds'
      : saves.length === 0
        ? 'No saved builds yet'
        : 'Load a saved build…';

  function handleLoad(id: string) {
    const save = saves.find((s) => s.id === id);
    if (!save) return;
    setSelectedId(id);
    onLoad(save);
    toast.success(`Loaded "${save.name}".`);
  }

  /** Save: overwrite the save carrying this exact name (if manageable) or create. */
  async function submitSave(name: string): Promise<string | null> {
    if (!snapshot) return 'Fix the form errors before saving.';
    const existing = saves.find((s) => s.name === name);
    if (existing && !canManage(existing)) {
      return `"${name}" belongs to ${existing.owner.fullName} — pick another name.`;
    }
    try {
      if (existing) {
        await updateSave.mutateAsync({ id: existing.id, snapshot });
        setSelectedId(existing.id);
        toast.success(`Updated "${name}".`);
      } else {
        const created = await createSave.mutateAsync({ name, snapshot });
        setSelectedId(created.id);
        toast.success(`Saved "${name}".`);
      }
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Could not save the build.';
    }
  }

  async function submitRename(name: string): Promise<string | null> {
    if (!selected) return null;
    try {
      await updateSave.mutateAsync({ id: selected.id, name });
      toast.success(`Renamed to "${name}".`);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Could not rename the save.';
    }
  }

  async function submitDuplicate(name: string): Promise<string | null> {
    if (!selected) return null;
    try {
      const created = await createSave.mutateAsync({ name, snapshot: selected.snapshot });
      setSelectedId(created.id);
      toast.success(`Duplicated as "${name}".`);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Could not duplicate the save.';
    }
  }

  async function confirmDelete() {
    if (!selected) return;
    const { name } = selected;
    try {
      await deleteSave.mutateAsync(selected.id);
      setSelectedId(null);
      toast.success(`Deleted "${name}".`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the save.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <NativeSelect
        className="w-64"
        aria-label="Load a saved build"
        value={selectedId ?? ''}
        disabled={savesQuery.isPending || savesQuery.isError || saves.length === 0}
        onChange={(e) => e.target.value && handleLoad(e.target.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {saves.map((save) => (
          <option key={save.id} value={save.id}>
            {save.name} — {save.owner.fullName}
          </option>
        ))}
      </NativeSelect>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!snapshot}
        onClick={() => setDialog('save')}
      >
        <Save className="size-4" strokeWidth={1.75} aria-hidden="true" />
        Save
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!selected}
            aria-label="Saved build actions"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!selected || !canManage(selected)}
            onSelect={() => setDialog('rename')}
          >
            <Pencil className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('duplicate')}>
            <Copy className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selected || !canManage(selected)}
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === 'save' && (
        <NameDialog
          title="Save build"
          description={
            selected
              ? `Keeping the name overwrites "${selected.name}"; a new name creates a new save.`
              : 'Names are shared with the whole team.'
          }
          initialName={selected?.name ?? ''}
          submitLabel="Save"
          pending={pending}
          onSubmit={submitSave}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'rename' && selected && (
        <NameDialog
          title={`Rename "${selected.name}"`}
          description="The snapshot itself is unchanged."
          initialName={selected.name}
          submitLabel="Rename"
          pending={pending}
          onSubmit={submitRename}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'duplicate' && selected && (
        <NameDialog
          title={`Duplicate "${selected.name}"`}
          description="Creates your own copy of this saved build."
          initialName={`${selected.name} (copy)`}
          submitLabel="Duplicate"
          pending={pending}
          onSubmit={submitDuplicate}
          onClose={() => setDialog(null)}
        />
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{selected?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved build for the whole team. Already-generated geometry is
              unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Shared name dialog for Save / Rename / Duplicate: one field, inline error. */
function NameDialog({
  title,
  description,
  initialName,
  submitLabel,
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  pending: boolean;
  /** Returns an inline error message, or null on success (closes the dialog). */
  onSubmit: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A name is required.');
      return;
    }
    const failure = await onSubmit(trimmed);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <Field label="Name" error={error ?? undefined}>
            <Input
              value={name}
              maxLength={CHAMBER_SAVE_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
