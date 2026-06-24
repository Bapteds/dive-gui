import { useEffect, useRef } from 'react';

/**
 * RunLog - the solver's streaming output, in a focusable scrollable region
 * (same treatment as the conversion pipeline log). While the run is live the
 * view auto-scrolls to the tail, unless the user has scrolled up to read back.
 */
export function RunLog({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom (auto-follow) vs. scrolled up.
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">Log</span>
        {live && (
          <span className="text-xs text-text-secondary" aria-live="off">
            streaming
          </span>
        )}
      </div>
      <div
        ref={ref}
        onScroll={handleScroll}
        tabIndex={0}
        role="log"
        aria-label="Solver output log"
        className="max-h-72 overflow-auto overscroll-contain rounded-md border border-border bg-surface px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        {text ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text" translate="no">
            {text}
          </pre>
        ) : (
          <p className="font-mono text-xs text-text-secondary">No output yet.</p>
        )}
      </div>
    </div>
  );
}
