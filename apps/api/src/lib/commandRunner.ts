// Thin, test-swappable wrapper around child_process for running external CLI
// tools (the CGNS -> OpenFOAM conversion toolchain).
//
// Design goals:
//   - Never throw for an ordinary process outcome. A non-zero exit, a timeout,
//     or a missing binary all resolve to a structured CommandResult so the
//     caller can build a per-step report instead of unwinding the request.
//   - Be injectable. `setCommandRunner` lets tests substitute a fake (and the
//     conversion pipeline run without ParaView/OpenFOAM installed), restoring
//     the real runner afterwards.
//   - Stay safe: arguments are passed as real argv (execFile, not a shell), so
//     filenames derived from user uploads can never be interpreted as shell.
import { execFile, type ExecFileException } from 'node:child_process';

/** A single external command to run. */
export interface CommandSpec {
  /** Executable name (resolved on PATH) or absolute path. */
  command: string;
  /** Arguments, passed as argv — never concatenated into a shell string. */
  args: string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment for the child (defaults to the parent's). */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock timeout in ms; the child is killed (SIGTERM) when exceeded. */
  timeoutMs?: number;
}

/** Structured outcome of running a command — success or any kind of failure. */
export interface CommandResult {
  command: string;
  args: string[];
  /** Process exit code, or null when killed (timeout/signal) or never spawned. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the child was killed for exceeding its timeout. */
  timedOut: boolean;
  /**
   * Set when the process could not be started at all (e.g. `ENOENT` because the
   * binary is not installed / not on PATH). Distinct from a non-zero exit.
   */
  spawnError?: string;
}

/** A function that runs a command and resolves to its structured result. */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

/** Combined stdout+stderr buffer cap (large checkMesh reports are expected). */
const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB

/** The real runner: spawns the process via execFile and never rejects. */
export const realCommandRunner: CommandRunner = (spec) =>
  new Promise<CommandResult>((resolve) => {
    const start = Date.now();
    execFile(
      spec.command,
      spec.args,
      {
        cwd: spec.cwd,
        env: spec.env,
        timeout: spec.timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const base = {
          command: spec.command,
          args: spec.args,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs,
        };
        if (!error) {
          resolve({ ...base, exitCode: 0, timedOut: false });
          return;
        }
        // A numeric `code` is the process exit code; a string `code` (ENOENT,
        // EACCES, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, …) means it never ran (or
        // could not be read), which we surface as a spawn error. A null/undefined
        // code with `killed` means it was terminated (e.g. the timeout).
        const code = error.code;
        const exitCode = typeof code === 'number' ? code : null;
        const spawnError = typeof code === 'string' ? `${code}: ${error.message}` : undefined;
        resolve({
          ...base,
          exitCode,
          timedOut: error.killed === true,
          spawnError,
        });
      },
    );
  });

/** The runner currently in effect (swappable for tests). */
let activeRunner: CommandRunner = realCommandRunner;

/**
 * Replace the active command runner (tests pass a fake; `null` restores the
 * real one). Keeps the conversion pipeline runnable without the real toolchain.
 */
export function setCommandRunner(runner: CommandRunner | null): void {
  activeRunner = runner ?? realCommandRunner;
}

/** Run a command through the active runner. */
export function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return activeRunner(spec);
}
