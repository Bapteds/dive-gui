// Integration tests for POST /projects/:id/mesh/from-meshing (WS-F): send a
// meshing session's constant/polyMesh into a project, either as the case mesh
// (`case`) or as a mesh-library part (`library`). No OpenFOAM is needed: the
// session mesh is written straight to disk (the five polyMesh files) and the
// route only copies + edits text files. The MESH_IN_PROGRESS registry case uses a
// hanging stream-runner fake, restored in afterEach.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setStreamRunner, type StreamExit, type StreamHandle, type StreamSpec } from '../src/lib/streamRunner';
import { caseDirAbsolute, readCaseFile, writeCaseFile } from '../src/lib/caseStorage';
import { createSession, sessionPolyMeshDir, writeMeshStatus } from '../src/lib/meshingStorage';
import { storageRoot } from '../src/lib/fileTreeStorage';
import { parseBoundaryPatchDetails } from '../src/lib/openfoamCase';
import { vizArtifactPaths, vizIsStale } from '../src/lib/vizStorage';

const TEST_STORAGE = './test-storage';

/** One patch line of a fake boundary file. */
interface FakePatch {
  name: string;
  type: string;
  nFaces: number;
  extra?: string;
}

/** Render a polyBoundaryMesh file from patch specs (startFace laid out in order). */
function boundaryOf(patches: FakePatch[]): string {
  let start = 100;
  const lines = patches.map((p) => {
    const line = `    ${p.name} { type ${p.type}; ${p.extra ?? ''}nFaces ${p.nFaces}; startFace ${start}; }`;
    start += p.nFaces;
    return line;
  });
  return `FoamFile { class polyBoundaryMesh; object boundary; }\n${patches.length}\n(\n${lines.join('\n')}\n)\n`;
}

/** What snappy leaves by default: every surface a wall, plus a leftover domainBoundary. */
const SNAPPY_PATCHES: FakePatch[] = [
  { name: 'inlet', type: 'wall', nFaces: 10, extra: 'inGroups List<word> 1(wall); ' },
  { name: 'outlet', type: 'wall', nFaces: 10 },
  { name: 'walls', type: 'wall', nFaces: 20 },
  { name: 'hub', type: 'patch', nFaces: 6 },
  { name: 'rotor_x', type: 'patch', nFaces: 4 },
  { name: 'domainBoundary', type: 'patch', nFaces: 0 },
];

const MESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'] as const;

/** Create a meshing session on disk with a produced polyMesh (optionally partial). */
async function makeSession(
  name: string,
  options: { patches?: FakePatch[]; omit?: string[]; extraFiles?: string[] } = {},
): Promise<string> {
  const meta = await createSession(name, 'snappy');
  const dir = sessionPolyMeshDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  for (const file of MESH_FILES) {
    if (options.omit?.includes(file)) continue;
    const content =
      file === 'boundary' ? boundaryOf(options.patches ?? SNAPPY_PATCHES) : `${meta.id}-${file}-data`;
    await fs.writeFile(path.join(dir, file), content);
  }
  for (const extra of options.extraFiles ?? []) {
    await fs.mkdir(path.dirname(path.join(dir, extra)), { recursive: true });
    await fs.writeFile(path.join(dir, extra), `${extra}-data`);
  }
  // Session artifacts that must never travel with the mesh.
  await fs.writeFile(path.join(dir, '..', '..', 'mesh.log'), 'log');
  await fs.mkdir(path.join(dir, '..', '..', 'system'), { recursive: true });
  await fs.writeFile(path.join(dir, '..', '..', 'system', 'controlDict'), 'session-controlDict');
  return meta.id;
}

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

/** Send a session to a project. */
function send(projectId: string, auth: string | null, body: Record<string, unknown>) {
  const req = request(app).post(`/api/v1/projects/${projectId}/mesh/from-meshing`);
  if (auth) req.set('Authorization', auth);
  return req.send(body);
}

