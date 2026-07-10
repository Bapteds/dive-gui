import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  File as FileIcon,
  FilePlus2,
  Layers,
  Loader2,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/features/auth/AuthProvider';
import type { ApplyDecision, ApplyPreview, CaseVerification, Template } from '@/lib/api/types';
import {
  useApplyTemplate,
  usePreviewApplyTemplate,
  useTemplatesQuery,
} from '@/features/templates/useTemplates';
import { useSyncBoundaries } from '@/features/projects/useCaseFiles';

/**
 * ApplyTemplateFlow - the three-step dialog flow opened by "Verify case".
 *
 *  1. Choice: report the verification, then offer to (a) add the built-in
 *     minimal base files (scaffold), (b) use a saved, shared template, or
 *     (c) ignore.
 *  2. Picker: list the shared templates (with author) and pick one. The server
 *     previews which files are new vs. conflicting. No conflicts -> apply now.
 *  3. Conflicts: resolve each colliding file (overwrite / keep, default keep),
 *     then apply. New files are always added.
 *
 * Mounted only while active (verification != null) so its internal step state
 * resets on each open and the templates list is fetched only when the picker
 * opens.
 */

interface ApplyTemplateFlowProps {
  projectId: string;
  /** The verification that opened the flow; null means the flow is closed. */
  verification: CaseVerification | null;
  /** Close the whole flow. */
  onClose: () => void;
  /** Add the built-in minimal base files (scaffold). */
  onApplyMinimal: () => void;
  /** Whether the minimal scaffold is in progress. */
  applyingMinimal: boolean;
}

type Step = 'choice' | 'picker' | 'conflicts';

