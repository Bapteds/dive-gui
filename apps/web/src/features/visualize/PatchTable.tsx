import { useEffect, useRef } from 'react';
import { Layers, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
 * PatchTable - the Name / Type / nFaces list of boundary patches (preserves the
 * original inspector's F4/F5/F6).
 *
 * Selection is shared with the 3D canvas: clicking a row selects that patch
 * (highlighted orange in the scene and dimmed elsewhere); the selected row gets
 * a full accent-tint wash + semibold name + aria-selected (the orange wash is
 * the visual link to the highlighted surface, not a side stripe). "Show all"
 * clears the selection (F6). Rows are keyboard-activatable (Enter/Space). When
 * the selection is driven from the canvas, the selected row scrolls into view.
 */

/** Locale-aware integer formatter for the face counts (matches the app's en-GB). */
const numberFormatter = new Intl.NumberFormat('en-GB');

export function PatchTable({
  patches,
  selected,
  onSelect,
  onRename,
}: {
  patches: MeshPatch[];
  /** Currently selected patch name, or null for "show all". */
  selected: string | null;
  /** Select a patch (or null to clear). */
  onSelect: (name: string | null) => void;
  /** Open the rename flow for a patch (omit to hide the rename affordance). */
  onRename?: (name: string) => void;
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
    <div className="flex min-h-0 flex-col gap-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-full"
        onClick={() => onSelect(null)}
        disabled={selected === null}
      >
        <Layers strokeWidth={1.75} aria-hidden="true" />
        Show all
      </Button>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-base">
            <TableRow className="hover:bg-bg">
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">nFaces</TableHead>
              {onRename && (
                <TableHead className="w-px">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
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
                      'h-11 font-mono text-text',
                      isSelected ? 'font-semibold' : 'font-normal',
                    )}
                  >
                    {patch.name}
                  </TableCell>
                  <TableCell className="h-11 text-text-secondary">{patch.type}</TableCell>
                  <TableCell className="h-11 text-right text-text-secondary">
                    {numberFormatter.format(patch.nFaces)}
                  </TableCell>
                  {onRename && (
                    // Keep row click/keys from firing when interacting with the action.
                    <TableCell
                      className="h-11 pl-0 pr-2 text-right"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-text-secondary hover:text-text"
                        aria-label={`Rename ${patch.name}`}
                        onClick={() => onRename(patch.name)}
                      >
                        <Pencil strokeWidth={1.75} aria-hidden="true" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
