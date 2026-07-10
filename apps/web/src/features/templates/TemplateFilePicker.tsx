import { useEffect, useMemo, useState } from 'react';
import { FileCode, Loader2, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/sonner';
import { ApiError } from '@/lib/api/client';
import { useApplyTemplateFiles, useTemplateFilesQuery, useTemplatesQuery } from './useTemplates';

/**
 * TemplateFilePicker - "Add from template file": pick a template, choose which of
 * its files to import into the current case (they overwrite same-path case files,
 * since the user selected them on purpose). After import the files show up in the
 * case editor to modify or delete. A search box filters the file list.
 */
export function TemplateFilePicker({
  projectId,
  open,
  onOpenChange,
  onImported,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: (applied: string[]) => void;
}) {
  const templates = useTemplatesQuery(open);
  const [templateId, setTemplateId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const files = useTemplateFilesQuery(templateId, !!templateId);
  const importFiles = useApplyTemplateFiles(projectId);

  // Clear selection when the template changes; reset everything when reopened.
  useEffect(() => setSelected(new Set()), [templateId]);
  useEffect(() => {
    if (open) {
      setTemplateId('');
      setSelected(new Set());
      setQuery('');
    }
  }, [open]);

  const filePaths = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (files.data ?? [])
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path)
      .filter((path) => !q || path.toLowerCase().includes(q))
      .sort();
  }, [files.data, query]);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleImport = async () => {
    if (selected.size === 0) return;
    try {
      const result = await importFiles.mutateAsync({ templateId, paths: [...selected] });
      toast.success(
        `Imported ${result.applied.length} file${result.applied.length === 1 ? '' : 's'}.`,
      );
      onImported?.(result.applied);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not import the files.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add from template file</DialogTitle>
          <DialogDescription>
            Pick a template, then the files to import into your case. Selected files overwrite any
            file at the same path; you can edit or delete them after.
          </DialogDescription>
        </DialogHeader>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-text">Template</span>
          <NativeSelect
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            disabled={templates.isPending || importFiles.isPending}
          >
            <option value="" disabled>
              Choose a template…
            </option>
            {(templates.data ?? []).map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
                {template.tags.length > 0 ? ` (${template.tags.join(', ')})` : ''}
              </option>
            ))}
          </NativeSelect>
        </label>

        {templateId && (
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
              placeholder="Search files…"
              aria-label="Search template files"
              spellCheck={false}
              autoComplete="off"
              className="pl-8"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-md border border-border">
          {!templateId ? (
            <p className="px-3 py-8 text-center text-sm text-text-secondary">
              Choose a template to see its files.
            </p>
          ) : files.isPending ? (
            <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
              <Loader2 className="size-5 animate-spin text-text-secondary" aria-hidden="true" />
              <span className="sr-only">Loading files</span>
            </div>
          ) : filePaths.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-text-secondary">
              {query ? 'No files match your search.' : 'This template has no files.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {filePaths.map((path) => (
                <li key={path}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-bg">
                    <input
                      type="checkbox"
                      checked={selected.has(path)}
                      onChange={() => toggle(path)}
                      className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                    />
                    <FileCode
                      className="size-4 shrink-0 text-text-secondary"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono text-xs text-text" translate="no">
                      {path}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={importFiles.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleImport()}
            loading={importFiles.isPending}
            disabled={selected.size === 0}
          >
            Import {selected.size > 0 ? `${selected.size} file${selected.size === 1 ? '' : 's'}` : 'files'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
