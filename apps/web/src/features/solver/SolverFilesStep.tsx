import { useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowLeft, Check, FilePlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { CaseEntry } from '@/lib/api/types';
import {
  useCaseFileContentQuery,
  useCaseFilesQuery,
  useCreateCaseFile,
  useDeleteCaseDir,
  useDeleteCaseFile,
  useMoveCaseEntry,
  useSaveCaseFile,
} from '@/features/projects/useCaseFiles';
import { FileTreeEditor, type FileTreeResource } from '@/features/files/FileTreeEditor';
import { TemplateFilePicker } from '@/features/templates/TemplateFilePicker';

/** Keep only the config files: system/, 0/, constant/, minus the binary mesh. */
function isConfigFile(path: string): boolean {
  const top = path.split('/')[0];
  if (top !== 'system' && top !== '0' && top !== 'constant') return false;
  if (path === 'constant/polyMesh' || path.startsWith('constant/polyMesh/')) return false;
  return true;
}

/**
 * SolverFilesStep - step 3 of the solver setup, in a 90% overlay: the app's own
 * file editor (Easy + Advanced, auto-save) scoped to system / 0 / constant (the
 * mesh is hidden), plus "Add from template file" to pull in files from a saved
 * template. Back returns to the turbulence step; Done (or closing) finishes.
 */
export function SolverFilesStep({
  projectId,
  open,
  onBack,
  onDone,
}: {
  projectId: string;
  open: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  // The case-file hooks bound to this project, with the tree scoped to the config
  // folders (mirrors the full editor used on the project Edit page).
  const resource: FileTreeResource = {
    useFiles: () => {
      const query = useCaseFilesQuery(projectId);
      return {
        ...query,
        data: query.data?.filter((entry) => isConfigFile(entry.path)),
      } as UseQueryResult<CaseEntry[], Error>;
    },
    useContent: (path) => useCaseFileContentQuery(projectId, path),
    useSave: () => useSaveCaseFile(projectId),
    useCreate: () => useCreateCaseFile(projectId),
    useDelete: () => useDeleteCaseFile(projectId),
    useDeleteDir: () => useDeleteCaseDir(projectId),
    useMove: () => useMoveCaseEntry(projectId),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
    >
      <DialogContent className="flex h-[90vh] w-[90vw] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border p-4 pr-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <DialogTitle>Edit case files</DialogTitle>
              <DialogDescription>
                Step 3 of 3. Fine-tune the system, 0 and constant files (Easy or Advanced). Changes
                save automatically.
              </DialogDescription>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
              <FilePlus strokeWidth={1.75} aria-hidden="true" />
              Add from template file
            </Button>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <FileTreeEditor
            resource={resource}
            enableEasyMode
            emptyFilesHint="No editable config files yet. Generate the solver setup first, or add a file above."
          />
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border p-4">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft strokeWidth={1.75} aria-hidden="true" />
            Back
          </Button>
          <Button variant="primary" onClick={onDone}>
            <Check strokeWidth={1.9} aria-hidden="true" />
            Done
          </Button>
        </footer>

        <TemplateFilePicker projectId={projectId} open={pickerOpen} onOpenChange={setPickerOpen} />
      </DialogContent>
    </Dialog>
  );
}
