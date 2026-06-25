import { useEffect, useRef } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { MeshPatch } from '@/lib/api/types';

/**
 * PatchTable - the read-only Name / Type / nFaces list of boundary patches.
 * Editing names and types now happens in a single overlay (EditPatchesDialog),
 * and "Show all" lives in the toolbar above, so this is purely the inspection +
 * 3D-selection table.
 *
 * Selection is shared with the 3D canvas: clicking a row selects that patch
 * (highlighted orange in the scene and dimmed elsewhere); the selected row gets
 * a full accent-tint wash + semibold name + aria-selected (the orange wash is
 * the visual link to the highlighted surface, not a side stripe). Rows are
 * keyboard-activatable (Enter/Space). When the selection is driven from the
 * canvas, the selected row scrolls into view.
 */

/** Locale-aware integer formatter for the face counts (matches the app's en-GB). */
const numberFormatter = new Intl.NumberFormat('en-GB');

export function PatchTable({
  patches,
  selected,
  onSelect,
}: {
  patches: MeshPatch[];
  /** Currently selected patch name, or null for "show all". */
  selected: string | null;
  /** Select a patch (or null to clear). */
  onSelect: (name: string | null) => void;
}) {
  const selectedRowRef = useRef<HTMLTableRowElement>(null);

  // Keep the selected row visible when the selection comes from the 3D canvas.
  // (Guarded: jsdom and some environments do not implement scrollIntoView.)
  useEffect(() => {
    const row = selectedRowRef.current;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border">
      <Table>
        <TableHeader className="sticky top-0 z-base">
          <TableRow className="hover:bg-bg">
            <TableHead className="px-3 first:pl-3.5">Name</TableHead>
            <TableHead className="px-3">Type</TableHead>
            <TableHead className="px-3 text-right last:pr-3.5">nFaces</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {patches.map((patch) => {
            const isSelected = patch.name === selected;
            return (
              <TableRow
                key={patch.name}
                ref={isSelected ? selectedRowRef : undefined}
                tabIndex={0}
                aria-selected={isSelected}
                onClick={() => onSelect(isSelected ? null : patch.name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(isSelected ? null : patch.name);
                  }
                }}
                className={cn(
                  'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring',
                  isSelected && 'bg-accent-tint hover:bg-accent-tint',
                )}
              >
                <TableCell
                  className={cn(
                    'h-11 px-3 font-mono text-text first:pl-3.5',
                    isSelected ? 'font-semibold' : 'font-normal',
                  )}
                >
                  {patch.name}
                </TableCell>
                <TableCell
                  className="h-11 max-w-[7.5rem] truncate px-3 text-text-secondary"
                  title={patch.type}
                >
                  {patch.type}
                </TableCell>
                <TableCell className="h-11 whitespace-nowrap px-3 text-right text-text-secondary last:pr-3.5">
                  {numberFormatter.format(patch.nFaces)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
