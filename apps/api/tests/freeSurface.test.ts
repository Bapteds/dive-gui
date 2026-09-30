// Integration tests for the Free surface (lid iteration) tool, WS-I spec §10.
// No OpenFOAM, mesher or Python runs: the command runner fake writes what
// postProcess (lidSurfaces export) and the kit scripts (lidkit_surface.py,
// lidkit_fitlid.py, lidkit_post.py) would, and the stream runner fake plays the
// mesher (cartesianMesh writes constant/polyMesh) and the solver (solver.log +
// a time directory). The case mesh is a one-cell cube in ASCII polyMesh format,
// so the flat-patch detection reads real points / faces files.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, logicalCommand, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { readCaseFile, writeCaseFile } from '../src/lib/caseStorage';
import { setCommandRunner, type CommandResult, type CommandSpec } from '../src/lib/commandRunner';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamSpec,
} from '../src/lib/streamRunner';
import {
  createSession,
  sessionPolyMeshDir,
  writeConfig,
  writeStl,
} from '../src/lib/meshingStorage';
import { storageRoot } from '../src/lib/fileTreeStorage';
import { setFieldPatchType } from '../src/lib/openfoamCase';
import { reconcileOrphanFreeSurfaceJobs } from '../src/modules/projects/freeSurface.service';
import type { MeshingConfig } from '@dive/shared';

// --- A one-cell cube mesh (ASCII polyMesh) ------------------------------------

const POINTS = `FoamFile { version 2.0; format ascii; class vectorField; object points; }
// comment 1 2 3
8
(
(0 0 0)
(1 0 0)
(1 1 0)
(0 1 0)
(0 0 1)
(1 0 1)
(1 1 1)
(0 1 1)
)
`;

const FACES = `FoamFile { version 2.0; format ascii; class faceList; object faces; }
6
(
4(0 4 7 3)
4(1 2 6 5)
4(0 3 2 1)
4(0 1 5 4)
4(3 7 6 2)
4(4 5 6 7)
)
`;

const OWNER = `FoamFile { version 2.0; format ascii; class labelList; object owner; }
6
(
0
0
0
0
0
0
)
`;

const NEIGHBOUR = `FoamFile { version 2.0; format ascii; class labelList; object neighbour; }
0
(
)
`;

/** With a flat `atmosphere` top patch (default) or with the top inside `walls`. */
function boundary(withAtmosphere = true): string {
  const patches = withAtmosphere
    ? [
        'inlet { type patch; nFaces 1; startFace 0; }',
        'outlet { type patch; nFaces 1; startFace 1; }',
        'walls { type wall; nFaces 3; startFace 2; }',
        'atmosphere { type patch; nFaces 1; startFace 5; }',
      ]
    : [
        'inlet { type patch; nFaces 1; startFace 0; }',
        'outlet { type patch; nFaces 1; startFace 1; }',
        'walls { type wall; nFaces 4; startFace 2; }',
      ];
  return `FoamFile { version 2.0; format ascii; class polyBoundaryMesh; object boundary; }\n${patches.length}\n(\n${patches.map((p) => `    ${p}`).join('\n')}\n)\n`;
}

function polyMeshFiles(withAtmosphere = true): Record<string, string> {
  return {
    points: POINTS,
    faces: FACES,
    owner: OWNER,
    neighbour: NEIGHBOUR,
    boundary: boundary(withAtmosphere),
  };
}

async function writePolyMesh(dir: string, withAtmosphere = true): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(polyMeshFiles(withAtmosphere))) {
    await fs.writeFile(path.join(dir, name), content);
  }
}

// --- Session surfaces (flat lid at z = 1) --------------------------------------

function solid(name: string, z: number): string {
  return [
    `solid ${name}`,
    '  facet normal 0 0 1',
    '    outer loop',
    `      vertex 0 0 ${z}`,
    `      vertex 1 0 ${z}`,
    `      vertex 1 1 ${z}`,
    '    endloop',
    '  endfacet',
    '  facet normal 0 0 1',
    '    outer loop',
    `      vertex 0 0 ${z}`,
    `      vertex 1 1 ${z}`,
    `      vertex 0 1 ${z}`,
    '    endloop',
    '  endfacet',
    `endsolid ${name}`,
    '',
  ].join('\n');
}

