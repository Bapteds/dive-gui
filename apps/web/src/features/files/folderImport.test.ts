import { describe, expect, it } from 'vitest';
import { groupPickedFolder, uploadPath } from './folderImport';

/** Build a File whose `webkitRelativePath` mimics a folder pick. */
function pickedFile(relativePath: string, bytes = 4): File {
  const name = relativePath.split('/').pop() ?? relativePath;
  const file = new File(['x'.repeat(bytes)], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

describe('groupPickedFolder', () => {
  it('returns null for an empty pick', () => {
    expect(groupPickedFolder([])).toBeNull();
  });

  it('groups files by their immediate child under the root', () => {
    const result = groupPickedFolder([
      pickedFile('caseX/0/U'),
      pickedFile('caseX/0/p'),
      pickedFile('caseX/constant/transportProperties'),
      pickedFile('caseX/Allrun'),
    ]);

    expect(result?.root).toBe('caseX');
    expect(result?.children.map((c) => c.name)).toEqual(['0', 'constant', 'Allrun']);

    const zero = result?.children.find((c) => c.name === '0');
    expect(zero?.isDir).toBe(true);
    expect(zero?.files).toHaveLength(2);

    const allrun = result?.children.find((c) => c.name === 'Allrun');
    expect(allrun?.isDir).toBe(false);
    expect(allrun?.files).toHaveLength(1);
  });

  it('orders directories before loose files, each alphabetically', () => {
    const result = groupPickedFolder([
      pickedFile('root/zeta'),
      pickedFile('root/beta/x'),
      pickedFile('root/alpha/y'),
      pickedFile('root/apple'),
    ]);

    expect(result?.children.map((c) => c.name)).toEqual(['alpha', 'beta', 'apple', 'zeta']);
  });

  it('falls back to the file name when no directory prefix is present', () => {
    const file = new File(['x'], 'loose.txt');
    const result = groupPickedFolder([file]);
    expect(result?.children).toHaveLength(1);
    expect(result?.children[0]).toMatchObject({ name: 'loose.txt', isDir: false });
  });
});

describe('uploadPath', () => {
  it('strips the picked root folder by default', () => {
    expect(uploadPath(pickedFile('OFSolverExample/0/U'), false)).toBe('0/U');
    expect(uploadPath(pickedFile('OFSolverExample/Allrun'), false)).toBe('Allrun');
  });

  it('keeps the picked root folder when asked', () => {
    expect(uploadPath(pickedFile('OFSolverExample/0/U'), true)).toBe('OFSolverExample/0/U');
  });

  it('keeps a bare file name unchanged either way', () => {
    const file = new File(['x'], 'loose.txt');
    expect(uploadPath(file, false)).toBe('loose.txt');
    expect(uploadPath(file, true)).toBe('loose.txt');
  });
});
