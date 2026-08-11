// Integration tests for the standalone Meshing feature (STL -> snappyHexMesh ->
// polyMesh). The OpenFOAM toolchain is absent in CI / on a dev box, so the
// command runner is swapped for a fake that simulates the four steps (and writes
// the constant/polyMesh the real snappyHexMesh would) — exercising the full HTTP
// surface: auth, multipart STL upload, the run pipeline + per-step report, the
// zip download, and the clean "toolchain not found" degradation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { chamberPaths } from '../src/lib/chamberStorage';

/** Build a minimal binary STL from a list of triangles (each = 3 xyz vertices). */
function binaryStl(triangles: number[][][]): Buffer {
  const buf = Buffer.alloc(84 + triangles.length * 50);
  buf.writeUInt32LE(triangles.length, 80);
  triangles.forEach((tri, i) => {
    const base = 84 + i * 50 + 12;
    tri.forEach((vertex, v) => {
      const off = base + v * 12;
      buf.writeFloatLE(vertex[0], off);
      buf.writeFloatLE(vertex[1], off + 4);
      buf.writeFloatLE(vertex[2], off + 8);
    });
  });
  return buf;
}

const CUBE_STL = binaryStl([
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [1, 1, 1],
    [0, 1, 1],
    [1, 0, 1],
  ],
]);

const POLYMESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'] as const;

function ok(spec: { command: string; args: string[] }, stdout = 'ok'): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/** The caseDir a command was invoked against (the arg after `-case`). */
function caseDirOf(args: string[]): string {
  const i = args.indexOf('-case');
  return i >= 0 ? args[i + 1] : '';
}

/** Fake runner: every tool succeeds; the mesher writes constant/polyMesh. */
const successRunner: CommandRunner = async (spec) => {
  if (spec.command === 'snappyHexMesh' || spec.command === 'cartesianMesh') {
    const dir = path.join(caseDirOf(spec.args), 'constant', 'polyMesh');
    await fs.mkdir(dir, { recursive: true });
    for (const name of POLYMESH_FILES) {
      await fs.writeFile(path.join(dir, name), `${name}-data`);
    }
  }
  return ok(spec);
};

/** Fake runner: the first tool is missing (ENOENT), the rest never run. */
const notFoundRunner: CommandRunner = async (spec) => ({
  command: spec.command,
  args: spec.args,
  exitCode: null,
  stdout: '',
  stderr: '',
  durationMs: 0,
  timedOut: false,
  spawnError: 'ENOENT: command not found',
});

const CONFIG = {
  engine: 'snappy',
  domainType: 'internal',
  baseCellSize: 0.2,
  marginFactor: 0.1,
  surfaceRefinement: { min: 1, max: 2 },
  featureLevel: 2,
  locationInMesh: null,
  addLayers: { enabled: false, nLayers: 3 },
};

/** A minimal cfMesh run body (cartesianMesh writes the polyMesh in the fake runner). */
const CFMESH_CONFIG = {
  engine: 'cfmesh',
  maxCellSize: 0.2,
  extractFeatures: true,
  featureAngle: 45,
  addLayers: { enabled: false, nLayers: 3 },
  cores: 1,
};

beforeEach(async () => {
  await resetDatabase();
});
afterEach(() => setCommandRunner(null));

