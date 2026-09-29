// Contract parity: the chamber patch types the API forces when a meshing session
// is sent to a project (CHAMBER_PATCH_TYPES in @dive/shared) must mirror the
// PATCH_TYPES dict that buildChamber.py writes into the chamber exports. The
// Python constant is READ (regex on the dict literal), never executed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAMBER_PATCH_TYPES } from '@dive/shared';

/** Parse `PATCH_TYPES = { "name": "type", … }` from the builder source. */
async function readBuilderPatchTypes(): Promise<Record<string, string>> {
  const source = await fs.readFile(
    path.resolve(__dirname, '..', 'scripts', 'buildChamber.py'),
    'utf8',
  );
  const block = source.match(/^PATCH_TYPES\s*=\s*\{([\s\S]*?)\}/m);
  if (!block) throw new Error('PATCH_TYPES not found in buildChamber.py');
  const entries: Record<string, string> = {};
  for (const m of block[1].matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']\s*:\s*["']([A-Za-z]+)["']/g)) {
    entries[m[1]] = m[2];
  }
  return entries;
}

describe('CHAMBER_PATCH_TYPES', () => {
  it('equals PATCH_TYPES of buildChamber.py', async () => {
    const builder = await readBuilderPatchTypes();
    expect(Object.keys(builder).length).toBeGreaterThan(0);
    expect({ ...CHAMBER_PATCH_TYPES }).toEqual(builder);
  });
});