const CFMESH_CONFIG = {
  engine: 'cfmesh',
  maxCellSize: 0.2,
  extractFeatures: true,
  featureAngle: 45,
  addLayers: { enabled: false, nLayers: 3 },
  cores: 1,
} as unknown as MeshingConfig;

/** A meshed cfMesh session whose surfaces are atmosphere / inlet / walls. */
async function makeSourceSession(name = 'Chamber mesh'): Promise<string> {
  const meta = await createSession(name, 'cfmesh');
  await writeStl(meta.id, 'atmosphere.stl', Buffer.from(solid('atmosphere', 1)));
  await writeStl(meta.id, 'inlet.stl', Buffer.from(solid('inlet', 0.5)));
  await writeStl(meta.id, 'walls.stl', Buffer.from(solid('walls', 0)));
  await writeConfig(meta.id, CFMESH_CONFIG);
  await writePolyMesh(sessionPolyMeshDir(meta.id));
  return meta.id;
}

// --- Project fixture -------------------------------------------------------------

interface Fixture {
  id: string;
  auth: string;
  sessionId: string;
}

async function makeProject(
  opts: { atmosphere?: boolean; slip?: boolean; parentRun?: boolean; email?: string } = {},
): Promise<Fixture> {
  const { atmosphere = true, slip = true, parentRun = true } = opts;
  const user = await createTestUser({ email: opts.email ?? 'fs@dive-turbinen.test' });
  const project = await prisma.project.create({ data: { title: 'Lid', ownerId: user.id } });
  const auth = authHeader(user);
  for (const [name, content] of Object.entries(polyMeshFiles(atmosphere))) {
    await writeCaseFile(project.id, `constant/polyMesh/${name}`, content);
  }
  await request(app)
    .post(`/api/v1/projects/${project.id}/runnable/scaffold`)
    .set('Authorization', auth)
    .expect(201);
  if (slip && atmosphere) {
    const u = (await readCaseFile(project.id, '0/U'))!.toString('utf8');
    await writeCaseFile(project.id, '0/U', setFieldPatchType(u, 'atmosphere', 'slip'));
  }
  if (parentRun) {
    await prisma.run.create({
      data: {
        projectId: project.id,
        solver: 'simpleFoam',
        status: 'converged',
        cores: 1,
        command: '',
        logPath: '',
      },
    });
    await writeCaseFile(project.id, '100/U', 'parent result');
  }
  const sessionId = await makeSourceSession();
  return { id: project.id, auth, sessionId };
}

// --- Fakes ---------------------------------------------------------------------------

function ok(spec: CommandSpec, stdout = 'OK'): CommandResult {
  return {
    command: spec.command,
    args: spec.args,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
  };
}

function caseOf(args: string[], fallback: string): string {
  const i = args.indexOf('-case');
  return i >= 0 ? args[i + 1] : fallback;
}

/** Latest numeric time directory of a case (0 when none). */
async function latestTime(caseDir: string): Promise<string> {
  const names = await fs.readdir(caseDir).catch(() => [] as string[]);
  const times = names.filter((n) => /^\d+(\.\d+)?$/.test(n)).sort((a, b) => Number(a) - Number(b));
  return times[times.length - 1] ?? '0';
}

interface KitFakeOptions {
  /** Lid residual RMS (mm) returned by each successive surface estimate. */
  rms: number[];
  matplotlib?: boolean;
  commands?: string[];
}

