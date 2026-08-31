// Injectable, never-throwing runner for a LONG-LIVED external process (the
// OpenFOAM solver). Unlike commandRunner (execFile, buffers all output, resolves
// only at exit — fine for one-shot tools), a solver run can emit hundreds of MB
// of residual output over hours, so this:
//   - spawns the process and pipes stdout+stderr to a LOG FILE on disk (so the
//     output is bounded by the disk, observable live by tailing the file, and
//     preserved with no client attached);
//   - returns a handle immediately (pid + an onExit promise + a stop()), instead
//     of blocking until the process ends;
//   - never throws for a process outcome: a spawn error (ENOENT, missing solver
//     binary), a timeout kill, or a non-zero exit all resolve onExit with a
//     structured result, so the caller drives the Run row to a terminal state.
//
// It is injectable (setStreamRunner) exactly like setCommandRunner, so the run
// lifecycle is fully testable without OpenFOAM installed (the fake writes
// scripted residual lines to the log and resolves onExit with a chosen code).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

/** A long-lived command to run, with its output appended to `logFile`. */
export interface StreamSpec {
  /** Executable name (resolved on PATH) or absolute path. */
  command: string;
  /** Arguments, passed as argv — never concatenated into a shell string. */
  args: string[];
  /** Working directory for the child (the case directory). */
  cwd: string;
  /** Environment for the child. */
  env: NodeJS.ProcessEnv;
  /** Absolute path of the log file stdout+stderr are appended to. */
  logFile: string;
  /** Optional wall-clock cap (ms); the child is SIGKILLed when exceeded. */
  timeoutMs?: number;
}

/** Structured outcome of a finished run. */
export interface StreamExit {
  /** Process exit code, or null when killed (signal/timeout) or never spawned. */
  exitCode: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: string;
  /** True when the child was killed for exceeding its timeout. */
  timedOut?: boolean;
}

/** Live handle on a running process. */
export interface StreamHandle {
  /** OS process id while running, or null if it never spawned. */
  pid: number | null;
  /** Resolves (never rejects) when the process ends or fails to start. */
  onExit: Promise<StreamExit>;
  /** Request termination (SIGTERM by default); a no-op once the process is gone. */
  stop(signal?: NodeJS.Signals): void;
}

/** A function that starts a streaming process and returns its live handle. */
export type StreamRunner = (spec: StreamSpec) => StreamHandle;

/** The real runner: spawns the process, pipes its output to the log file. */
export const realStreamRunner: StreamRunner = (spec) => {
  // Ensure the run directory exists before opening the log (sync so the handle
  // can be returned immediately).
  mkdirSync(path.dirname(spec.logFile), { recursive: true });
  const out = createWriteStream(spec.logFile, { flags: 'a' });

  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let settled = false;
  let logStreamFailed = false;

  // A failure WRITING the log (disk full, EIO, permissions) must never crash the
  // API. Without this listener the stream's 'error' is unhandled and takes the
  // whole Node process down mid-run, disconnecting every user and leaving the run
  // stuck 'running' (C3). On error: stop feeding the dead stream but let the
  // child run to its natural exit (its 'close' still finishes the run); draining
  // the pipes keeps the solver from blocking on a full stdout buffer.
  out.on('error', (err: NodeJS.ErrnoException) => {
    logStreamFailed = true;
    console.error(`[streamRunner] log write failed for ${spec.logFile}: ${err.message}`);
    child?.stdout.unpipe(out);
    child?.stderr.unpipe(out);
    child?.stdout.resume();
    child?.stderr.resume();
  });

  const onExit = new Promise<StreamExit>((resolve) => {
    const finish = (result: StreamExit): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Don't end() a stream that already errored (it may be destroyed).
      if (!logStreamFailed) out.end();
      resolve(result);
    };

    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
      });
    } catch (err) {
      finish({ exitCode: null, signal: null, spawnError: String(err) });
      return;
    }

    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, spawnError: `${err.code ?? 'ERR'}: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, timedOut });
    });

    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child?.kill('SIGKILL');
      }, spec.timeoutMs);
    }
  });

  return {
    pid: child?.pid ?? null,
    onExit,
    stop: (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        child?.kill(signal);
      } catch {
        /* already exited */
      }
    },
  };
};

/** The runner currently in effect (swappable for tests). */
let activeRunner: StreamRunner = realStreamRunner;

/** Replace the active stream runner (tests pass a fake; `null` restores the real one). */
export function setStreamRunner(runner: StreamRunner | null): void {
  activeRunner = runner ?? realStreamRunner;
}

/** Start a streaming process through the active runner. */
export function runStream(spec: StreamSpec): StreamHandle {
  return activeRunner(spec);
}
