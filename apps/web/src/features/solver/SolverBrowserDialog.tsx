import { useMemo, useState } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  SOLVER_CATEGORIES,
  SOLVER_LIBRARY,
  isConfigurableSolver,
  type SolverId,
  type SolverInfo,
} from '@/lib/api/types';

/**
 * SolverBrowserDialog - the "choose a solver" overlay: the whole solver library
 * (every ESI binary on this build) grouped by physics family, searchable, each with
 * a one-line description. A "Guided" badge marks the solvers the app fully sets up
 * and easy-configures; the rest are selectable and configured in the file editor.
 * Picking a solver selects it and closes.
 */
interface SolverBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: SolverId;
  onSelect: (id: SolverId) => void;
}

export function SolverBrowserDialog({ open, onOpenChange, value, onSelect }: SolverBrowserDialogProps) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (solver: SolverInfo) =>
      !q ||
      solver.id.toLowerCase().includes(q) ||
      solver.label.toLowerCase().includes(q) ||
      solver.summary.toLowerCase().includes(q);
    return SOLVER_CATEGORIES.map((category) => ({
      category,
      items: SOLVER_LIBRARY.filter((solver) => solver.category === category.id && match(solver)),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  const pick = (id: SolverId) => {
    onSelect(id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Choose a solver</DialogTitle>
          <DialogDescription>
            Every solver on this OpenFOAM build, by physics. Guided solvers get a step-by-step
            setup; the others you configure in the file editor.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search solvers…"
            aria-label="Search solvers"
            spellCheck={false}
            autoComplete="off"
            className="pl-8"
          />
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-auto overscroll-contain px-1">
          {groups.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-text-secondary">
              No solver matches “{query}”.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <section key={group.category.id} aria-label={group.category.label}>
                  <h3 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {group.category.label}
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {group.items.map((solver) => (
                      <li key={solver.id}>
                        <SolverRow
                          solver={solver}
                          selected={solver.id === value}
                          guided={isConfigurableSolver(solver.id)}
                          onSelect={() => pick(solver.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One selectable solver row: label + mono id + summary + a guided/manual badge. */
function SolverRow({
  solver,
  selected,
  guided,
  onSelect,
}: {
  solver: SolverInfo;
  selected: boolean;
  guided: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1',
        selected
          ? 'border-primary bg-primary-tint'
          : 'border-border bg-surface hover:border-border-strong hover:bg-bg',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('text-sm font-medium', selected ? 'text-primary' : 'text-text')}>
            {solver.label}
          </span>
          {selected && (
            <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
          )}
        </span>
        {guided ? (
          <Badge variant="primary" className="shrink-0">
            <Sparkles className="size-3" strokeWidth={1.75} aria-hidden="true" />
            Guided
          </Badge>
        ) : (
          <Badge variant="neutral" className="shrink-0">
            Manual
          </Badge>
        )}
      </div>
      <span className="font-mono text-xs text-text-secondary" translate="no">
        {solver.id}
      </span>
      <span className="text-xs text-text-secondary">{solver.summary}</span>
    </button>
  );
}
