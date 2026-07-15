// Unit tests for the checkMesh verdict parser (lib/checkMeshGate). The invocation is
// OpenFOAM-only; the parsing (which decides whether a morphed diameter is skipped) is
// pure and tested here.
import { describe, expect, it } from 'vitest';
import { parseCheckMesh } from '../src/lib/checkMeshGate';

describe('parseCheckMesh', () => {
  it('passes a clean mesh', () => {
    const v = parseCheckMesh('Checking geometry...\n    ...\nMesh OK.\n');
    expect(v.ok).toBe(true);
    expect(v.negativeVolumeCells).toBe(0);
    expect(v.note).toBe('Mesh OK');
  });

  it('fails a mesh with negative-volume (inverted) cells', () => {
    const out = ' ***Number of negative volume cells: 12 ...\nFailed 1 mesh checks.\n';
    const v = parseCheckMesh(out);
    expect(v.ok).toBe(false);
    expect(v.negativeVolumeCells).toBe(12);
    expect(v.note).toMatch(/12 negative-volume/);
  });

  it('passes despite non-fatal quality warnings (skewness / non-orthogonality)', () => {
    const out =
      ' ***High aspect ratio cells found ...\n' +
      ' ***Number of severely non-orthogonal ... faces: 3.\n' +
      'Failed 2 mesh checks.\n';
    const v = parseCheckMesh(out);
    expect(v.ok).toBe(true); // no negative-volume cells -> still solvable
    expect(v.negativeVolumeCells).toBe(0);
    expect(v.note).toMatch(/2 non-fatal/);
  });
});