function kitRunner(opts: KitFakeOptions): (spec: CommandSpec) => Promise<CommandResult> {
  let surfaceCall = 0;
  return async (spec) => {
    const { command, args } = logicalCommand(spec);
    const script = args.find((a) => a.endsWith('.py')) ?? '';
    opts.commands?.push(script ? path.basename(script) : command);
    if (command === 'postProcess') {
      const caseDir = caseOf(args, spec.cwd ?? '');
      const dir = path.join(caseDir, 'postProcessing', 'lidSurfaces', await latestTime(caseDir));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'lid.vtk'), '# vtk DataFile Version 2.0\nlid\n');
      await fs.writeFile(path.join(dir, 'inlet.vtk'), '# vtk DataFile Version 2.0\ninlet\n');
      return ok(spec);
    }
    if (args[0] === '-c' && /matplotlib/.test(args[1] ?? '')) {
      return opts.matplotlib === false
        ? { ...ok(spec), exitCode: 1, stderr: 'ModuleNotFoundError' }
        : ok(spec);
    }
    if (script.endsWith('lidkit_surface.py')) {
      const out = args[2];
      const rms = opts.rms[Math.min(surfaceCall, opts.rms.length - 1)];
      surfaceCall += 1;
      await fs.writeFile(out, 'NPY');
      await fs.writeFile(
        out.replace(/\.npy$/, '.json'),
        JSON.stringify({
          z_lid: 1,
          p0_ref_m2s2: 3,
          n_lid_faces: 1,
          lid_area_m2: 1,
          zs_vs_Z_LID_mm: { mean: -20, min: -35, max: -2, min_xy: [0.5, 0.5] },
          lid_residual_mm: { rms, max_abs: rms * 2, mean: -rms },
        }),
      );
      return ok(spec);
    }
    if (script.endsWith('lidkit_fitlid.py')) {
      const base = args[1];
      const out = args[2];
      await fs.writeFile(out, await fs.readFile(base));
      const rep = args[args.indexOf('--report') + 1];
      await fs.writeFile(
        rep,
        JSON.stringify({
          lid: { faces: 12 },
          lid_z_vs_Z_LID_mm: { min: -35, max: -2, mean: -20 },
          clamped_lid_points: 3,
          upstand_facets: 4,
          cut: { components: 0, facets_cut: 0 },
          audit_all: { open_edges: 0, non_manifold_edges: 0 },
          audit_base_all: { open_edges: 0, non_manifold_edges: 0 },
        }),
      );
      const fi = args.indexOf('--figure');
      if (fi >= 0) await fs.writeFile(args[fi + 1], 'PNG');
      return ok(spec);
    }
    if (script.endsWith('lidkit_post.py')) {
      await fs.writeFile(args[4], 'PNG');
      return ok(spec);
    }
    return ok(spec);
  };
}

interface StreamFakeOptions {
  meshFails?: boolean;
  solverHangs?: boolean;
}

function streamRunner(opts: StreamFakeOptions = {}): (spec: StreamSpec) => StreamHandle {
  return (spec) => {
    const { command, args } = logicalCommand(spec);
    let resolveExit!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((r) => {
      resolveExit = r;
    });
    void (async () => {
      await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
      if (command === 'cartesianMesh' || command === 'snappyHexMesh') {
        if (opts.meshFails) {
          await fs.appendFile(spec.logFile, 'FOAM FATAL ERROR: bad surface\n');
          resolveExit({ exitCode: 1, signal: null });
          return;
        }
        await writePolyMesh(path.join(caseOf(args, spec.cwd), 'constant', 'polyMesh'));
        await fs.appendFile(spec.logFile, '[cartesianMesh] ran\n');
        resolveExit({ exitCode: 0, signal: null });
        return;
      }
      if (command === 'checkMesh') {
        await fs.appendFile(spec.logFile, 'Mesh stats\n    cells:            1\nMesh OK.\n');
        resolveExit({ exitCode: 0, signal: null });
        return;
      }
      if (command === 'simpleFoam') {
        const caseDir = caseOf(args, spec.cwd);
        await fs.writeFile(
          spec.logFile,
          'Time = 1\nGAMG:  Solving for p, Initial residual = 0.2, Final residual = 1e-3, No Iterations 5\n',
        );
        if (opts.solverHangs) return;
        await fs.appendFile(spec.logFile, 'SIMPLE solution converged in 200 iterations\nEnd\n');
        await fs.mkdir(path.join(caseDir, '200'), { recursive: true });
        await fs.writeFile(path.join(caseDir, '200', 'U'), 'iteration result');
        resolveExit({ exitCode: 0, signal: null });
        return;
      }
      await fs.appendFile(spec.logFile, `[${command}] ran\n`);
      resolveExit({ exitCode: 0, signal: null });
    })();
    return { pid: 5150, onExit, stop: () => resolveExit({ exitCode: null, signal: 'SIGTERM' }) };
  };
}

// --- Helpers ------------------------------------------------------------------------

function overview(f: Fixture, query = '') {
  return request(app)
    .get(`/api/v1/projects/${f.id}/free-surface${query}`)
    .set('Authorization', f.auth);
}