export function ApplyTemplateFlow({
  projectId,
  verification,
  onClose,
  onApplyMinimal,
  applyingMinimal,
}: ApplyTemplateFlowProps) {
  const [step, setStep] = useState<Step>('choice');
  const [selected, setSelected] = useState<{ template: Template; preview: ApplyPreview } | null>(
    null,
  );
  // The template currently being previewed/applied from the picker (row spinner).
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Default on: a polyMesh given a template usually needs its 0/ boundaryFields
  // aligned to the mesh patches (the template brings its own patch names).
  const [applyBoundaries, setApplyBoundaries] = useState(true);

  const preview = usePreviewApplyTemplate(projectId);
  const apply = useApplyTemplate(projectId);
  const syncBoundaries = useSyncBoundaries(projectId);

  if (!verification) return null;

  const busy = preview.isPending || apply.isPending || applyingMinimal || syncBoundaries.isPending;

  const applied = async (result: { applied: string[] }) => {
    if (applyBoundaries) {
      try {
        await syncBoundaries.mutateAsync();
      } catch (err) {
        toast.error(
          err instanceof ApiError
            ? err.message
            : 'Applied the template, but could not align the boundaries.',
        );
      }
    }
    toast.success(
      `Applied ${result.applied.length} file${result.applied.length === 1 ? '' : 's'} from the template.`,
    );
    onClose();
  };

  /** Pick a template: preview conflicts, applying immediately when there are none. */
  const handlePick = async (template: Template) => {
    setPendingId(template.id);
    try {
      const result = await preview.mutateAsync({ templateId: template.id });
      if (result.conflicts.length === 0) {
        const applyResult = await apply.mutateAsync({ templateId: template.id });
        await applied(applyResult);
        return;
      }
      setSelected({ template, preview: result });
      setStep('conflicts');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not read that template.');
    } finally {
      setPendingId(null);
    }
  };

  /** Apply the selected template, resolving conflicts with the given decisions. */
  const handleApplyWithDecisions = async (decisions: Record<string, ApplyDecision>) => {
    if (!selected) return;
    try {
      const result = await apply.mutateAsync({ templateId: selected.template.id, decisions });
      await applied(result);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not apply the template.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {step === 'choice' && (
        <ChoiceDialog
          verification={verification}
          applyingMinimal={applyingMinimal}
          onApplyMinimal={onApplyMinimal}
          onChooseTemplate={() => setStep('picker')}
          onIgnore={onClose}
        />
      )}
      {step === 'picker' && (
        <PickerDialog
          onPick={(template) => void handlePick(template)}
          pendingId={pendingId ?? undefined}
          busy={busy}
          onBack={() => setStep('choice')}
          applyBoundaries={applyBoundaries}
          onToggleBoundaries={setApplyBoundaries}
        />
      )}
      {step === 'conflicts' && selected && (
        <ConflictsDialog
          template={selected.template}
          preview={selected.preview}
          applying={apply.isPending}
          onApply={(decisions) => void handleApplyWithDecisions(decisions)}
          onBack={() => setStep('picker')}
        />
      )}
    </Dialog>
  );
}

/** Step 1 — choose how to set up the case files. */
function ChoiceDialog({
  verification,
  applyingMinimal,
  onApplyMinimal,
  onChooseTemplate,
  onIgnore,
}: {
  verification: CaseVerification;
  applyingMinimal: boolean;
  onApplyMinimal: () => void;
  onChooseTemplate: () => void;
  onIgnore: () => void;
}) {
  return (
    <DialogContent className="overscroll-contain">
      <DialogHeader>
        <DialogTitle>Set up the case files</DialogTitle>
        <DialogDescription>
          {verification.canScaffold
            ? 'Some mandatory base files are missing. Add the built-in minimal set, apply a saved template, or do nothing.'
            : 'All mandatory base files are present. You can still apply a saved template, or close.'}
        </DialogDescription>
      </DialogHeader>

      {verification.canScaffold && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text">Missing base files</p>
          <ul className="rounded-md border border-border bg-bg/60 px-3 py-2.5">
            {verification.missingBase.map((path) => (
              <li key={path} className="flex items-center gap-2 py-0.5 text-sm text-text">
                <FileIcon
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="truncate font-mono text-sm">{path}</span>
              </li>
            ))}
          </ul>
          {!verification.hasMesh && (
            <p className="text-sm text-text-secondary">
              Note: the mesh (constant/polyMesh) is incomplete. It comes from your import and cannot
              be generated.
            </p>
          )}
        </div>
      )}

      <div className="mt-1 flex flex-col gap-2">
        {/* Use a saved template: a secondary (outline) action available always. */}
        <Button type="button" variant="secondary" onClick={onChooseTemplate} className="justify-start">
          <Layers strokeWidth={1.75} aria-hidden="true" />
          Use a saved template…
        </Button>
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onIgnore} disabled={applyingMinimal}>
          Ignore
        </Button>
        {verification.canScaffold && (
          <Button
            type="button"
            className="bg-cta font-bold text-white hover:bg-cta-hover"
            onClick={onApplyMinimal}
            loading={applyingMinimal}
          >
            <Sparkles strokeWidth={1.75} aria-hidden="true" />
            Add minimal base files
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 2 — pick one of the shared templates. */
function PickerDialog({
  onPick,
  pendingId,
  busy,
  onBack,
  applyBoundaries,
  onToggleBoundaries,
}: {
  onPick: (template: Template) => void;
  pendingId: string | undefined;
  busy: boolean;
  onBack: () => void;
  applyBoundaries: boolean;
  onToggleBoundaries: (value: boolean) => void;
}) {
  const { user } = useAuth();
  const { data: templates, isPending, isError, refetch, isRefetching } = useTemplatesQuery();

  return (
    <DialogContent className="overscroll-contain">
      <DialogHeader>
        <DialogTitle>Choose a template</DialogTitle>
        <DialogDescription>
          Apply a shared template to this case. Files that don&rsquo;t exist yet are added; existing
          files are kept unless you choose to overwrite them.
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-80 overflow-auto rounded-md border border-border">
        {isPending ? (
          <div className="flex items-center justify-center py-10" role="status" aria-live="polite">
            <Loader2 className="size-5 animate-spin text-text-secondary" strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">Loading templates</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-start gap-2 p-4" role="alert">
            <p className="text-sm text-text">We could not load the templates.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refetch()} loading={isRefetching}>
              Try again
            </Button>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <p className="text-sm font-medium text-text">No templates yet</p>
            <p className="max-w-xs text-sm text-text-secondary">
              Create one from the{' '}
              <Link to="/templates" className="text-primary hover:underline">
                Templates
              </Link>{' '}
              page, then apply it here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {templates.map((template) => {
              const isPendingRow = pendingId === template.id;
              const author = user?.id === template.owner.id ? 'You' : template.owner.email;
              return (
                <li key={template.id}>
                  <button
                    type="button"
                    onClick={() => onPick(template)}
                    disabled={busy}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-fast ease-out',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset',
                      'hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-tint text-primary">
                      {isPendingRow ? (
                        <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <Layers className="size-4" strokeWidth={1.75} aria-hidden="true" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-text">{template.name}</span>
                      <span className="truncate text-xs text-text-secondary">
                        {template.description ? template.description : `By ${author}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={applyBoundaries}
          onChange={(event) => onToggleBoundaries(event.target.checked)}
          disabled={busy}
          className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        />
        <span className="text-sm text-text">
          Apply the boundary type and name to the 0/ fields
          <span className="block text-xs text-text-secondary">
            Rewrites each field&apos;s boundaryField to match this mesh&apos;s patches, so the
            template&apos;s 0/ fields line up with your polyMesh.
          </span>
        </span>
      </label>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Step 3 — resolve per-file conflicts, then apply. */
function ConflictsDialog({
  template,
  preview,
  applying,
  onApply,
  onBack,
}: {
  template: Template;
  preview: ApplyPreview;
  applying: boolean;
  onApply: (decisions: Record<string, ApplyDecision>) => void;
  onBack: () => void;
}) {
  // Default every conflicting file to "keep" (never overwrite without intent).
  const [decisions, setDecisions] = useState<Record<string, ApplyDecision>>(() =>
    Object.fromEntries(preview.conflicts.map((path) => [path, 'keep' as ApplyDecision])),
  );

  const overwriteCount = preview.conflicts.filter((p) => decisions[p] === 'overwrite').length;

  return (
    <DialogContent className="overscroll-contain">
      <DialogHeader>
        <DialogTitle>Resolve conflicts</DialogTitle>
        <DialogDescription>
          Some files in &ldquo;{template.name}&rdquo; already exist in this case. Choose what to do
          with each. New files are always added.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <ul className="flex max-h-72 flex-col gap-2 overflow-auto">
          {preview.conflicts.map((path) => (
            <li
              key={path}
              className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileIcon
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="truncate font-mono text-sm text-text" title={path}>
                  {path}
                </span>
              </span>
              <div
                role="radiogroup"
                aria-label={`What to do with ${path}`}
                className="flex shrink-0 items-center gap-3"
              >
                {(['keep', 'overwrite'] as const).map((choice) => (
                  <label key={choice} className="flex items-center gap-1.5 text-sm text-text">
                    <input
                      type="radio"
                      name={`decision-${path}`}
                      value={choice}
                      checked={(decisions[path] ?? 'keep') === choice}
                      onChange={() => setDecisions((d) => ({ ...d, [path]: choice }))}
                      disabled={applying}
                      className="size-4 accent-primary"
                    />
                    {choice === 'keep' ? 'Keep' : 'Overwrite'}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>

        {preview.newFiles.length > 0 && (
          <div className="rounded-md border border-border bg-bg/60 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-sm font-medium text-text">
              <FilePlus2 className="size-4 text-primary" strokeWidth={1.75} aria-hidden="true" />
              {preview.newFiles.length} new file{preview.newFiles.length === 1 ? '' : 's'} will be
              added
            </p>
          </div>
        )}
      </div>

      <DialogFooter className="mt-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={applying}>
          Back
        </Button>
        <Button
          type="button"
          className="bg-cta font-bold text-white hover:bg-cta-hover"
          onClick={() => onApply(decisions)}
          loading={applying}
        >
          <CheckCircle2 strokeWidth={1.75} aria-hidden="true" />
          Apply{overwriteCount > 0 ? ` (overwrite ${overwriteCount})` : ''}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
