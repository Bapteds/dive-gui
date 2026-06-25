// Single-slot mesh backup for a project's OpenFOAM case.
//
// The Visualize tab lets a user edit boundary patches (names/types) and run
// autoPatch, all of which rewrite constant/polyMesh and the 0/ fields. To make
// those edits reversible, we keep ONE backup slot per project: a full copy of
// the case tree taken automatically before the first modification (the
// "original"), plus a button to overwrite that slot with the current state and
// a button to restore from it.
//
// Layout (sibling of case/, NOT inside it, so it never shows in the file tree
// and is removed with the project by removeProjectStorage):
//   <STORAGE_DIR>/projects/<id>/backups/case/            full copy of case/
//   <STORAGE_DIR>/projects/<id>/backups/mesh-backup.json  metadata
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MeshBackupInfo } from '@dive/shared';
import { assertSafeId, removeTreeAt, storageRoot } from './fileTreeStorage';
import { caseDirAbsolute, clearCase } from './caseStorage';

/** Absolute path to a project's backups directory (created on first write). */
function backupsRoot(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'backups');
}

/** The slot's copy of the case tree. */
function backupCaseDir(projectId: string): string {
  return path.join(backupsRoot(projectId), 'case');
}

/** The slot's metadata file. */
function metaPath(projectId: string): string {
  return path.join(backupsRoot(projectId), 'mesh-backup.json');
}

/** Read the slot metadata, or null when there is no backup (or it is unreadable). */
export async function readBackupMeta(projectId: string): Promise<MeshBackupInfo | null> {
  try {
    const raw = await fs.readFile(metaPath(projectId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MeshBackupInfo>;
    if (!parsed.createdAt || !parsed.updatedAt || !parsed.kind) return null;
    return { createdAt: parsed.createdAt, updatedAt: parsed.updatedAt, kind: parsed.kind };
  } catch {
    return null;
  }
}

/** Does a backup exist for this project? */
export async function backupExists(projectId: string): Promise<boolean> {
  return (await readBackupMeta(projectId)) !== null;
}

/**
 * Take (or overwrite) the backup: replace the slot's case copy with the project's
 * current case tree and stamp the metadata. `kind` records why it was written —
 * 'original' for the automatic pre-edit snapshot, 'manual' for an explicit
 * overwrite. `createdAt` is preserved across overwrites (first-captured time);
 * `updatedAt` is the time of this write.
 */
export async function writeBackup(
  projectId: string,
  kind: MeshBackupInfo['kind'],
): Promise<MeshBackupInfo> {
  const previous = await readBackupMeta(projectId);
  const now = new Date().toISOString();

  // Replace the slot atomically-enough: drop the old copy, then mirror case/.
  const dest = backupCaseDir(projectId);
  await removeTreeAt(dest);
  await fs.mkdir(backupsRoot(projectId), { recursive: true });
  await fs.cp(caseDirAbsolute(projectId), dest, { recursive: true });

  const info: MeshBackupInfo = {
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    kind,
  };
  await fs.writeFile(metaPath(projectId), JSON.stringify(info), 'utf8');
  return info;
}

/**
 * Capture the original automatically the first time the mesh is modified: write
 * the backup with kind 'original' only when no backup exists yet. A no-op once a
 * backup is present, so the single slot always holds either the pristine
 * original or whatever the user last overwrote it with.
 */
export async function ensureOriginalBackup(projectId: string): Promise<void> {
  if (!(await backupExists(projectId))) {
    await writeBackup(projectId, 'original');
  }
}

/**
 * Restore the case from the backup: wipe the current case tree and copy the
 * slot's case copy back over it. The caller is responsible for checking the
 * backup exists and for rebuilding the render afterwards.
 */
export async function restoreBackup(projectId: string): Promise<void> {
  await clearCase(projectId);
  await fs.cp(backupCaseDir(projectId), caseDirAbsolute(projectId), { recursive: true });
}
