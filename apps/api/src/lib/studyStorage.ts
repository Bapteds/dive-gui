// Filesystem storage for a project's diameter-optimization studies.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/studies/<studyId>/
//            study.json   (the StudyDoc: morph + sweep + objective + samples)
//            points.orig  (the pristine constant/polyMesh/points snapshotted before
//                          the first morph, so each swept value morphs from the
//                          original mesh — filled in by the Phase 4 orchestrator)
//
// <studyId> is the Study row's cuid (the DB is the source of truth for a study's
// identity + status), mirroring runStorage keying by runId. A study's config +
// per-value results are kept apart from the OpenFOAM case tree so a case reset never
// wipes study history; the whole subtree is removed with the project
// (removeProjectStorage) or the study (deleteStudyDir). Thin façade over the
// path-traversal-safe core in fileTreeStorage, pinned to the project's studies root.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  STUDIES_DIRNAME,
  type MorphDefinition,
  type ObjectiveConfig,
  type StudySample,
  type SweepConfig,
} from '@dive/shared';
import { assertSafeId, confineJoin, removeTreeAt, storageRoot } from './fileTreeStorage';

/**
 * The on-disk half of a Study: the bulky morph/sweep/objective config plus the
 * per-value samples. The Prisma Study row carries identity, status, and denormalized
 * progress; the service stitches the two into the wire `Study`.
 */
export interface StudyDoc {
  morph: MorphDefinition;
  sweep: SweepConfig;
  objective: ObjectiveConfig;
  samples: StudySample[];
}

const STUDY_DOC_FILE = 'study.json';

/** Absolute path to a project's studies root. */
function studiesRootFor(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, STUDIES_DIRNAME);
}

/** Absolute path to one study's directory (confined, id-validated). */
export function studyDirAbsolute(projectId: string, studyId: string): string {
  assertSafeId(studyId);
  return confineJoin(studiesRootFor(projectId), studyId);
}

/** Absolute path to a study's pristine points snapshot (taken before the first morph). */
export function studyOrigPointsAbsolute(projectId: string, studyId: string): string {
  return confineJoin(studyDirAbsolute(projectId, studyId), 'points.orig');
}

/** Read a study's on-disk doc (config + samples), or null when absent/unreadable. */
export async function readStudyDoc(projectId: string, studyId: string): Promise<StudyDoc | null> {
  try {
    const file = path.join(studyDirAbsolute(projectId, studyId), STUDY_DOC_FILE);
    return JSON.parse(await fs.readFile(file, 'utf8')) as StudyDoc;
  } catch {
    return null;
  }
}

/** Persist a study's on-disk doc (creates the study dir if needed). */
export async function writeStudyDoc(
  projectId: string,
  studyId: string,
  doc: StudyDoc,
): Promise<void> {
  const file = path.join(studyDirAbsolute(projectId, studyId), STUDY_DOC_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(doc), 'utf8');
}

/** Delete a study's directory entirely (config, snapshots, results). */
export async function deleteStudyDir(projectId: string, studyId: string): Promise<void> {
  await removeTreeAt(studyDirAbsolute(projectId, studyId));
}
