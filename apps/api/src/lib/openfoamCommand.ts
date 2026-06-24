// Shared helper for invoking an OpenFOAM command-line utility.
//
// OpenFOAM tools (vtkUnstructuredToFoam, checkMesh, autoPatch, …) live on the
// Debian deploy target and need the OpenFOAM environment sourced. When
// OPENFOAM_BASHRC is set, the tool runs inside `bash -c 'source <bashrc> && exec
// "$@"'` so its environment is present; arguments are passed as real argv (never
// interpolated into the script), keeping it injection-safe. Otherwise the tool
// is run directly, assuming it is already on PATH.
//
// Extracted from conversion.service so every OpenFOAM utility (the conversion
// pipeline AND the mesh actions such as autoPatch) shares one invocation and one
// failure rule.
import { env } from '../config/env';
import type { CommandResult } from './commandRunner';

/** A command to run plus the logical line shown to the user. */
export interface PlannedCommand {
  /** The logical command line, surfaced in the UI for transparency. */
  display: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the invocation for an OpenFOAM utility. When OPENFOAM_BASHRC is set, the
 * tool runs inside `bash -c 'source <bashrc> && exec "$@"'` so the OpenFOAM
 * environment is present; arguments are passed as real argv (never interpolated
 * into the script), keeping it injection-safe. Otherwise the tool is run
 * directly, assuming it is already on PATH.
 */
export function planOpenfoamCommand(bin: string, args: string[], cwd: string): PlannedCommand {
  const display = [bin, ...args].join(' ');
  const bashrc = env.OPENFOAM_BASHRC.trim();
  if (bashrc) {
    return {
      display,
      command: 'bash',
      args: ['-c', 'source "$OPENFOAM_BASHRC" && exec "$@"', 'bash', bin, ...args],
      cwd,
      env: { ...process.env, OPENFOAM_BASHRC: bashrc },
    };
  }
  return { display, command: bin, args, cwd, env: process.env };
}

/** Did the command fail (never spawned, timed out, or non-zero exit)? */
export function commandFailed(result: CommandResult): boolean {
  return !!result.spawnError || result.timedOut || result.exitCode !== 0;
}