describe('Meshing sessions', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/v1/meshing').expect(401);
  });

  it('creates a session, uploads an STL (with bounds), and lists it', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);

    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Draft tube' })
      .expect(201);
    const id = created.body.session.id as string;
    expect(id).toBeTruthy();

    const uploaded = await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);
    expect(uploaded.body.session.stlCount).toBe(1);
    expect(uploaded.body.session.bounds).not.toBeNull();
    expect(uploaded.body.session.bounds.min).toEqual([0, 0, 0]);

    const list = await request(app).get('/api/v1/meshing').set('Authorization', auth).expect(200);
    expect(list.body.sessions.some((s: { id: string }) => s.id === id)).toBe(true);
  });

  it('rejects a non-STL upload', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const { body } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Bad' })
      .expect(201);
    await request(app)
      .post(`/api/v1/meshing/${body.session.id}/stl`)
      .set('Authorization', auth)
      .attach('files', Buffer.from('not an stl'), 'notes.txt')
      .expect(422);
  });

  it('runs the pipeline and produces a mesh (fake toolchain)', async () => {
    setCommandRunner(successRunner);
    const user = await createTestUser();
    const auth = authHeader(user);

    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Runnable' })
      .expect(201);
    const id = c.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);

    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(200);
    expect(run.body.result.success).toBe(true);
    expect(run.body.result.steps.map((s: { status: string }) => s.status)).toEqual([
      'success',
      'success',
      'success',
      'success',
    ]);
    expect(run.body.session.hasMesh).toBe(true);
    expect(run.body.session.lastRun).not.toBeNull();

    // The produced case downloads as a zip.
    const zip = await request(app)
      .get(`/api/v1/meshing/${id}/download`)
      .set('Authorization', auth)
      .expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
  });

  it('runs a cfMesh session (cartesianMesh) and produces a mesh', async () => {
    const commands: string[] = [];
    setCommandRunner(async (spec) => {
      commands.push(spec.command);
      return successRunner(spec);
    });
    const user = await createTestUser();
    const auth = authHeader(user);

    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'cfMesh runnable', engine: 'cfmesh' })
      .expect(201);
    expect(c.session.engine).toBe('cfmesh');
    const id = c.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);

    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(200);
    expect(run.body.result.success).toBe(true);
    expect(run.body.session.hasMesh).toBe(true);
    // One STL + feature extraction -> surfaceFeatureEdges then cartesianMesh + checkMesh.
    expect(commands).toEqual(['surfaceFeatureEdges', 'cartesianMesh', 'checkMesh']);
  });

  it('cfMesh merges several STLs in-process before meshing', async () => {
    const commands: string[] = [];
    setCommandRunner(async (spec) => {
      commands.push(spec.command);
      return successRunner(spec);
    });
    const user = await createTestUser();
    const auth = authHeader(user);

    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'cfMesh multi', engine: 'cfmesh' })
      .expect(201);
    const id = c.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'rotor.stl')
      .attach('files', CUBE_STL, 'stator.stl')
      .expect(201);

    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(200);
    expect(run.body.result.success).toBe(true);
    // The merge is in-process (not a command); the tools are unchanged.
    expect(commands).toEqual(['surfaceFeatureEdges', 'cartesianMesh', 'checkMesh']);
    const labels = run.body.result.steps.map((s: { label: string }) => s.label);
    expect(labels[0]).toBe('Combine surfaces');
  });

  it('rejects a config whose engine differs from the session', async () => {
    setCommandRunner(successRunner);
    const user = await createTestUser();
    const auth = authHeader(user);

    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Snappy session' })
      .expect(201);
    const id = c.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);

    // A cfMesh config on a snappy session is a 400 ENGINE_MISMATCH.
    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(400);
    expect(run.body.error.code).toBe('ENGINE_MISMATCH');
  });

  it('reports a clean per-step failure when the toolchain is missing', async () => {
    setCommandRunner(notFoundRunner);
    const user = await createTestUser();
    const auth = authHeader(user);

    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'No tools' })
      .expect(201);
    const id = c.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${id}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);

    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(200);
    expect(run.body.result.success).toBe(false);
    expect(run.body.result.steps[0].status).toBe('failed');
    expect(run.body.result.steps[0].stderr).toContain('ENOENT');
    expect(run.body.result.steps.slice(1).map((s: { status: string }) => s.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(run.body.session.hasMesh).toBe(false);
  });

  it('rejects a run with no STL', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const { body } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Empty' })
      .expect(201);
    await request(app)
      .post(`/api/v1/meshing/${body.session.id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(400);
  });

  it('deletes a session', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const { body } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Disposable' })
      .expect(201);
    const id = body.session.id as string;
    await request(app).delete(`/api/v1/meshing/${id}`).set('Authorization', auth).expect(200);
    await request(app).get(`/api/v1/meshing/${id}`).set('Authorization', auth).expect(404);
  });
});

/** One-facet ASCII STL solid (parseStlBounds needs a real triangle to accept it). */
function asciiSolid(name: string): string {
  return [
    `solid ${name}`,
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    `endsolid ${name}`,
  ].join('\n');
}

/** Seed a fake chamber build's trisurface.zip on disk (2 patches + domain.stl). */
async function seedChamberBuild(hash: string): Promise<void> {
  const zip = new AdmZip();
  const inlet = asciiSolid('inlet');
  const walls = asciiSolid('walls');
  zip.addFile('inlet.stl', Buffer.from(inlet));
  zip.addFile('walls.stl', Buffer.from(walls));
  zip.addFile('domain.stl', Buffer.from(`${inlet}\n${walls}`)); // must be excluded
  const { exportsDir } = chamberPaths(hash);
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(exportsDir, 'trisurface.zip'), zip.toBuffer());
}

describe('Meshing transfer + copy', () => {
  it('copies a session (engine + config + surfaces), leaving the source intact', async () => {
    const auth = authHeader(await createTestUser());
    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Src', engine: 'snappy' })
      .expect(201);
    const srcId = created.body.session.id as string;
    await request(app)
      .post(`/api/v1/meshing/${srcId}/stl`)
      .set('Authorization', auth)
      .attach('files', CUBE_STL, 'cube.stl')
      .expect(201);

    const copied = await request(app)
      .post('/api/v1/meshing/copy')
      .set('Authorization', auth)
      .send({ sourceId: srcId })
      .expect(201);
    expect(copied.body.session.id).not.toBe(srcId);
    expect(copied.body.session.engine).toBe('snappy');
    expect(copied.body.session.stlCount).toBe(1);
    expect(copied.body.session.hasMesh).toBe(false);
  });

  it('imports a chamber build into a NEW session, excluding domain.stl', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('deadbeefdeadbeef');
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber')
      .set('Authorization', auth)
      .send({ mode: 'new', chamberHash: 'deadbeefdeadbeef', name: 'From chamber', engine: 'snappy' })
      .expect(201);
    const names = (res.body.session.stls as { name: string }[]).map((s) => s.name).sort();
    expect(names).toEqual(['inlet.stl', 'walls.stl']);
  });

  it('imports a chamber build into an EXISTING session (overwrite by name)', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('cafecafecafecafe');
    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Target', engine: 'snappy' })
      .expect(201);
    const id = created.body.session.id as string;
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber')
      .set('Authorization', auth)
      .send({ mode: 'existing', chamberHash: 'cafecafecafecafe', sessionId: id })
      .expect(201);
    expect((res.body.session.stls as { name: string }[]).map((s) => s.name).sort()).toEqual([
      'inlet.stl',
      'walls.stl',
    ]);
  });

  it('copies a session AND injects a chamber build in one call (copyFrom)', async () => {
    const auth = authHeader(await createTestUser());
    await seedChamberBuild('f00df00df00df00d');
    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Ref setup', engine: 'snappy' })
      .expect(201);
    const srcId = created.body.session.id as string;
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber')
      .set('Authorization', auth)
      .send({ mode: 'copyFrom', chamberHash: 'f00df00df00df00d', sourceId: srcId })
      .expect(201);
    expect(res.body.session.id).not.toBe(srcId);
    expect((res.body.session.stls as { name: string }[]).map((s) => s.name).sort()).toEqual([
      'inlet.stl',
      'walls.stl',
    ]);
  });

  it('returns 409 CHAMBER_NOT_BUILT for an unknown chamber hash', async () => {
    const auth = authHeader(await createTestUser());
    const res = await request(app)
      .post('/api/v1/meshing/from-chamber')
      .set('Authorization', auth)
      .send({ mode: 'new', chamberHash: 'notarealhash1234', name: 'X', engine: 'snappy' })
      .expect(409);
    expect(res.body.error.code).toBe('CHAMBER_NOT_BUILT');
  });
});
