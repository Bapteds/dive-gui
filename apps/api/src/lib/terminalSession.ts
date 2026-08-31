// A single interactive shell session for the project terminal.
//
// node-pty is an OPTIONAL native dependency. When it is present the session is a real
// pseudo-terminal (a prompt, colours, line editing, TTY-aware programs); when it is
// absent (its native binary failed to build on the target) we fall back to a piped
// interactive shell — enough to navigate and inspect the project (cd, ls, cat, run
// OpenFOAM tools), without full TTY features. The module is loaded through a guarded
// require so a missing/broken build degrades gracefully instead of crashing the API.
//
// This module is deliberately transport-agnostic: it knows nothing about WebSockets.
// The gateway (terminal.gateway.ts) bridges it to a client socket.
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { env } from '../config/env';

/** The subset of a node-pty process the session uses (typed locally so the optional
 *  dependency is not a compile-time requirement). */
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  kill(): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name?: string; cwd?: string; env?: NodeJS.ProcessEnv; cols?: number; rows?: number },
  ): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;

/** Load node-pty once, tolerating an absent package OR an unbuilt native binary. The
 *  API compiles to CommonJS (see tsconfig), so a plain require is correct here. */
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ptyModule = require('node-pty') as PtyModule;
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Whether a real PTY is available (else the session uses the piped fallback). */
export function isPtyAvailable(): boolean {
  return loadPty() !== null;
}

/** The shell to launch: the configured override, else a platform default. */
function resolveShell(): { file: string; args: string[] } {
  const override = env.TERMINAL_SHELL.trim();
  if (override) return { file: override, args: [] };
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  // `-i` forces an interactive shell so the user's rc file (aliases, PATH) is loaded
  // and a prompt is shown even without a TTY (the piped fallback).
  return { file: 'bash', args: ['-i'] };
}

/** A live terminal session, driven by the gateway. */
export interface TerminalSession {
  /** Whether this session is a real PTY (true) or the piped fallback (false). */
  readonly pty: boolean;
  /** Send user keystrokes / input to the shell. */
  write(data: string): void;
  /** Resize the terminal (no-op for the piped fallback). */
  resize(cols: number, rows: number): void;
  /** Register the shell's output handler. */
  onData(cb: (data: string) => void): void;
  /** Register the shell-exit handler (fires once). */
  onExit(cb: (code: number | null) => void): void;
  /** Terminate the shell. */
  kill(): void;
}

/**
 * Start a shell in `cwd`. Uses a real PTY when node-pty is available, else a piped
 * interactive shell. `extraEnv` is merged over the process environment (e.g. to point
 * the shell at the OpenFOAM environment).
 */
export function createTerminalSession(opts: {
  cwd: string;
  cols: number;
  rows: number;
  extraEnv?: NodeJS.ProcessEnv;
}): TerminalSession {
  const { cwd, cols, rows, extraEnv } = opts;
  const shell = resolveShell();
  const shellEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, TERM: 'xterm-256color' };
  const pty = loadPty();

  if (pty) {
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cwd,
      env: shellEnv,
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
    });
    let exited = false;
    return {
      pty: true,
      write: (data) => {
        if (!exited) proc.write(data);
      },
      resize: (c, r) => {
        if (exited) return;
        try {
          proc.resize(Math.max(1, c), Math.max(1, r));
        } catch {
          /* a resize race after exit is harmless */
        }
      },
      onData: (cb) => proc.onData(cb),
      onExit: (cb) =>
        proc.onExit(({ exitCode }) => {
          exited = true;
          cb(exitCode);
        }),
      kill: () => {
        if (exited) return;
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      },
    };
  }

  // Fallback: a piped interactive shell. No TTY (no line editing, limited echo), but
  // usable for navigating and inspecting the project.
  const child: ChildProcess = spawnProcess(shell.file, shell.args, {
    cwd,
    env: shellEnv,
    windowsHide: true,
  });
  const dataHandlers: Array<(data: string) => void> = [];
  const emit = (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of dataHandlers) handler(text);
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);

  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });
  // Writing to a piped stdin whose shell already died emits EPIPE. Without this
  // 'error' listener that is an unhandled stream error and takes the whole API
  // process down - the exact path used when node-pty is absent on the box (H10).
  child.stdin?.on('error', () => {
    /* shell gone; further keystrokes are dropped */
  });

  return {
    pty: false,
    write: (data) => {
      if (childExited) return;
      if (child.stdin?.writable) child.stdin.write(data);
    },
    resize: () => {
      /* no TTY to resize */
    },
    onData: (cb) => {
      dataHandlers.push(cb);
    },
    onExit: (cb) => {
      child.once('exit', (code) => cb(code));
      child.once('error', () => cb(null));
    },
    kill: () => {
      child.kill();
    },
  };
}
