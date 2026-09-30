// The recorded origin of a project's CURRENT case mesh (WS-I spec §4).
//
// Layout:  <STORAGE_DIR>/projects/<projectId>/mesh-origin.json
//            { sessionId, sessionName, engine, chamberHash, at }
//
// Written by the meshing -> project hand-off (mesh.service.importMeshFromMeshing,
// case target) AFTER the mesh is copied; deleted by every other case-mesh
// replacement (caseStorage.replaceCasePolyMesh / clearCase, a case import, a
// CGNS conversion), since the recorded origin would then be stale. Read by the
// Free surface tab (default source session) and WS-H.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MESHING_ENGINES, type MeshOrigin, type MeshingEngine } from '@dive/shared';
import { assertSafeId, storageRoot } from './fileTreeStorage';

/** Absolute path of a project's mesh-origin.json. */
function originPath(projectId: string): string {
  assertSafeId(projectId);
  return path.join(storageRoot(), 'projects', projectId, 'mesh-origin.json');
}

/** Read the recorded origin, or null when absent / unreadable. */
export async function readMeshOrigin(projectId: string): Promise<MeshOrigin | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(originPath(projectId), 'utf8'),
    ) as Partial<MeshOrigin>;
    if (!parsed.sessionId || !parsed.sessionName || !parsed.at) return null;
    const engine = MESHING_ENGINES.includes(parsed.engine as MeshingEngine)
      ? (parsed.engine as MeshingEngine)
      : 'snappy';
    return {
      sessionId: parsed.sessionId,
      sessionName: parsed.sessionName,
      engine,
      chamberHash: typeof parsed.chamberHash === 'string' ? parsed.chamberHash : null,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/** Record the origin (atomic: tmp + rename). */
export async function writeMeshOrigin(projectId: string, origin: MeshOrigin): Promise<void> {
  const file = originPath(projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(origin), 'utf8');
  await fs.rename(tmp, file);
}

/** Forget the origin (the case mesh was replaced by something else). Never throws. */
export async function clearMeshOrigin(projectId: string): Promise<void> {
  await fs.rm(originPath(projectId), { force: true }).catch(() => undefined);
}
