import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * RenameDialog - a small controlled modal to rename an entity by a single name.
 *
 * Reused by the meshing-session list and the projects list. Reseeds its input
 * whenever it opens (so it always reflects the item being renamed), and the Save
 * CTA is disabled until the trimmed value is non-empty AND actually changed.
 */
export function RenameDialog({
  open,
  onOpenChange,
  title,
  label,
  currentName,
  maxLength = 120,
  pending = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  currentName: string;
  maxLength?: number;
  pending?: boolean;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(currentName);

  // Reseed each time the dialog opens (or targets a different item's name).
  useEffect(() => {
    if (open) setValue(currentName);
  }, [open, currentName]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== currentName.trim() && !pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) onSubmit(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <Field label={label}>
            <Input
              autoFocus
              value={value}
              maxLength={maxLength}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
