/**
 * folderImport - group a picked folder's flat file list for selective import.
 *
 * A folder pick (webkitdirectory) yields every nested file at once, each
 * carrying its `webkitRelativePath` (e.g. `caseX/0/U`). We group those files by
 * their immediate child under the picked root so the user can keep only the
 * parts they want; the relative paths are preserved exactly, so importing a
 * subset reproduces the on-disk tree minus what was left out.
 */

/** One immediate child of the picked folder: a subfolder or a loose file. */
export interface FolderChild {
  /** Name of the child directly under the picked root. */
  name: string;
  /** True for a subfolder, false for a file sitting directly in the root. */
  isDir: boolean;
  /** Every file that belongs to this child (the file itself when not a dir). */
  files: File[];
  /** Total size of this child's files, in bytes. */
  size: number;
}

/** The picked folder's name plus its grouped immediate children. */
export interface PickedFolder {
  root: string;
  children: FolderChild[];
}

/** A file paired with the relative path it should be stored under. */
export interface UploadFile {
  file: File;
  path: string;
}

/**
 * The path a picked file should be stored under. By default the picked root
 * folder is stripped (so picking `OFSolverExample/0/U` imports it as `0/U`);
 * `keepRoot` keeps the wrapper (`OFSolverExample/0/U`). Files with no directory
 * prefix keep their name unchanged.
 */
export function uploadPath(file: File, keepRoot: boolean): string {
  const relativePath = file.webkitRelativePath || file.name;
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length <= 1) return segments.join('/') || file.name;
  return (keepRoot ? segments : segments.slice(1)).join('/');
}

/**
 * Group a folder pick's flat file list by the immediate child under its root.
 * `webkitRelativePath` looks like `root/child/.../file` (subfolder) or
 * `root/file` (loose file); a child with no path prefix is treated as loose.
 * Returns null when there is nothing to import.
 */
export function groupPickedFolder(files: File[]): PickedFolder | null {
  if (files.length === 0) return null;

  const byChild = new Map<string, FolderChild>();
  let root = '';

  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    if (!root) root = segments[0];

    // segments: [root, child, ...] for a subfolder; [root, file] for a loose
    // file; [file] when the browser gave no directory prefix.
    const isDir = segments.length >= 3;
    const name = segments.length >= 2 ? segments[1] : segments[0];

    const existing = byChild.get(name);
    if (existing) {
      existing.files.push(file);
      existing.size += file.size;
    } else {
      byChild.set(name, { name, isDir, files: [file], size: file.size });
    }
  }

  const children = Array.from(byChild.values()).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (children.length === 0) return null;
  return { root, children };
}