/** Absolute path of a project storage file. */
function projectPath(projectId: string, ...segs: string[]): string {
  return path.join(storageRoot(), 'projects', projectId, ...segs);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Seed a configured case: an old mesh, a controlDict and a 0/U with physics. */
async function seedConfiguredCase(projectId: string): Promise<void> {
  const oldBoundary = boundaryOf([
    { name: 'inlet', type: 'patch', nFaces: 5 },
    { name: 'walls', type: 'wall', nFaces: 9 },
  ]);
  for (const file of MESH_FILES) {
    await writeCaseFile(
      projectId,
      `constant/polyMesh/${file}`,
      file === 'boundary' ? oldBoundary : `old-${file}`,
    );
  }
  await writeCaseFile(projectId, 'system/controlDict', 'user-controlDict');
  await writeCaseFile(
    projectId,
    '0/U',
    `FoamFile { class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }
    walls
    {
        type            noSlip;
    }
}
`,
  );
}

/** The `type` line of one patch block of a 0/ field. */
function fieldPatchBody(field: string, patch: string): string {
  const m = field.match(new RegExp(`\\b${patch}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}

/** Fake STREAM runner that never exits until stopped (an active mesh run). */
function hangingStreamRunner(): (spec: StreamSpec) => StreamHandle {
  return () => {
    let resolve!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((r) => {
      resolve = r;
    });
    return { pid: 999, onExit, stop: () => resolve({ exitCode: null, signal: 'SIGTERM' }) };
  };
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm(TEST_STORAGE, { recursive: true, force: true });
});

afterEach(() => setStreamRunner(null));

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm(TEST_STORAGE, { recursive: true, force: true });
});

describe('POST /projects/:id/mesh/from-meshing: access and validation', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('wsf-401@dive-turbinen.test');
    const sessionId = await makeSession('Auth');
    const res = await send(id, null, { sessionId, target: 'case' });
    expect(res.status).toBe(401);
  });

  it('answers 404 for a stranger, even with a valid session', async () => {
    const { id } = await makeProject('wsf-owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'wsf-stranger@dive-turbinen.test' });
    const sessionId = await makeSession('Stranger');
    const res = await send(id, authHeader(stranger), { sessionId, target: 'case' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await exists(path.join(caseDirAbsolute(id), 'constant'))).toBe(false);
  });

  it('answers 404 for an unknown session', async () => {
    const { id, auth } = await makeProject('wsf-nosession@dive-turbinen.test');
    const res = await send(id, auth, { sessionId: 'no-such-session', target: 'case' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Meshing session not found.');
  });

  it('rejects a bad body with 422', async () => {
    const { id, auth } = await makeProject('wsf-422@dive-turbinen.test');
    const sessionId = await makeSession('Validation');
    const badTarget = await send(id, auth, { sessionId, target: 'elsewhere' });
    expect(badTarget.status).toBe(422);
    expect(badTarget.body.error.code).toBe('VALIDATION_ERROR');
    const unsafe = await send(id, auth, { sessionId: '../escape', target: 'case' });
    expect(unsafe.status).toBe(422);
    const emptyName = await send(id, auth, { sessionId, target: 'library', name: '   ' });
    expect(emptyName.status).toBe(422);
  });

  it('lets a super-admin send into someone else\'s project', async () => {
    const { id } = await makeProject('wsf-admin-owner@dive-turbinen.test');
    const admin = await createProtectedAdmin();
    const sessionId = await makeSession('Admin');
    const res = await send(id, authHeader(admin), { sessionId, target: 'case' });
    expect(res.status).toBe(200);
    expect(res.body.result.target).toBe('case');
  });
});

describe('POST /projects/:id/mesh/from-meshing: session and run guards', () => {
  it('409 MESH_IN_PROGRESS while the session status is running', async () => {
    const { id, auth } = await makeProject('wsf-running@dive-turbinen.test');
    const sessionId = await makeSession('Running');
    await writeMeshStatus(sessionId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MESH_IN_PROGRESS');
  });

  it('409 MESH_IN_PROGRESS while a run of the session is active in this process', async () => {
    setStreamRunner(hangingStreamRunner());
    const { id, auth } = await makeProject('wsf-registry@dive-turbinen.test');
    const sessionId = await makeSession('Registry');
    // A tiny binary STL so the run can start (the hanging runner never finishes).
    const stl = Buffer.alloc(84 + 50);
    stl.writeUInt32LE(1, 80);
    stl.writeFloatLE(1, 84 + 12 + 12);
    stl.writeFloatLE(1, 84 + 12 + 28);
    await request(app)
      .post(`/api/v1/meshing/${sessionId}/stl`)
      .set('Authorization', auth)
      .attach('files', stl, 'cube.stl')
      .expect(201);
    await request(app)
      .post(`/api/v1/meshing/${sessionId}/run`)
      .set('Authorization', auth)
      .send({
        engine: 'snappy',
        domainType: 'internal',
        baseCellSize: 0.2,
        marginFactor: 0.1,
        surfaceRefinement: { min: 1, max: 2 },
        featureLevel: 2,
        locationInMesh: null,
        addLayers: { enabled: false, nLayers: 3 },
      })
      .expect(202);

    // Wait until the first tool is live (its handle registered), so the stop below
    // lands on a running process rather than on the pre-step setup.
    const readLog = () =>
      request(app).get(`/api/v1/meshing/${sessionId}/run/log`).set('Authorization', auth);
    let deadline = Date.now() + 10000;
    while (!String((await readLog()).body.log?.logTail ?? '').includes('$ blockMesh')) {
      if (Date.now() > deadline) throw new Error('mesh run never reached blockMesh');
      await new Promise((r) => setTimeout(r, 15));
    }

    const res = await send(id, auth, { sessionId, target: 'library' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MESH_IN_PROGRESS');

    // Settle the hung run so it does not leak past the test.
    await request(app).post(`/api/v1/meshing/${sessionId}/run/stop`).set('Authorization', auth).expect(200);
    deadline = Date.now() + 5000;
    while ((await readLog()).body.log?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
  });

  it('409 MESHING_NOT_MESHED when the session polyMesh has no neighbour', async () => {
    const { id, auth } = await makeProject('wsf-notmeshed@dive-turbinen.test');
    const sessionId = await makeSession('Partial', { omit: ['neighbour'] });
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MESHING_NOT_MESHED');
    expect(res.body.error.message).toBe('This session has no mesh yet. Generate the mesh first.');
  });

  it('409 RUN_IN_PROGRESS for the case target while a solver run is active', async () => {
    const { id, auth } = await makeProject('wsf-run@dive-turbinen.test');
    await prisma.run.create({
      data: { projectId: id, solver: 'simpleFoam', status: 'running', command: '', logPath: '' },
    });
    const sessionId = await makeSession('Solver busy');
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_IN_PROGRESS');
    // The library target does not touch the case: allowed during a run.
    const lib = await send(id, auth, { sessionId, target: 'library' });
    expect(lib.status).toBe(200);
  });
});

describe('POST /projects/:id/mesh/from-meshing: case target', () => {
  it('on an empty project: copies the polyMesh, scaffolds system/, takes no backup', async () => {
    const { id, auth } = await makeProject('wsf-empty@dive-turbinen.test');
    const sessionId = await makeSession('Empty target', { extraFiles: ['cellZones', 'sets/rotor'] });
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.target).toBe('case');

    for (const file of ['points', 'faces', 'owner', 'neighbour', 'cellZones', 'sets/rotor']) {
      const copied = await readCaseFile(id, `constant/polyMesh/${file}`);
      const original = await fs.readFile(path.join(sessionPolyMeshDir(sessionId), file));
      expect(copied?.equals(original)).toBe(true);
    }
    // Session artifacts never travel.
    expect((await readCaseFile(id, 'system/controlDict'))?.toString()).not.toBe('session-controlDict');
    expect(await readCaseFile(id, 'mesh.log')).toBeNull();
    expect(await exists(projectPath(id, 'backups', 'mesh-backup.json'))).toBe(false);
    expect(result.notes).toContain('Created a minimal system/ so the Solver tab can take over.');
    // The retyped inlet gets a non-wall default (no noSlip) in the scaffolded 0/U.
    const u = (await readCaseFile(id, '0/U'))!.toString();
    expect(fieldPatchBody(u, 'inlet')).not.toMatch(/noSlip|WallFunction/);
    expect(result.entries.some((e: { path: string }) => e.path === 'constant/polyMesh/boundary')).toBe(
      true,
    );
    // The staging dir is cleaned up.
    const work = projectPath(id, 'meshes', '.work');
    const leftovers = (await exists(work)) ? await fs.readdir(work) : [];
    expect(leftovers.filter((n) => n.startsWith('from-meshing-'))).toEqual([]);
  });

  it('on a configured project: backs up once, keeps BCs, adds defaults, clears the assembly', async () => {
    const { id, auth } = await makeProject('wsf-configured@dive-turbinen.test');
    await seedConfiguredCase(id);
    await fs.mkdir(projectPath(id, 'meshes'), { recursive: true });
    await fs.writeFile(projectPath(id, 'meshes', 'assembly.json'), '{"plan":{}}');
    // A render cached before the transfer (made old so the mtime check is decisive).
    const viz = vizArtifactPaths(id);
    await fs.mkdir(path.dirname(viz.glb), { recursive: true });
    await fs.writeFile(viz.glb, 'glb');
    await fs.writeFile(viz.edges, 'edges');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(viz.glb, past, past);
    await fs.utimes(viz.edges, past, past);
    await fs.utimes(path.join(caseDirAbsolute(id), 'constant', 'polyMesh', 'boundary'), past, past);
    await fs.utimes(path.join(caseDirAbsolute(id), 'constant', 'polyMesh', 'points'), past, past);
    expect(await vizIsStale(id)).toBe(false);

    const sessionId = await makeSession('Configured');
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(200);
    const result = res.body.result;

    // Backup: the ORIGINAL case, taken once.
    const backupPoints = projectPath(id, 'backups', 'case', 'constant', 'polyMesh', 'points');
    expect(await fs.readFile(backupPoints, 'utf8')).toBe('old-points');
    const second = await send(id, auth, { sessionId: await makeSession('Again'), target: 'case' });
    expect(second.status).toBe(200);
    expect(await fs.readFile(backupPoints, 'utf8')).toBe('old-points');

    // Physics: inlet keeps its BC (merge mode), the new outlet gets a default.
    const u = (await readCaseFile(id, '0/U'))!.toString();
    expect(fieldPatchBody(u, 'inlet')).toMatch(/fixedValue/);
    expect(fieldPatchBody(u, 'outlet')).toMatch(/zeroGradient/);
    expect(result.syncedFields).toContain('0/U');
    expect((await readCaseFile(id, 'system/controlDict'))?.toString()).toBe('user-controlDict');

    expect(await exists(projectPath(id, 'meshes', 'assembly.json'))).toBe(false);
    expect(await vizIsStale(id)).toBe(true);
    expect(result.notes.join(' ')).toMatch(/backed up/i);
  });

  it('forces the chamber patch types and drops only the empty domainBoundary', async () => {
    const { id, auth } = await makeProject('wsf-retype@dive-turbinen.test');
    const sessionId = await makeSession('Retype', {
      patches: [
        ...SNAPPY_PATCHES.filter((p) => p.name !== 'outlet'),
        { name: 'outlet', type: 'wall', nFaces: 0 }, // an empty chamber patch is kept
        { name: 'shroud', type: 'cyclicAMI', nFaces: 3, extra: 'neighbourPatch hub; ' },
      ],
    });
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(200);
    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))!.toString();
    const types = Object.fromEntries(parseBoundaryPatchDetails(boundary).map((p) => [p.name, p.type]));
    expect(types).toEqual({
      inlet: 'patch',
      walls: 'wall',
      hub: 'wall',
      rotor_x: 'patch', // not a chamber name: untouched
      outlet: 'patch',
      shroud: 'cyclicAMI', // a constraint type is never overwritten
    });
    expect(boundary).toMatch(/\n6\n\(/); // count renumbered after dropping domainBoundary
    expect(res.body.result.retyped).toEqual(['inlet', 'hub', 'outlet']);
    expect(res.body.result.notes.join(' ')).toMatch(/domainBoundary/);
  });

  it('keeps a domainBoundary that carries faces (external meshing)', async () => {
    const { id, auth } = await makeProject('wsf-external@dive-turbinen.test');
    const sessionId = await makeSession('External', {
      patches: [
        { name: 'inlet', type: 'patch', nFaces: 10 },
        { name: 'domainBoundary', type: 'patch', nFaces: 12 },
      ],
    });
    const res = await send(id, auth, { sessionId, target: 'case' });
    expect(res.status).toBe(200);
    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))!.toString();
    expect(parseBoundaryPatchDetails(boundary).map((p) => p.name)).toEqual(['inlet', 'domainBoundary']);
  });
});

describe('POST /projects/:id/mesh/from-meshing: library target', () => {
  it('adds a meshing part (slug from name, -2 on collision), keeps the mesher types', async () => {
    const { id, auth } = await makeProject('wsf-library@dive-turbinen.test');
    const sessionId = await makeSession('Chamber v3 session');

    const first = await send(id, auth, { sessionId, target: 'library', name: 'Chamber v3' });
    expect(first.status).toBe(200);
    expect(first.body.result.target).toBe('library');
    expect(first.body.result.mesh).toMatchObject({ id: 'chamber-v3', name: 'Chamber v3', kind: 'meshing' });
    // Mesher types kept (no forcing on the library target), empty domainBoundary dropped.
    const patches = first.body.result.mesh.patches as { name: string; type: string }[];
    expect(patches.find((p) => p.name === 'inlet')?.type).toBe('wall');
    expect(patches.some((p) => p.name === 'domainBoundary')).toBe(false);
    const meta = JSON.parse(await fs.readFile(projectPath(id, 'meshes', 'chamber-v3', 'meta.json'), 'utf8'));
    expect(meta.origin).toEqual({ sessionId });

    const second = await send(id, auth, { sessionId, target: 'library', name: 'Chamber v3' });
    expect(second.body.result.mesh.id).toBe('chamber-v3-2');

    // Default name = the session display name.
    const third = await send(id, auth, { sessionId, target: 'library' });
    expect(third.body.result.mesh.name).toBe('Chamber v3 session');

    const list = await request(app).get(`/api/v1/projects/${id}/meshes`).set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.meshes.map((m: { id: string; kind: string }) => [m.id, m.kind])).toEqual([
      ['chamber-v3', 'meshing'],
      ['chamber-v3-2', 'meshing'],
      ['chamber-v3-session', 'meshing'],
    ]);
    expect(third.body.result.meshes).toHaveLength(3);
    // The case is untouched.
    expect(await exists(path.join(caseDirAbsolute(id), 'constant'))).toBe(false);
  });
});
