import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getServerConfig, type ServerConfig } from '@/lib/api/config';

/**
 * ProjectTerminalButton - a header action (visible from every project tab) that opens
 * a shell in the project's directory. Rendered only when the server reports the terminal
 * feature is enabled (it is OFF by default), so on a standard deploy nothing shows and
 * no shell endpoint is reachable. xterm + the WebSocket bridge are lazy-loaded on open.
 */

const TerminalView = lazy(() =>
  import('./TerminalView').then((module) => ({ default: module.TerminalView })),
);

export function ProjectTerminalButton({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useQuery<ServerConfig>({
    queryKey: ['server-config'],
    queryFn: getServerConfig,
    staleTime: Infinity,
    retry: false,
  });

  // Hidden until the server confirms the feature is on (default off -> nothing renders).
  if (!config.data?.terminalEnabled) return null;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label="Open a terminal in this project's directory"
      >
        <SquareTerminal strokeWidth={1.75} aria-hidden="true" />
        Terminal
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[80vh] w-[90vw] max-w-[70rem] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border p-4 pr-12">
            <DialogTitle>Terminal</DialogTitle>
            <DialogDescription>
              A shell in{' '}
              <span className="font-medium text-text" translate="no">
                {projectTitle}
              </span>
              &apos;s project directory. Navigate and inspect the files; source the OpenFOAM
              environment to run its tools.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col p-4">
            {open && (
              <Suspense fallback={<TerminalLoading />}>
                <TerminalView projectId={projectId} />
              </Suspense>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Skeleton while xterm + the terminal bridge lazy-load. */
function TerminalLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center rounded-md"
      style={{ backgroundColor: '#1A2230' }}
      role="status"
      aria-label="Loading the terminal"
    >
      <Loader2 className="size-5 animate-spin text-[#9AA4B2]" strokeWidth={2} aria-hidden="true" />
    </div>
  );
}
