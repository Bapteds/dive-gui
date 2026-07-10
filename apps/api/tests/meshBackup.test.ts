// Unit tests for the single-slot mesh backup (M4): the slot must never LIE about
// its own existence, and a restore must never destroy the live case from a
// missing/partial slot. Exercises meshBackupStorage against the real ./test-storage
// root (STORAGE_DIR in vitest.config.ts).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupExists,
  restoreBackup,
  writeBackup,
} from '../src/lib/meshBackupStorage';
import { caseDirAbsolute, writeCaseFile, readCaseFile } from '../src/lib/caseStorage';

const created: string[] = [];

function projectRoot(id: string): string {
  return path.resolve(process.cwd(), 'test-storage', 'projects', id);
}

function backupCaseDir(id: string): string {
  return path.join(projectRoot(id), 'backups', 'case');
}

async function makeCaseProject(id: string): Promise<void> {
  created.push(id);
  await writeCaseFile(id, 'constant/polyMesh/boundary', '// original boundary\n');
  await writeCaseFile(id, '0/U', '// original U\n');
}

afterEach(async () => {
  while (created.length) {
    const id = created.pop()!;
    await fs.rm(projectRoot(id), { recursive: true, force: true });
  }
});

describe('mesh backup slot integrity (M4)', () => {
  it('backupExists is false when the case copy is gone but the meta lingers', async () => {
    const id = 'm4-honest-exists';
    await makeCaseProject(id);

    await writeBackup(id, 'original');
    expect(await backupExists(id)).toBe(true);

    // Simulate a write interrupted after the meta but before/around the copy:
    // wipe only the case copy, leaving the meta on disk.
    await fs.rm(backupCaseDir(id), { recursive: true, force: true });

    // The old code checked only the meta and returned true (a lie); a later
    // restore would then wipe the live case and copy nothing back.
    expect(await backupExists(id)).toBe(false);
  });

  it('restoreBackup refuses a missing slot and leaves the live case intact', async () => {
    const id = 'm4-safe-restore';
    await makeCaseProject(id);

    await writeBackup(id, 'original');
    // Corrupt the slot: remove the case copy so it is missing/partial.
    await fs.rm(backupCaseDir(id), { recursive: true, force: true });

    // Mutate the live case so we can prove it survives a failed restore.
    await writeCaseFile(id, '0/U', '// EDITED U\n');

    await expect(restoreBackup(id)).rejects.toThrow();

    // The live case must be untouched — never cleared before a good copy is staged.
    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))?.toString('utf8');
    const u = (await readCaseFile(id, '0/U'))?.toString('utf8');
    expect(boundary).toContain('original boundary');
    expect(u).toContain('EDITED U');
  });

  it('round-trips a real slot: writeBackup then restoreBackup brings the case back', async () => {
    const id = 'm4-roundtrip';
    await makeCaseProject(id);

    await writeBackup(id, 'original');
    expect(await backupExists(id)).toBe(true);

    // Edit the live case, then restore.
    await writeCaseFile(id, '0/U', '// EDITED U\n');
    await restoreBackup(id);

    const u = (await readCaseFile(id, '0/U'))?.toString('utf8');
    expect(u).toContain('original U');
    expect(u).not.toContain('EDITED U');
  });
});
