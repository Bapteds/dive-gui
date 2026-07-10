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

/**
 * Absolute path to the slot's copy of the case tree. Exported so the merge can
 * stage a re-merge's base from the pristine backup (non-destructive re-merge)
 * instead of reverting the live case first.
 */
export function backupCaseDir(projectId: string): string {
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

/** Does the slot's case copy exist on disk with at least one entry? */
async function backupCaseCopyPresent(projectId: string): Promise<boolean> {
  try {
    return (await fs.readdir(backupCaseDir(projectId))).length > 0;
  } catch {
    return false;
  }
}

/**
 * Does a COMPLETE backup exist for this project? Both the metadata AND a non-empty
 * case copy must be present — a slot with a stale meta but a missing/half-written
 * case copy (e.g. a `writeBackup` interrupted mid-copy) must report `false`, or a
 * later restore would wipe the live case and copy nothing back.
 */
export async function backupExists(projectId: string): Promise<boolean> {
  return (await readBackupMeta(projectId)) !== null && (await backupCaseCopyPresent(projectId));
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

  const dest = backupCaseDir(projectId);
  const staging = `${dest}.staging`;
  await removeTreeAt(staging); // clear any leftover from a previously interrupted write
  await fs.mkdir(backupsRoot(projectId), { recursive: true });

  // Copy the live case into a STAGING dir first. A failure here (disk full, EIO,
  // permissions) throws BEFORE the existing slot is touched, so a good backup is
  // never destroyed by a failed overwrite — the old copy + meta stay intact.
  await fs.cp(caseDirAbsolute(projectId), staging, { recursive: true });

  // Commit. Drop the meta FIRST so that if anything below is interrupted the slot
  // reads as "no backup" (honest) instead of pointing at a half-written copy;
  // materialize the new slot from the (complete, local) staging copy — using cp,
  // not rename, because a directory rename intermittently EPERMs on Windows; write
  // the meta LAST so it exists only alongside a COMPLETE copy. `backupExists` also
  // re-checks the case copy, closing the commit-window gap.
  await fs.rm(metaPath(projectId), { force: true });
  await removeTreeAt(dest);
  await fs.cp(staging, dest, { recursive: true });
  await removeTreeAt(staging);

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
 * Restore the case from the backup slot. Crash-safe: the slot is copied into a
 * STAGING dir beside the live case first, so a missing/unreadable/partial slot
 * throws BEFORE the live case is cleared (the old code wiped the case, then copied
 * from a possibly-empty slot — destroying the case). The live case is only cleared
 * once a complete staged copy is in hand. The caller checks `backupExists` and
 * rebuilds the render afterwards.
 */
export async function restoreBackup(projectId: string): Promise<void> {
  const slot = backupCaseDir(projectId);
  const live = caseDirAbsolute(projectId);
  const staging = `${live}.restoring`;
  await removeTreeAt(staging);

  // Copy the slot into staging FIRST. If the slot is missing or unreadable this
  // throws and the live case is left completely intact.
  await fs.cp(slot, staging, { recursive: true });

  // Guard against a slot that copied to nothing (should not happen once
  // `backupExists` gates this, but never wipe the case for an empty restore).
  if ((await fs.readdir(staging)).length === 0) {
    await removeTreeAt(staging);
    throw new Error('The mesh backup slot is empty; refusing to restore.');
  }

  await clearCase(projectId); // removes the case root; staging holds a full copy
  await fs.cp(staging, live, { recursive: true }); // cp, not rename (Windows EPERM)
  await removeTreeAt(staging);
}
