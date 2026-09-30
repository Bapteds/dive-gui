// Filesystem storage of the optimisation studies (WS-H spec §6 "done" stage).
//
// Layout:  <STORAGE_DIR>/studies/<studyId>/
//            suggest-request.json                  (last optimiseSuggest.py request)
//            evaluations/<index>/metrics.json      (StudyEvaluationMetrics, atomic)
//            evaluations/<index>/postProcessing/   (the WS-G monitor folders of the solve)
// The rows (Study, Evaluation) are the source of truth; this is the archive the
// evaluation detail reads once the project case holds another design. Removed by
// DELETE …/studies/:id, a project / user deletion (best-effort).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StudyEvaluationMetrics } from '@dive/shared';
import { assertSafeId, removeTreeAt, storageRoot } from './fileTreeStorage';

/** Absolute path of a study's directory (id validated). */
export function studyDirAbsolute(studyId: string): string {
  assertSafeId(studyId);
  return path.join(storageRoot(), 'studies', studyId);
}

/** Absolute path of one evaluation's archive directory. */
export function evaluationDirAbsolute(studyId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid evaluation index ${index}`);
  return path.join(studyDirAbsolute(studyId), 'evaluations', String(index));
}

/** Rename errors Windows raises while another handle (a poll's read) has the target open. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Write JSON atomically: a uniquely named tmp file, then a rename retried on a
 * transient Windows sharing error (the UI may be reading the file).
 */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_CODES.has(code) || attempt >= 20) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10));
    }
  }
}

/** Read JSON, retrying a read that races a rename on Windows; null when absent / invalid. */
async function readJson<T>(file: string): Promise<T | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_CODES.has(code) || attempt >= 20) return null;
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 10));
    }
  }
}

/** Persist an evaluation's archived series. */
export async function writeEvaluationMetrics(
  studyId: string,
  index: number,
  metrics: StudyEvaluationMetrics,
): Promise<void> {
  await writeJsonAtomic(path.join(evaluationDirAbsolute(studyId, index), 'metrics.json'), metrics);
}

/** An evaluation's archived series, or null when never archived. */
export async function readEvaluationMetrics(
  studyId: string,
  index: number,
): Promise<StudyEvaluationMetrics | null> {
  return readJson<StudyEvaluationMetrics>(
    path.join(evaluationDirAbsolute(studyId, index), 'metrics.json'),
  );
}

/** postProcessing folders of the WS-G monitors and function objects worth keeping. */
const ARCHIVED_POST_DIRS = /^(dive|SimplePDrop|convergenceControl)|_flux$/;

/**
 * Copy the WS-G monitor folders of the case's postProcessing/ into the
 * evaluation archive (the next evaluation clears the case). Best-effort.
 */
export async function archivePostProcessing(
  studyId: string,
  index: number,
  caseDir: string,
): Promise<void> {
  const source = path.join(caseDir, 'postProcessing');
  let names: string[];
  try {
    names = await fs.readdir(source);
  } catch {
    return;
  }
  const target = path.join(evaluationDirAbsolute(studyId, index), 'postProcessing');
  for (const name of names) {
    if (!ARCHIVED_POST_DIRS.test(name)) continue;
    await fs
      .cp(path.join(source, name), path.join(target, name), { recursive: true })
      .catch(() => undefined);
  }
}

/** Write the suggestion request for optimiseSuggest.py; returns its absolute path. */
export async function writeSuggestRequest(studyId: string, request: unknown): Promise<string> {
  const file = path.join(studyDirAbsolute(studyId), 'suggest-request.json');
  await writeJsonAtomic(file, request);
  return file;
}

/** Remove a study's whole archive. Never throws. */
export async function removeStudyStorage(studyId: string): Promise<void> {
  await removeTreeAt(studyDirAbsolute(studyId)).catch(() => undefined);
}
