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
import { app, authHeader, createTestUser, logicalCommand, resetDatabase } from './helpers';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamSpec,
} from '../src/lib/streamRunner';
import { chamberPaths } from '../src/lib/chamberStorage';
import { runCfMeshSchema, runSnappySchema } from '../src/modules/meshing/meshing.schemas';

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

/** The caseDir a command was invoked against (the arg after `-case`). */
function caseDirOf(args: string[]): string {
  const i = args.indexOf('-case');
  return i >= 0 ? args[i + 1] : '';
}

/**
 * Fake STREAM runner: every step streams a line to its log and exits 0; the mesher
 * step (snappyHexMesh / cartesianMesh) also writes the constant/polyMesh the real
 * tool would. `commands` (optional) records each underlying tool in order. Sees
 * through the OPENFOAM_BASHRC `bash -c` wrapper via logicalCommand.
 */
function successStreamRunner(commands?: string[]): (spec: StreamSpec) => StreamHandle {
  return (spec) => {
    const { command, args } = logicalCommand(spec);
    commands?.push(command);
    const onExit = (async (): Promise<StreamExit> => {
      await fs.appendFile(spec.logFile, `[${command}] ran\n`).catch(() => undefined);
      if (command === 'snappyHexMesh' || command === 'cartesianMesh') {
        const dir = path.join(caseDirOf(args), 'constant', 'polyMesh');
        await fs.mkdir(dir, { recursive: true });
        for (const name of POLYMESH_FILES) await fs.writeFile(path.join(dir, name), `${name}-data`);
      }
      return { exitCode: 0, signal: null };
    })();
    return { pid: 4321, onExit, stop: () => undefined };
  };
}

/** Fake STREAM runner: the first tool is missing (spawn ENOENT); the rest are skipped. */
function notFoundStreamRunner(): (spec: StreamSpec) => StreamHandle {
  return () => ({
    pid: null,
    onExit: Promise.resolve<StreamExit>({
      exitCode: null,
      signal: null,
      spawnError: 'ENOENT: command not found',
    }),
    stop: () => undefined,
  });
}

/**
 * Fake STREAM runner that HANGS: each step's onExit resolves only when stop() is
 * called (as a killed process would). Lets a test observe a 'running' run and then
 * cancel it. The resolvers are captured so a test can also settle it directly.
 */
function hangingStreamRunner(): (spec: StreamSpec) => StreamHandle {
  return () => {
    let resolve!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((r) => {
      resolve = r;
    });
    return { pid: 999, onExit, stop: () => resolve({ exitCode: null, signal: 'SIGTERM' }) };
  };
}

/**
 * Poll the run-log endpoint until the run leaves 'running'; returns the final
 * payload. The deadline is generous (well under vitest's 20s testTimeout) because
 * the background pipeline is fs-heavy (Allclean + dict writes) and slow on WSL/CI
 * disk — a tight deadline would flake, not catch a real hang.
 */
