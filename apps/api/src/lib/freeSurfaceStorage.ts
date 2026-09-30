// Filesystem storage of the free-surface (lid iteration) jobs, WS-I spec §5.
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/freesurface/<jobId>/
//            job.json                          (FreeSurfaceJob, written atomically)
//            base.stl                          (flat multi-solid STL of the source session)
//            export_iter<j>/{lid,inlet}.vtk    (lidSurfaces export of solution j)
//            zs_iter<j>.{npy,json}             (surface estimate j)
//            geometry/domain_lidIter<k>.{stl,json,png}   (fit of iteration k)
//            lid_iter<j>.png                   (post figure, optional)
//            logs/                             (kit step outputs)
// Removed with the project (removeProjectStorage) or by DELETE …/free-surface/:jobId.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isFreeSurfaceFileName, type FreeSurfaceJob } from '@dive/shared';
import { assertSafeId, removeTreeAt, storageRoot } from './fileTreeStorage';

/** Absolute path of a project's freesurface/ directory. */
function freeSurfaceRoot(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'freesurface');
}

/** Absolute path of one job's directory (ids validated). */
export function jobDirAbsolute(projectId: string, jobId: string): string {
  assertSafeId(jobId);
  return path.join(freeSurfaceRoot(projectId), jobId);
}

/** A new, sortable job id. */
export function newJobId(): string {
  return `fs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist a job (atomic: job.json.tmp then rename). */
export async function writeJob(projectId: string, job: FreeSurfaceJob): Promise<void> {
  const dir = jobDirAbsolute(projectId, job.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'job.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 1), 'utf8');
  await fs.rename(tmp, file);
}

/** Read a job, or null when absent / unreadable. */
export async function readJob(projectId: string, jobId: string): Promise<FreeSurfaceJob | null> {
  try {
    const raw = await fs.readFile(path.join(jobDirAbsolute(projectId, jobId), 'job.json'), 'utf8');
    const job = JSON.parse(raw) as FreeSurfaceJob;
    return job && job.id === jobId ? job : null;
  } catch {
    return null;
  }
}

/** Every job of a project, newest first. */
export async function listJobs(projectId: string): Promise<FreeSurfaceJob[]> {
  let names: string[];
  try {
    names = await fs.readdir(freeSurfaceRoot(projectId));
  } catch {
    return [];
  }
  const jobs: FreeSurfaceJob[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const job = await readJob(projectId, name);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete a job's directory. */
export async function deleteJobDir(projectId: string, jobId: string): Promise<void> {
  await removeTreeAt(jobDirAbsolute(projectId, jobId));
}

/** Ids of the projects that have a freesurface/ directory (boot reconciliation). */
export async function listProjectsWithJobs(): Promise<string[]> {
  const root = path.join(storageRoot(), 'projects');
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    try {
      if ((await fs.stat(path.join(root, name, 'freesurface'))).isDirectory()) out.push(name);
    } catch {
      /* no jobs */
    }
  }
  return out;
}

/**
 * Absolute path of an allow-listed downloadable job file, or null for any other
 * name: `domain_lidIter<k>.{stl,png}` (under geometry/) and `lid_iter<j>.png`.
 */
export function jobFileAbsolute(projectId: string, jobId: string, name: string): string | null {
  if (!isFreeSurfaceFileName(name)) return null;
  const dir = jobDirAbsolute(projectId, jobId);
  return name.startsWith('domain_lidIter')
    ? path.join(dir, 'geometry', name)
    : path.join(dir, name);
}
