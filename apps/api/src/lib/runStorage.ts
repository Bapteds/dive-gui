// Filesystem storage for per-project solver runs.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/runs/<runId>/solver.log
//
// Run logs are *outputs*, kept apart from the OpenFOAM case tree (caseStorage)
// so resetting a case never wipes the run history/logs (mirrors the cgns/viz
// decision). This is a thin façade over the path-traversal-safe core in
// fileTreeStorage, pinned to the project's runs root; the whole subtree is
// removed with the project (removeProjectStorage).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RUN_DIRNAME } from '@dive/shared';
import { assertSafeId, confineJoin, storageRoot } from './fileTreeStorage';

/** Absolute path to a project's runs root. */
function runsRootFor(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, RUN_DIRNAME);
}

/** Absolute path to a single run's directory (confined, id-validated). */
export function runDirAbsolute(projectId: string, runId: string): string {
  assertSafeId(runId);
  return confineJoin(runsRootFor(projectId), runId);
}

/** Absolute path to a run's solver.log (the file the runner appends to). */
export function runLogAbsolute(projectId: string, runId: string): string {
  return confineJoin(runDirAbsolute(projectId, runId), 'solver.log');
}

/** Ensure a run's directory exists (the runner also does this, defensively). */
export async function ensureRunDir(projectId: string, runId: string): Promise<string> {
  const dir = runDirAbsolute(projectId, runId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Append text to a run's solver.log (best-effort; creates the run dir if needed).
 * Used to surface pre-solver progress (mesh decomposition) and tool output in the
 * run log so a parallel run does not look like "queued, nothing happening".
 */
export async function appendRunLog(projectId: string, runId: string, text: string): Promise<void> {
  try {
    const abs = runLogAbsolute(projectId, runId);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, text);
  } catch {
    /* best-effort: the log is a convenience, never the source of truth */
  }
}

/** Current size of a run's log in bytes (0 when absent). */
export async function runLogSize(projectId: string, runId: string): Promise<number> {
  try {
    return (await fs.stat(runLogAbsolute(projectId, runId))).size;
  } catch {
    return 0;
  }
}

/**
 * Read a run's log from `fromByte` to the end. Returns the slice plus the total
 * size, so a streaming client can advance its byte offset. Missing log => empty.
 * Byte-offset reads can split a multi-byte UTF-8 char; solver logs are ASCII so
 * this is a non-issue in practice.
 */
export async function readRunLog(
  projectId: string,
  runId: string,
  fromByte = 0,
): Promise<{ content: string; size: number }> {
  const abs = runLogAbsolute(projectId, runId);
  let size = 0;
  try {
    size = (await fs.stat(abs)).size;
  } catch {
    return { content: '', size: 0 };
  }
  const start = Math.max(0, Math.min(fromByte, size));
  if (start >= size) return { content: '', size };

  const handle = await fs.open(abs, 'r');
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { content: buffer.toString('utf8'), size };
  } finally {
    await handle.close();
  }
}
