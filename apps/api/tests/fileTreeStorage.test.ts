// Unit tests for the case-tree path ordering. The flat, depth-indented file tree
// the UI renders relies on listTree returning entries in proper hierarchical
// order: a directory's own entry must be immediately followed by its children,
// and a sibling whose name is a prefix of another (the classic OpenFOAM "0" vs
// "0.orig") must not interleave. A raw string sort breaks this because '/' sorts
// after '.', so this guards comparePaths against that regression.
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { comparePaths, extractArchiveAt } from '../src/lib/fileTreeStorage';

describe('comparePaths', () => {
  it('orders a directory and its children before a prefix-sibling (0 vs 0.orig)', () => {
    // Within a level, the existing locale ordering is preserved (so "p" < "U");
    // the fix is purely that all of "0/"'s children precede "0.orig".
    const paths = ['0.orig/U', '0/p', '0.orig', '0', '0/U', 'system/controlDict', 'system'];
    expect([...paths].sort(comparePaths)).toEqual([
      '0',
      '0/p',
      '0/U',
      '0.orig',
      '0.orig/U',
      'system',
      'system/controlDict',
    ]);
  });

  it('places a parent before its children and all of "0/..." before "0.orig"', () => {
    expect(comparePaths('0', '0/U')).toBeLessThan(0);
    expect(comparePaths('0/U', '0.orig')).toBeLessThan(0);
    expect(comparePaths('0.orig', '0/U')).toBeGreaterThan(0);
  });
});

describe('extractArchiveAt decompression cap (H9)', () => {
  it('rejects a zip that decompresses past the cap, before writing anything', async () => {
    const zip = new AdmZip();
    zip.addFile('big.bin', Buffer.alloc(1000)); // 1000 uncompressed bytes
    const archive = zip.toBuffer();
    const identity = (paths: string[]) => paths;

    // The check runs before any write, so the (nonexistent) root is never touched.
    await expect(
      extractArchiveAt('/nonexistent-root-should-not-be-written', archive, identity, 100),
    ).rejects.toMatchObject({ status: 413, code: 'ARCHIVE_TOO_LARGE' });
  });

  it('extracts normally when under the cap', async () => {
    const zip = new AdmZip();
    zip.addFile('constant/small', Buffer.from('hello'));
    const written = await extractArchiveAt(
      './test-storage/h9-ok',
      zip.toBuffer(),
      (paths) => paths,
      1024 * 1024,
    );
    expect(written).toContain('constant/small');
  });
});