function start(f: Fixture, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/projects/${f.id}/free-surface`)
    .set('Authorization', f.auth)
    .send({ lidPatch: 'atmosphere', inletPatch: 'inlet', sourceSessionId: f.sessionId, ...body });
}

async function waitForJob(
  f: Fixture,
  jobId: string,
  done: (job: Record<string, unknown>) => boolean,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app)
      .get(`/api/v1/projects/${f.id}/free-surface/${jobId}`)
      .set('Authorization', f.auth);
    expect(res.status).toBe(200);
    if (done(res.body.job)) return res.body.job;
    if (Date.now() > deadline)
      throw new Error(`job stuck at ${res.body.job.status}/${res.body.job.stage}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const terminal = (job: Record<string, unknown>) => job.status !== 'running';

function check(
  body: { checks: { items: { id: string; status: string; message: string }[] } },
  id: string,
) {
  return body.checks.items.find((c) => c.id === id);
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm(path.join(storageRoot(), 'projects'), { recursive: true, force: true });
  await fs.rm(path.join(storageRoot(), 'meshing'), { recursive: true, force: true });
});
afterEach(() => {
  setCommandRunner(null);
  setStreamRunner(null);
});

// --- Tests ---------------------------------------------------------------------------

describe('Free surface readiness', () => {
  it('lists the flat patches, measures Z_lid and is ready on a complete project', async () => {
    const f = await makeProject();
    const res = await overview(f, `?sessionId=${f.sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.checks.ready).toBe(true);
    expect(res.body.checks.lidPatch).toBe('atmosphere');
    expect(res.body.checks.inletPatch).toBe('inlet');
    expect(res.body.checks.zLid).toBeCloseTo(1, 6);
    const flat = (res.body.checks.patches as { name: string; flat: boolean; z: number }[]).filter(
      (p) => p.flat,
    );
    expect(flat.map((p) => p.name)).toEqual(['atmosphere']);
    expect(res.body.defaults).toMatchObject({ iterations: 1, tolRmsMm: 3 });
    expect(res.body.jobs).toEqual([]);
  });

  it('blocks when the mesh has no flat top patch', async () => {
    const f = await makeProject({ atmosphere: false });
    const res = await overview(f, `?sessionId=${f.sessionId}`);
    expect(res.body.checks.ready).toBe(false);
    const lid = check(res.body, 'lidPatch');
    expect(lid?.status).toBe('blocking');
    expect(lid?.message).toMatch(/no flat top patch/);
  });

  it('warns (without blocking) when the lid is not slip', async () => {
    const f = await makeProject({ slip: false });
    const res = await overview(f, `?sessionId=${f.sessionId}`);
    const bc = check(res.body, 'lidBc');
    expect(bc?.status).toBe('warning');
    expect(bc?.message).toMatch(/not slip/);
    expect(res.body.checks.ready).toBe(true);
  });

  it('blocks without a converged parent run', async () => {
    const f = await makeProject({ parentRun: false });
    const res = await overview(f, `?sessionId=${f.sessionId}`);
    const parent = check(res.body, 'parentRun');
    expect(parent?.status).toBe('blocking');
    expect(parent?.message).toBe('Run the solver to convergence first.');
  });

  it('asks for the source session when the mesh has no recorded origin', async () => {
    const f = await makeProject();
    const res = await overview(f);
    const source = check(res.body, 'sourceSession');
    expect(source?.status).toBe('blocking');
    expect(source?.message).toBe('Pick the meshing session that produced this mesh.');
    expect((res.body.checks.sessions as { id: string }[]).map((s) => s.id)).toContain(f.sessionId);
  });

  it('answers 404 for a stranger', async () => {
    const f = await makeProject();
    const stranger = await createTestUser({ email: 'nobody@dive-turbinen.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${f.id}/free-surface`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });

  it('refuses to start (422) when a check blocks', async () => {
    const f = await makeProject({ parentRun: false });
    const res = await start(f);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FREE_SURFACE_NOT_READY');
    expect(res.body.error.message).toBe('Run the solver to convergence first.');
  });
});

describe('Free surface job', () => {
  it('runs one full iteration (202, then completed with the residual reported)', async () => {
    const f = await makeProject();
    const commands: string[] = [];
    setCommandRunner(kitRunner({ rms: [30, 5], commands }));
    setStreamRunner(streamRunner());

    const res = await start(f);
    expect(res.status).toBe(202);
    expect(res.body.job.status).toBe('running');
    const job = await waitForJob(f, res.body.job.id, terminal);

    expect(job.status).toBe('completed');
    expect(job.reason).toMatch(/5\.0 mm/);
    const surfaces = job.surfaces as { index: number; residualRmsMm: number }[];
    expect(surfaces.map((s) => s.residualRmsMm)).toEqual([30, 5]);
    const iterations = job.iterations as {
      index: number;
      sessionId: string;
      sessionName: string;
      runId: string;
      fit: { clampedLidPoints: number; upstandFacets: number };
      meshCells: number;
      files: string[];
    }[];
    expect(iterations).toHaveLength(1);
    expect(iterations[0].sessionName).toBe('Chamber mesh-lid1');
    expect(iterations[0].fit).toMatchObject({ clampedLidPoints: 3, upstandFacets: 4 });
    expect(iterations[0].meshCells).toBe(1);
    expect(iterations[0].files).toEqual(
      expect.arrayContaining(['domain_lidIter1.stl', 'domain_lidIter1.png', 'lid_iter1.png']),
    );
    expect(commands.filter((c) => c === 'postProcess')).toHaveLength(2);
    expect(commands.filter((c) => c === 'lidkit_fitlid.py')).toHaveLength(1);

    // The case mesh now comes from the lid session; the solve used the new mesh.
    const origin = await request(app)
      .get(`/api/v1/projects/${f.id}/mesh-origin`)
      .set('Authorization', f.auth);
    expect(origin.body.origin.sessionId).toBe(iterations[0].sessionId);
    const run = await prisma.run.findUnique({ where: { id: iterations[0].runId } });
    expect(run?.status).toBe('converged');
    // The stale parent time directory was cleared before the solve.
    expect(await readCaseFile(f.id, '100/U')).toBeNull();

    // The session's surfaces were replaced by the fitted solids, by name.
    const lidStl = await fs.readFile(
      path.join(
        storageRoot(),
        'meshing',
        iterations[0].sessionId,
        'constant',
        'triSurface',
        'atmosphere.stl',
      ),
      'utf8',
    );
    expect(lidStl).toMatch(/solid atmosphere/);
    expect(lidStl).not.toMatch(/solid walls/);

    // Listed in the overview, newest first.
    const list = await overview(f);
    expect((list.body.jobs as { id: string }[])[0].id).toBe(res.body.job.id);
  });

  it('stops early when the residual meets the tolerance (2 iterations requested)', async () => {
    const f = await makeProject();
    setCommandRunner(kitRunner({ rms: [30, 2] }));
    setStreamRunner(streamRunner());
    const res = await start(f, { iterations: 2 });
    expect(res.status).toBe(202);
    const job = await waitForJob(f, res.body.job.id, terminal);
    expect(job.status).toBe('converged');
    expect(job.iterations).toHaveLength(1);
    expect((job.surfaces as unknown[]).length).toBe(2);
  });

  it('skips the figures with a note when matplotlib is missing', async () => {
    const f = await makeProject();
    const commands: string[] = [];
    setCommandRunner(kitRunner({ rms: [30, 5], matplotlib: false, commands }));
    setStreamRunner(streamRunner());
    const res = await start(f);
    const job = await waitForJob(f, res.body.job.id, terminal);
    expect(job.status).toBe('completed');
    expect((job.notes as string[]).join(' ')).toMatch(/matplotlib/);
    expect(commands).not.toContain('lidkit_post.py');
    expect((job.iterations as { files: string[] }[])[0].files).toEqual(['domain_lidIter1.stl']);
  });

  it('fails at the meshing stage when the session run fails', async () => {
    const f = await makeProject();
    setCommandRunner(kitRunner({ rms: [30, 5] }));
    setStreamRunner(streamRunner({ meshFails: true }));
    const res = await start(f);
    const job = await waitForJob(f, res.body.job.id, terminal);
    expect(job.status).toBe('failed');
    expect(job.failedStage).toBe('meshing');
    expect(job.reason).toMatch(/Chamber mesh-lid1/);
  });

  it('locks the project while running, then stops during solving', async () => {
    const f = await makeProject();
    setCommandRunner(kitRunner({ rms: [30, 5] }));
    setStreamRunner(streamRunner({ solverHangs: true }));
    const res = await start(f);
    expect(res.status).toBe(202);
    const jobId = res.body.job.id as string;
    await waitForJob(
      f,
      jobId,
      (job) =>
        job.stage === 'solving' && !!(job.iterations as { runId: string | null }[])[0]?.runId,
    );

    // Lock: manual run, second job, case reset, BC apply, mesh import (case).
    const run = await request(app)
      .post(`/api/v1/projects/${f.id}/runs`)
      .set('Authorization', f.auth)
      .send({});
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('FREE_SURFACE_IN_PROGRESS');
    const again = await start(f);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('FREE_SURFACE_IN_PROGRESS');
    const reset = await request(app)
      .delete(`/api/v1/projects/${f.id}/files`)
      .set('Authorization', f.auth);
    expect(reset.status).toBe(409);
    const send = await request(app)
      .post(`/api/v1/projects/${f.id}/mesh/from-meshing`)
      .set('Authorization', f.auth)
      .send({ sessionId: f.sessionId, target: 'case' });
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe('FREE_SURFACE_IN_PROGRESS');
    const del = await request(app)
      .delete(`/api/v1/projects/${f.id}/free-surface/${jobId}`)
      .set('Authorization', f.auth);
    expect(del.status).toBe(409);

    const stop = await request(app)
      .post(`/api/v1/projects/${f.id}/free-surface/${jobId}/stop`)
      .set('Authorization', f.auth);
    expect(stop.status).toBe(200);
    const job = await waitForJob(f, jobId, terminal);
    expect(job.status).toBe('stopped');
    // Idempotent.
    const stopAgain = await request(app)
      .post(`/api/v1/projects/${f.id}/free-surface/${jobId}/stop`)
      .set('Authorization', f.auth);
    expect(stopAgain.status).toBe(200);
    expect(stopAgain.body.job.status).toBe('stopped');

    // Unlocked once terminal: the job can be deleted.
    await request(app)
      .delete(`/api/v1/projects/${f.id}/free-surface/${jobId}`)
      .set('Authorization', f.auth)
      .expect(204);
    await request(app)
      .get(`/api/v1/projects/${f.id}/free-surface/${jobId}`)
      .set('Authorization', f.auth)
      .expect(404);
  });

  it('serves only allow-listed files', async () => {
    const f = await makeProject();
    setCommandRunner(kitRunner({ rms: [30, 5] }));
    setStreamRunner(streamRunner());
    const res = await start(f);
    const jobId = res.body.job.id as string;
    await waitForJob(f, jobId, terminal);
    const base = `/api/v1/projects/${f.id}/free-surface/${jobId}/files`;

    const stl = await request(app).get(`${base}/domain_lidIter1.stl`).set('Authorization', f.auth);
    expect(stl.status).toBe(200);
    expect(stl.headers['content-disposition']).toMatch(
      /attachment; filename="domain_lidIter1\.stl"/,
    );
    expect(stl.text ?? stl.body.toString()).toMatch(/solid atmosphere/);

    for (const name of ['job.json', 'base.stl', '..%2Fjob.json', 'domain_lidIter9.stl']) {
      const r = await request(app).get(`${base}/${name}`).set('Authorization', f.auth);
      expect(r.status).toBe(404);
    }
  });

  it('marks a job left running by a dead process as interrupted on boot', async () => {
    const f = await makeProject();
    const dir = path.join(storageRoot(), 'projects', f.id, 'freesurface', 'fs-orphan');
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(dir, 'job.json'),
      JSON.stringify({
        id: 'fs-orphan',
        status: 'running',
        stage: 'solving',
        iteration: 1,
        settings: {
          lidPatch: 'atmosphere',
          inletPatch: 'inlet',
          sourceSessionId: f.sessionId,
          iterations: 1,
        },
        zLid: 1,
        parentRunId: null,
        cores: 1,
        surfaces: [],
        iterations: [],
        notes: [],
        reason: null,
        failedStage: null,
        stopRequested: false,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }),
    );
    const count = await reconcileOrphanFreeSurfaceJobs();
    expect(count).toBeGreaterThanOrEqual(1);
    const res = await request(app)
      .get(`/api/v1/projects/${f.id}/free-surface/fs-orphan`)
      .set('Authorization', f.auth);
    expect(res.body.job.status).toBe('interrupted');
    expect(res.body.job.reason).toBe('Interrupted by a server restart');
  });
});
