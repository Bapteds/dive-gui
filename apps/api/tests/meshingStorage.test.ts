// Unit tests for the meshing storage name helpers (pure — no filesystem) plus
// copySessionSetup (which does touch the test-storage root).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copySessionSetup,
  createSession,
  listStl,
  readConfig,
  sanitizeStlName,
  sessionDirAbsolute,
  slugifySessionName,
  writeConfig,
  writeStl,
} from '../src/lib/meshingStorage';

describe('slugifySessionName', () => {
  it('lowercases, strips accents, and collapses separators to dashes', () => {
    expect(slugifySessionName('Draft Tube — v2')).toBe('draft-tube-v2');
    expect(slugifySessionName('Étage Röterné')).toBe('etage-roterne');
  });

  it('falls back to "session" when nothing survives', () => {
    expect(slugifySessionName('***')).toBe('session');
  });
});

describe('sanitizeStlName', () => {
  it('keeps a safe basename and forces the .stl extension', () => {
    expect(sanitizeStlName('rotor.stl')).toBe('rotor.stl');
    expect(sanitizeStlName('C:/tmp/rotor.STL')).toBe('rotor.stl');
    expect(sanitizeStlName('draft tube.obj')).toBe('draft_tube.stl');
  });

  it('strips path traversal to a bare basename', () => {
    expect(sanitizeStlName('../../etc/passwd.stl')).toBe('passwd.stl');
  });

  it('falls back to "surface" when the stem is empty', () => {
    expect(sanitizeStlName('.stl')).toBe('surface.stl');
  });
});

describe('copySessionSetup', () => {
  it('duplicates engine + config + surfaces, not run output', async () => {
    // Arrange: a source session with a surface, a saved config, and fake run output.
    const src = await createSession('Copy setup source', 'cfmesh');
    await writeStl(src.id, 'inlet.stl', Buffer.from('solid inlet\nendsolid inlet'));
    await writeConfig(src.id, {
      engine: 'cfmesh',
      maxCellSize: 0.2,
      minCellSize: null,
      boundaryCellSize: null,
      extractFeatures: true,
      featureAngle: 45,
      addLayers: { enabled: false, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null },
      cores: 1,
    });
    // Fake run output that must NOT be copied.
    const polyMesh = path.join(sessionDirAbsolute(src.id), 'constant', 'polyMesh');
    await fs.mkdir(polyMesh, { recursive: true });
    await fs.writeFile(path.join(polyMesh, 'points'), 'x');

    // Act
    const copy = await copySessionSetup(src.id);

    // Assert: new id, same engine, name defaulted, surface + config copied, no polyMesh.
    expect(copy.id).not.toBe(src.id);
    expect(copy.engine).toBe('cfmesh');
    expect(copy.name).toBe('Copy setup source (copy)');
    const stls = await listStl(copy.id);
    expect(stls.map((s) => s.name)).toEqual(['inlet.stl']);
    expect(await readConfig(copy.id)).not.toBeNull();
    await expect(
      fs.stat(path.join(sessionDirAbsolute(copy.id), 'constant', 'polyMesh')),
    ).rejects.toThrow();
  });
});
