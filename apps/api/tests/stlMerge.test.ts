// Unit tests for the in-process STL merge (ASCII + binary -> one multi-solid STL).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeStlFilesToAscii } from '../src/lib/stlMerge';

const ASCII_TRI = `solid whatever
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid whatever
`;

/** A 1-triangle binary STL: 80-byte header + uint32 count + one 50-byte record. */
function binaryTriangle(): Buffer {
  const buf = Buffer.alloc(84 + 50);
  buf.writeUInt32LE(1, 80);
  const rec = 84;
  // normal (0 0 1)
  buf.writeFloatLE(0, rec);
  buf.writeFloatLE(0, rec + 4);
  buf.writeFloatLE(1, rec + 8);
  // three vertices
  const verts = [0, 0, 0, 2, 0, 0, 0, 2, 0];
  for (let i = 0; i < 9; i += 1) buf.writeFloatLE(verts[i], rec + 12 + i * 4);
  return buf;
}

let tmp: string;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('mergeStlFilesToAscii', () => {
  it('merges several STLs into one multi-solid ASCII surface (one solid/patch each)', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stlmerge-'));
    await fs.writeFile(path.join(tmp, 'rotor.stl'), ASCII_TRI, 'utf8');
    await fs.writeFile(path.join(tmp, 'stator.stl'), ASCII_TRI, 'utf8');
    const out = path.join(tmp, 'combined.stl');

    const { triangles } = await mergeStlFilesToAscii(tmp, ['rotor.stl', 'stator.stl'], out);

    expect(triangles).toBe(2);
    const text = await fs.readFile(out, 'utf8');
    // One named solid per input file, derived from its stem.
    expect(text).toContain('solid rotor');
    expect(text).toContain('endsolid rotor');
    expect(text).toContain('solid stator');
    expect(text).toContain('endsolid stator');
    expect((text.match(/facet normal/g) ?? []).length).toBe(2);
  });

  it('reads a binary STL and re-emits it as ASCII facets', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stlmerge-'));
    await fs.writeFile(path.join(tmp, 'ascii.stl'), ASCII_TRI, 'utf8');
    await fs.writeFile(path.join(tmp, 'bin.stl'), binaryTriangle());
    const out = path.join(tmp, 'combined.stl');

    const { triangles } = await mergeStlFilesToAscii(tmp, ['ascii.stl', 'bin.stl'], out);

    expect(triangles).toBe(2);
    const text = await fs.readFile(out, 'utf8');
    expect(text).toContain('solid bin');
    // The binary triangle's second vertex was (2 0 0).
    expect(text).toContain('vertex 2 0 0');
  });

  it('throws on an STL with no readable triangles', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stlmerge-'));
    await fs.writeFile(path.join(tmp, 'empty.stl'), 'solid empty\nendsolid empty\n', 'utf8');
    await expect(
      mergeStlFilesToAscii(tmp, ['empty.stl'], path.join(tmp, 'out.stl')),
    ).rejects.toThrow();
  });
});
