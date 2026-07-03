import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAccessToken } from '@/lib/api/client';

/**
 * TerminalView - an xterm.js terminal bridged to the project's shell over a WebSocket.
 *
 * The terminal surface is a deliberate dark "device" inset (like a code block) within
 * the otherwise light app: ANSI output needs a dark background to stay readable, and the
 * chrome around it stays on-brand. Lazy-loaded by ProjectTerminalButton so xterm is not
 * in the main bundle. Connection state drives an inline status + reconnect, never a
 * silent dead terminal.
 */

/** Brand-tinted dark terminal theme (ink background, orange cursor). */
const TERMINAL_THEME = {
  background: '#1A2230',
  foreground: '#E4E8EE',
  cursor: '#EE7F00',
  cursorAccent: '#1A2230',
  selectionBackground: 'rgba(30, 99, 181, 0.45)',
  black: '#1A2230',
  red: '#E5484D',
  green: '#30A46C',
  yellow: '#EE7F00',
  blue: '#1E63B5',
  magenta: '#8E4EC6',
  cyan: '#3DB9CF',
  white: '#E4E8EE',
  brightBlack: '#5B6676',
  brightWhite: '#FFFFFF',
} as const;

type Status = 'connecting' | 'open' | 'closed' | 'error';

/** Derive the terminal WebSocket URL from the HTTP API base (http->ws, https->wss). */
function terminalWsUrl(projectId: string): string {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  if (!base) throw new Error('VITE_API_URL is not set');
  return `${base.replace(/^http/, 'ws')}/projects/${encodeURIComponent(projectId)}/terminal`;
}

export function TerminalView({ projectId }: { projectId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [reason, setReason] = useState<string | null>(null);
  // Bumping this key tears down and recreates the terminal + socket (Reconnect).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily:
        'ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not measured yet */
    }

    const token = getAccessToken();
    let socket: WebSocket;
    try {
      // The access token rides as the second subprotocol value (a WebSocket cannot set
      // an Authorization header); the server reads and verifies it on upgrade.
      socket = new WebSocket(terminalWsUrl(projectId), token ? ['bearer', token] : ['bearer']);
    } catch {
      setStatus('error');
      setReason('Could not open a connection.');
      term.dispose();
      return;
    }

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* mid-teardown */
      }
    });
    observer.observe(host);

    socket.onopen = () => {
      setStatus('open');
      setReason(null);
      sendResize();
      term.focus();
    };
    socket.onmessage = (event) => {
      let msg: { type?: string; data?: string; code?: number | null; pty?: boolean };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'ready') {
        if (msg.pty === false) {
          term.writeln(
            '\x1b[38;2;154;164;178m[basic shell: no PTY on this server - cd/ls/cat work, ' +
              'line editing and full-screen apps do not]\x1b[0m',
          );
        }
      } else if (msg.type === 'exit') {
        term.writeln('\r\n\x1b[38;2;154;164;178m[session ended]\x1b[0m');
      }
    };
    socket.onerror = () => {
      setStatus('error');
      setReason('Connection error. The terminal may be disabled or unreachable.');
    };
    socket.onclose = (event) => {
      setStatus((prev) => (prev === 'error' ? prev : 'closed'));
      if (event.code === 1006) setReason('Connection closed unexpectedly.');
    };

    const dataSub = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    return () => {
      observer.disconnect();
      dataSub.dispose();
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      term.dispose();
    };
  }, [projectId, attempt]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <StatusPill status={status} />
        {(status === 'closed' || status === 'error') && (
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCcw strokeWidth={1.75} aria-hidden="true" />
            Reconnect
          </Button>
        )}
      </div>
      {reason && (
        <p role="status" className="text-xs text-text-secondary">
          {reason}
        </p>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden overscroll-contain rounded-md p-2"
        style={{ backgroundColor: TERMINAL_THEME.background }}
      />
    </div>
  );
}

/** Small connection-state indicator (color conveys state, text carries the meaning). */
function StatusPill({ status }: { status: Status }) {
  const meta: Record<Status, { label: string; className: string }> = {
    connecting: { label: 'Connecting…', className: 'bg-bg text-text-secondary' },
    open: { label: 'Connected', className: 'bg-success-tint text-success' },
    closed: { label: 'Disconnected', className: 'bg-bg text-text-secondary' },
    error: { label: 'Connection error', className: 'bg-danger-tint text-danger' },
  };
  const { label, className } = meta[status];
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium ${className}`}
    >
      {status === 'connecting' && (
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
