import { useEffect, useMemo, useState } from 'react';
import { MESH_PATCH_SETTINGS, MESH_PATCH_TYPES, PATCH_ROLES } from '@dive/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import type { MeshPatch, MeshPatchEdit, MeshPatchSetting } from '@/lib/api/types';
import { useEditMeshSourcePatches } from '@/features/projects/useMeshes';
import { useEditPatches } from './useMesh';
import type { MeshTarget } from './MeshViewer';

/**
 * EditPatchesDialog - edit ALL boundary patch names and types in one overlay,
 * then save once (replaces the per-row inline editing).
 *
 * Each row shows the patch's original name (read-only, the identity anchor), an
 * editable name field, and a type select. Names are validated live as OpenFOAM
 * words and for uniqueness; only the rows that actually changed are sent. On
 * save the server rewrites constant/polyMesh/boundary and every 0/ field, and
 * (on the first edit) captures the original into the backup slot.
 */

// Letter/underscore start, then letters/digits/underscore/hyphen. Hyphens are valid
// OpenFOAM words and routine in Fluent .msh zone names (velocity-inlet, wall-1), so
// they must pass validation — matching what the mesh parser already accepts.
const PATCH_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

interface Row {
  /** Original patch name — identifies the patch and never changes here. */
  from: string;
  /** Original geometric type, to detect a real change. */
  originalType: string;
  /** Editable new name. */
  name: string;
  /** Editable new type. */
  type: string;
}

export function EditPatchesDialog({
  projectId,
  target,
  open,
  patches,
  onClose,
  onSaved,
}: {
  projectId: string;
  /** Which mesh is being edited: the project case mesh or a library source. */
  target: MeshTarget;
  open: boolean;
  /** Current patches (from the manifest) to seed the editable rows. */
  patches: MeshPatch[];
  onClose: () => void;
  /** Called after a successful save with the (oldName -> newName) renames. */
  onSaved: (renames: Array<{ from: string; to: string }>) => void;
}) {
  // Both mutations are created every render (stable hook order); the active target
  // picks which one actually runs. The case path also rewrites the 0/ fields; a
  // source is boundary-only (C4).
  const caseEdit = useEditPatches(projectId);
  const sourceEdit = useEditMeshSourcePatches(projectId);
  const pending = target.kind === 'source' ? sourceEdit.isPending : caseEdit.isPending;
  const [rows, setRows] = useState<Row[]>([]);

  // Re-seed the rows from the live patches each time the overlay opens.
  useEffect(() => {
    if (open) {
      setRows(
        patches.map((p) => ({ from: p.name, originalType: p.type, name: p.name, type: p.type })),
      );
    }
  }, [open, patches]);

  // Names that appear on more than one row (case-sensitive — OpenFOAM is).
  const duplicates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.name.trim();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name));
  }, [rows]);

  const rowError = (row: Row): string | null => {
    const value = row.name.trim();
    if (!value) return 'Enter a patch name.';
    if (!PATCH_NAME_RE.test(value)) {
      return 'Use letters, digits, underscore, or hyphen; it must not start with a digit.';
    }
    if (duplicates.has(value)) return 'Another patch already uses this name.';
    return null;
  };

  const hasErrors = rows.some((row) => rowError(row) !== null);

  const setName = (index: number, name: string) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, name } : row)));
  const setType = (index: number, type: string) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, type } : row)));

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (hasErrors) {
      // Move focus to the first row that needs fixing (Web Interface Guidelines:
      // focus the first error on submit) rather than disabling the submit button.
      const firstBad = rows.findIndex((row) => rowError(row) !== null);
      if (firstBad >= 0) document.getElementById(`patch-name-${firstBad}`)?.focus();
      return;
    }

    const edits: MeshPatchEdit[] = rows
      .filter((row) => row.name.trim() !== row.from || row.type !== row.originalType)
      .map((row) => ({ from: row.from, to: row.name.trim(), type: row.type as MeshPatchSetting }));

    if (edits.length === 0) {
      onClose();
      return;
    }

    try {
      if (target.kind === 'source') {
        await sourceEdit.mutateAsync({ meshId: target.meshId, edits });
      } else {
        await caseEdit.mutateAsync(edits);
      }
      const renames = edits
        .filter((e) => e.to !== e.from)
        .map((e) => ({ from: e.from, to: e.to }));
      toast.success(
        edits.length === 1 ? 'Patch updated.' : `${edits.length} patches updated.`,
      );
      onSaved(renames);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PATCH_EXISTS') {
        toast.error('Two patches would share a name. Make every name unique.');
        return;
      }
      toast.error(
        err instanceof ApiError ? err.message : 'Could not save the patches. Please try again.',
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="max-w-[44rem] overscroll-contain">
        <DialogHeader>
          <DialogTitle>Edit names &amp; types</DialogTitle>
          <DialogDescription>
            Rename patches, set their geometric type, or apply an inlet/outlet BC preset. Changes
            are written to the mesh boundary and every field&rsquo;s boundaryField, then the 3D
            preview rebuilds.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-col gap-4">
          {/* Column headers, aligned with each row's 3-column grid. */}
          <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,10rem)] gap-3 px-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
            <span>Patch</span>
            <span>Name</span>
            <span>Type</span>
          </div>

          <div className="max-h-[min(55vh,28rem)] min-h-0 overflow-y-auto overscroll-contain rounded-md border border-border">
            <ul className="divide-y divide-border">
              {rows.map((row, index) => {
                const error = rowError(row);
                const nameId = `patch-name-${index}`;
                return (
                  <li key={row.from} className="flex flex-col gap-1 p-2">
                    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_minmax(0,10rem)] items-center gap-3">
                      <span
                        className="truncate font-mono text-sm text-text-secondary"
                        title={row.from}
                      >
                        {row.from}
                      </span>
                      <Input
                        id={nameId}
                        name={`patch-name-${index}`}
                        value={row.name}
                        onChange={(event) => setName(index, event.target.value)}
                        disabled={pending}
                        spellCheck={false}
                        autoComplete="off"
                        translate="no"
                        aria-label={`New name for ${row.from}`}
                        aria-invalid={error !== null}
                        className="font-mono"
                      />
                      <TypeSelect
                        value={row.type}
                        from={row.from}
                        disabled={pending}
                        allowRoles={target.kind === 'case'}
                        onChange={(type) => setType(index, type)}
                      />
                    </div>
                    {error && (
                      <p className="pl-[8.75rem] text-xs text-danger" role="alert">
                        {error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Native type select, matching the patch table's styling. Geometric types and (for
 * the case mesh only) inlet/outlet flow roles are grouped separately. A value not in
 * the settable set (e.g. cyclic / processor from a merge) is still shown as the
 * current option so it is never silently dropped. Roles are hidden for a library
 * source, which has no 0/ fields to apply a preset to.
 */
function TypeSelect({
  value,
  from,
  disabled,
  allowRoles,
  onChange,
}: {
  value: string;
  from: string;
  disabled: boolean;
  allowRoles: boolean;
  onChange: (type: string) => void;
}) {
  const inSettings = (MESH_PATCH_SETTINGS as readonly string[]).includes(value);
  return (
    <NativeSelect
      aria-label={`Type for ${from}`}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {!inSettings && <option value={value}>{value}</option>}
      <optgroup label="Geometric type">
        {MESH_PATCH_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </optgroup>
      {allowRoles && (
        <optgroup label="Flow role — applies a BC preset">
          {PATCH_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </optgroup>
      )}
    </NativeSelect>
  );
}