async function pollMeshLog(
  id: string,
  auth: string,
  timeoutMs = 15000,
): Promise<{ status: string; logTail: string; logBytes: number; run: { result: { success: boolean; steps: { status: string; label: string; stderr: string }[] } } | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app)
      .get(`/api/v1/meshing/${id}/run/log`)
      .set('Authorization', auth)
      .expect(200);
    const log = res.body.log;
    if (log.status !== 'running') return log;
    if (Date.now() > deadline) throw new Error(`mesh run stuck at ${log.status}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

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
afterEach(() => setStreamRunner(null));

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

  it('renames a session (display name only; id/engine unchanged)', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);

    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Original', engine: 'cfmesh' })
      .expect(201);
    const id = created.body.session.id as string;

    const renamed = await request(app)
      .patch(`/api/v1/meshing/${id}`)
      .set('Authorization', auth)
      .send({ name: 'Renamed tube' })
      .expect(200);
    expect(renamed.body.session).toMatchObject({ id, name: 'Renamed tube', engine: 'cfmesh' });

    // Persists across a fresh read.
    const fetched = await request(app)
      .get(`/api/v1/meshing/${id}`)
      .set('Authorization', auth)
      .expect(200);
    expect(fetched.body.session.name).toBe('Renamed tube');
  });

  it('rejects a blank rename with 422 and a missing session with 404', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const created = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: 'Keep' })
      .expect(201);
    const id = created.body.session.id as string;

    await request(app)
      .patch(`/api/v1/meshing/${id}`)
      .set('Authorization', auth)
      .send({ name: '   ' })
      .expect(422);
    await request(app)
      .patch('/api/v1/meshing/does-not-exist')
      .set('Authorization', auth)
      .send({ name: 'Whatever' })
      .expect(404);
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

  /** Create a session with the given engine + a cube STL; returns its id + auth. */
  async function seedRunnableSession(
    engine: 'snappy' | 'cfmesh',
    surfaces: string[] = ['cube.stl'],
  ): Promise<{ id: string; auth: string }> {
    const user = await createTestUser({ email: `mesh-run-${Math.random().toString(36).slice(2)}@dive.test` });
    const auth = authHeader(user);
    const { body: c } = await request(app)
      .post('/api/v1/meshing')
      .set('Authorization', auth)
      .send({ name: `Run ${engine}`, engine })
      .expect(201);
    const id = c.session.id as string;
    let req = request(app).post(`/api/v1/meshing/${id}/stl`).set('Authorization', auth);
    for (const name of surfaces) req = req.attach('files', CUBE_STL, name);
    await req.expect(201);
    return { id, auth };
  }

  it('starts a background run that streams a log and produces a mesh', async () => {
    setStreamRunner(successStreamRunner());
    const { id, auth } = await seedRunnableSession('snappy');

    // The run STARTS (202) and returns immediately as 'running'.
    const start = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(202);
    expect(start.body.status.status).toBe('running');
    expect(start.body.session.runStatus).toBe('running');

    // Poll the live log until it finishes; the per-step report is on the payload.
    const log = await pollMeshLog(id, auth);
    expect(log.status).toBe('succeeded');
    expect(log.logBytes).toBeGreaterThan(0);
    expect(log.run?.result.success).toBe(true);
    expect(log.run?.result.steps.map((s) => s.status)).toEqual([
      'success',
      'success',
      'success',
      'success',
    ]);

    // The session reflects the finished mesh; the produced case downloads as a zip.
    const detail = await request(app).get(`/api/v1/meshing/${id}`).set('Authorization', auth).expect(200);
    expect(detail.body.session.hasMesh).toBe(true);
    expect(detail.body.session.lastRun).not.toBeNull();
    expect(detail.body.session.runStatus).toBe('succeeded');
    const zip = await request(app)
      .get(`/api/v1/meshing/${id}/download`)
      .set('Authorization', auth)
      .expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
  });

  it('runs a cfMesh session (cartesianMesh) and produces a mesh', async () => {
    const commands: string[] = [];
    setStreamRunner(successStreamRunner(commands));
    const { id, auth } = await seedRunnableSession('cfmesh');

    await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(202);
    const log = await pollMeshLog(id, auth);
    expect(log.status).toBe('succeeded');
    expect(log.run?.result.success).toBe(true);
    // One STL + feature extraction -> surfaceFeatureEdges then cartesianMesh + checkMesh.
    expect(commands).toEqual(['surfaceFeatureEdges', 'cartesianMesh', 'checkMesh']);
  });

  it('cfMesh merges several STLs in-process before meshing', async () => {
    const commands: string[] = [];
    setStreamRunner(successStreamRunner(commands));
    const { id, auth } = await seedRunnableSession('cfmesh', ['rotor.stl', 'stator.stl']);

    await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(202);
    const log = await pollMeshLog(id, auth);
    expect(log.run?.result.success).toBe(true);
    // The merge is in-process (not a command); the tools are unchanged.
    expect(commands).toEqual(['surfaceFeatureEdges', 'cartesianMesh', 'checkMesh']);
    expect(log.run?.result.steps[0].label).toBe('Combine surfaces');
  });

  it('rejects a config whose engine differs from the session', async () => {
    setStreamRunner(successStreamRunner());
    const { id, auth } = await seedRunnableSession('snappy');

    // A cfMesh config on a snappy session is a 400 ENGINE_MISMATCH (before starting).
    const run = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CFMESH_CONFIG)
      .expect(400);
    expect(run.body.error.code).toBe('ENGINE_MISMATCH');
  });

  it('reports a clean per-step failure when the toolchain is missing', async () => {
    setStreamRunner(notFoundStreamRunner());
    const { id, auth } = await seedRunnableSession('snappy');

    await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(202);
    const log = await pollMeshLog(id, auth);
    expect(log.status).toBe('failed');
    expect(log.run?.result.success).toBe(false);
    expect(log.run?.result.steps[0].status).toBe('failed');
    expect(log.run?.result.steps[0].stderr).toContain('ENOENT');
    expect(log.run?.result.steps.slice(1).map((s) => s.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);

    const detail = await request(app).get(`/api/v1/meshing/${id}`).set('Authorization', auth).expect(200);
    expect(detail.body.session.hasMesh).toBe(false);
    expect(detail.body.session.runStatus).toBe('failed');
  });

  it('reports idle for a session that has never run', async () => {
    const { id, auth } = await seedRunnableSession('snappy');
    const res = await request(app)
      .get(`/api/v1/meshing/${id}/run/log`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.log.status).toBe('idle');
    expect(res.body.log.logBytes).toBe(0);
    expect(res.body.log.run).toBeNull();
  });

  it('rejects a second run while one is already in progress (409), then stops it', async () => {
    setStreamRunner(hangingStreamRunner());
    const { id, auth } = await seedRunnableSession('snappy');

    await request(app).post(`/api/v1/meshing/${id}/run`).set('Authorization', auth).send(CONFIG).expect(202);
    // A concurrent start is rejected while the first run is active.
    const second = await request(app)
      .post(`/api/v1/meshing/${id}/run`)
      .set('Authorization', auth)
      .send(CONFIG)
      .expect(409);
    expect(second.body.error.code).toBe('MESH_IN_PROGRESS');

    // Stopping settles the hung run so it does not leak past the test.
    await request(app).post(`/api/v1/meshing/${id}/run/stop`).set('Authorization', auth).expect(200);
    const log = await pollMeshLog(id, auth);
    expect(log.status).toBe('stopped');
  });

  it('stops a running mesh and records it stopped', async () => {
    setStreamRunner(hangingStreamRunner());
    const { id, auth } = await seedRunnableSession('snappy');

    await request(app).post(`/api/v1/meshing/${id}/run`).set('Authorization', auth).send(CONFIG).expect(202);
    // The run is observably active before we stop it.
    const mid = await request(app).get(`/api/v1/meshing/${id}/run/log`).set('Authorization', auth).expect(200);
    expect(mid.body.log.status).toBe('running');

    const stop = await request(app)
      .post(`/api/v1/meshing/${id}/run/stop`)
      .set('Authorization', auth)
      .expect(200);
    expect(stop.body.session).toBeDefined();

    const log = await pollMeshLog(id, auth);
    expect(log.status).toBe('stopped');
    const detail = await request(app).get(`/api/v1/meshing/${id}`).set('Authorization', auth).expect(200);
    expect(detail.body.session.runStatus).toBe('stopped');
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

describe('runSnappySchema — per-patch feature edges', () => {
  const base = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };

  it('defaults featureAngle to 150 and leaves featureRefinements undefined', () => {
    const parsed = runSnappySchema.parse(base);
    expect(parsed.featureAngle).toBe(150);
    expect(parsed.featureRefinements).toBeUndefined();
  });

  it('accepts a per-patch feature override', () => {
    const parsed = runSnappySchema.parse({
      ...base,
      featureRefinements: { 'rotor.stl': { includedAngle: 120, level: 4 } },
    });
    expect(parsed.featureRefinements?.['rotor.stl']).toEqual({ includedAngle: 120, level: 4 });
  });

  it('rejects an out-of-range angle and a non-integer level', () => {
    expect(() =>
      runSnappySchema.parse({ ...base, featureRefinements: { 'r.stl': { includedAngle: 200, level: 2 } } }),
    ).toThrow();
    expect(() =>
      runSnappySchema.parse({ ...base, featureRefinements: { 'r.stl': { includedAngle: 90, level: 1.5 } } }),
    ).toThrow();
  });
});

describe('runSnappySchema — feature surfaces gate', () => {
  const base = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };

  it('accepts a featureSurfaces list', () => {
    const parsed = runSnappySchema.parse({ ...base, featureSurfaces: ['rotor.stl'] });
    expect(parsed.featureSurfaces).toEqual(['rotor.stl']);
  });

  it('leaves featureSurfaces undefined when omitted', () => {
    expect(runSnappySchema.parse(base).featureSurfaces).toBeUndefined();
  });
});

describe('per-patch boundary layers — schema', () => {
  const snappyBase = { engine: 'snappy', domainType: 'internal', surfaceRefinement: { min: 1, max: 2 } };
  const cfBase = { engine: 'cfmesh' };

  it('snappy accepts a per-surface layer override', () => {
    const parsed = runSnappySchema.parse({
      ...snappyBase,
      addLayers: {
        enabled: true, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2,
        perSurface: { 'rotor.stl': { nLayers: 6, expansionRatio: 1.3, finalLayerThickness: 0.4 } },
      },
    });
    expect(parsed.addLayers.perSurface?.['rotor.stl']).toEqual({
      nLayers: 6, expansionRatio: 1.3, finalLayerThickness: 0.4,
    });
  });

  it('cfMesh accepts a per-patch layer override', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      addLayers: {
        enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
        perPatch: { walls: { nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: 0.01 } },
      },
    });
    expect(parsed.addLayers.perPatch?.walls).toEqual({
      nLayers: 5, thicknessRatio: 1.4, maxFirstLayerThickness: 0.01,
    });
  });

  it('leaves the maps undefined when omitted', () => {
    const s = runSnappySchema.parse({
      ...snappyBase,
      addLayers: { enabled: false, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2 },
    });
    expect(s.addLayers.perSurface).toBeUndefined();
    const c = runCfMeshSchema.parse({ ...cfBase });
    expect(c.addLayers.perPatch).toBeUndefined();
  });

  it('rejects an out-of-range per-surface layer count', () => {
    expect(() =>
      runSnappySchema.parse({
        ...snappyBase,
        addLayers: {
          enabled: true, nLayers: 3, relativeSizes: true, finalLayerThickness: 0.5, expansionRatio: 1.2,
          perSurface: { 'r.stl': { nLayers: 99, expansionRatio: 1.2, finalLayerThickness: 0.5 } },
        },
      }),
    ).toThrow();
  });

  it('rejects an out-of-range per-patch layer value', () => {
    expect(() =>
      runCfMeshSchema.parse({
        ...cfBase,
        addLayers: {
          enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
          perPatch: { walls: { nLayers: 5, thicknessRatio: 50, maxFirstLayerThickness: null } },
        },
      }),
    ).toThrow();
  });
});

describe('cfMesh — local refinement + layer off-list (schema)', () => {
  const cfBase = { engine: 'cfmesh' };

  it('accepts a per-patch local refinement cell size', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      localRefinement: { blade: { cellSize: 0.002 } },
    });
    expect(parsed.localRefinement?.blade).toEqual({ cellSize: 0.002 });
  });

  it('rejects a non-positive local refinement cell size', () => {
    expect(() =>
      runCfMeshSchema.parse({ ...cfBase, localRefinement: { blade: { cellSize: 0 } } }),
    ).toThrow();
  });

  it('accepts a noLayerPatches list on addLayers', () => {
    const parsed = runCfMeshSchema.parse({
      ...cfBase,
      addLayers: {
        enabled: true, nLayers: 3, thicknessRatio: 1.2, maxFirstLayerThickness: null,
        noLayerPatches: ['inlet', 'outlet'],
      },
    });
    expect(parsed.addLayers.noLayerPatches).toEqual(['inlet', 'outlet']);
  });

  it('leaves the new fields undefined when omitted', () => {
    const c = runCfMeshSchema.parse({ ...cfBase });
    expect(c.localRefinement).toBeUndefined();
    expect(c.addLayers.noLayerPatches).toBeUndefined();
  });
});
