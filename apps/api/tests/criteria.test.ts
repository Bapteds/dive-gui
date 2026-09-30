// Integration tests for the per-project convergence criteria + vortex metrics
// endpoints (WS-G): GET defaults, PUT validation and install, re-install at run
// start, non-applicable solvers, and the on-demand vortex post-process with a
// fake command runner (no OpenFOAM).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_CFD_CRITERIA, type CfdCriteriaSettings } from '@dive/shared';
import { app, authHeader, createTestUser, logicalCommand, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { projectDirAbsolute, readCaseFile, writeCaseFile } from '../src/lib/caseStorage';
import { renderSolverFile } from '../src/lib/openfoamCase';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamRunner,
} from '../src/lib/streamRunner';
import { setCommandRunner, type CommandResult, type CommandSpec } from '../src/lib/commandRunner';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
    walls { type wall; nFaces 20; startFace 120; }
)
`;

/** A fake solver that exits 0 right away (the run itself is not under test). */
const quickRunner: StreamRunner = (spec): StreamHandle => {
  const onExit = (async (): Promise<StreamExit> => {
    await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
    await fs.writeFile(spec.logFile, 'Time = 1\nEnd\n');
    return { exitCode: 0, signal: null };
  })();
  return { pid: 4444, onExit, stop: () => undefined };
};

async function makeProject(
  email: string,
  boundary = BOUNDARY,
  solver?: string,
): Promise<{ id: string; auth: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  const auth = authHeader(user);
  for (const name of ['points', 'faces', 'owner', 'neighbour']) {
    await writeCaseFile(project.id, `constant/polyMesh/${name}`, name);
  }
  await writeCaseFile(project.id, 'constant/polyMesh/boundary', boundary);
  await request(app)
    .post(`/api/v1/projects/${project.id}/runnable/scaffold`)
    .set('Authorization', auth)
    .send(solver ? { solver } : {});
  return { id: project.id, auth };
}

function body(overrides: {
  convergence?: Partial<CfdCriteriaSettings['convergence']>;
  vortex?: Partial<CfdCriteriaSettings['vortex']>;
}): CfdCriteriaSettings {
  const base = structuredClone(DEFAULT_CFD_CRITERIA);
  return {
    convergence: { ...base.convergence, ...overrides.convergence },
    vortex: { ...base.vortex, ...overrides.vortex },
  };
}

const text = async (id: string, rel: string) => (await readCaseFile(id, rel))?.toString('utf8') ?? null;

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setStreamRunner(quickRunner);
});

afterEach(() => {
  setStreamRunner(null);
  setCommandRunner(null);
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('GET /projects/:id/criteria', () => {
  it('returns the defaults resolved on the mesh patches', async () => {
    const { id, auth } = await makeProject('crit-get@x.test');
    const res = await request(app).get(`/api/v1/projects/${id}/criteria`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.criteria).toEqual(DEFAULT_CFD_CRITERIA);
    expect(res.body.patches).toEqual(['inlet', 'outlet', 'walls']);
    expect(res.body.applicable).toBe(true);
    expect(res.body.installed).toBe(false);
  });

  it('falls back on the first two patch-type patches', async () => {
    const boundary = BOUNDARY.replace('inlet {', 'in1 {').replace('outlet {', 'out1 {');
    const { id, auth } = await makeProject('crit-get2@x.test', boundary);
    const res = await request(app).get(`/api/v1/projects/${id}/criteria`).set('Authorization', auth);
    expect(res.body.criteria.convergence.inletPatch).toBe('in1');
    expect(res.body.criteria.convergence.outletPatch).toBe('out1');
  });

  it('answers 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('crit-owner@x.test');
    const stranger = await createTestUser({ email: 'crit-stranger@x.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });
});

describe('PUT /projects/:id/criteria', () => {
  it('rejects an unknown patch and inlet = outlet with 422 CRITERIA_INVALID', async () => {
    const { id, auth } = await makeProject('crit-invalid@x.test');
    const unknown = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ convergence: { inletPatch: 'nope' } }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('CRITERIA_INVALID');

    const same = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ convergence: { inletPatch: 'inlet', outletPatch: 'inlet' } }));
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('CRITERIA_INVALID');
  });

  it('rejects an unsafe patch name and out-of-range settings (422 VALIDATION_ERROR)', async () => {
    const { id, auth } = await makeProject('crit-bad@x.test');
    const unsafe = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ convergence: { inletPatch: 'in"; system("rm' } }));
    expect(unsafe.status).toBe(422);
    expect(unsafe.body.error.code).toBe('VALIDATION_ERROR');

    const range = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ convergence: { simplePDrop: { window: 1, devTol: 0.03, nPass: 100 } } }));
    expect(range.status).toBe(422);
    expect(range.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a change while a run is active (409 RUN_IN_PROGRESS)', async () => {
    const { id, auth } = await makeProject('crit-busy@x.test');
    await prisma.run.create({
      data: { projectId: id, solver: 'simpleFoam', status: 'running', command: '', logPath: '' },
    });
    const res = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({}));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_IN_PROGRESS');
  });

  it('writes the settings and the function objects, and sets the includes', async () => {
    const { id, auth } = await makeProject('crit-put@x.test');
    const originalFvSolution = await text(id, 'system/fvSolution');

    const robust = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ convergence: { method: 'robust', robust: { W: 120, tolMean: 80, K: 3, resTol: 2e-3 } } }));
    expect(robust.status).toBe(200);
    expect(robust.body.installed).toBe(true);
    expect(robust.body.criteria.convergence.method).toBe('robust');

    const saved = JSON.parse(
      await fs.readFile(path.join(projectDirAbsolute(id), 'cfd-criteria.json'), 'utf8'),
    );
    expect(saved.convergence.robust.W).toBe(120);

    expect(await text(id, 'system/pressureLossMonitors')).toContain('name  inlet;');
    expect(await text(id, 'system/convergenceControl')).toContain('tolMean = 80.0;');
    expect(await text(id, 'system/diveVortexMetrics')).toContain('diveVortexMetrics');
    const controlDict = (await text(id, 'system/controlDict')) ?? '';
    expect(controlDict).toContain('#include "pressureLossMonitors"');
    expect(controlDict).toContain('#include "convergenceControl"');
    expect(controlDict).toContain('#include "diveVortexMetrics"');
    expect(controlDict).not.toContain('#include "SimplePDropConvergence"');
    expect(await text(id, 'system/fvSolution')).toContain('DIVE convergence: residualControl disabled');

    const get = await request(app).get(`/api/v1/projects/${id}/criteria`).set('Authorization', auth);
    expect(get.body.installed).toBe(true);
    expect(get.body.criteria.convergence.robust.K).toBe(3);

    // Back to the simple criterion: includes switch, residualControl restored verbatim.
    const simple = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({ vortex: { enabled: false } }));
    expect(simple.status).toBe(200);
    const controlDict2 = (await text(id, 'system/controlDict')) ?? '';
    expect(controlDict2).toContain('#include "SimplePDropConvergence"');
    expect(controlDict2).not.toContain('#include "convergenceControl"');
    expect(controlDict2).not.toContain('#include "diveVortexMetrics"');
    expect(await text(id, 'system/fvSolution')).toBe(originalFvSolution);

    // The case stays runnable with the includes in place.
    const runnable = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(runnable.body.runnable.runnable).toBe(true);
  });

  it('stores but does not install for a non-applicable (transient) solver', async () => {
    const { id, auth } = await makeProject('crit-pimple@x.test', BOUNDARY, 'pimpleFoam');
    const get = await request(app).get(`/api/v1/projects/${id}/criteria`).set('Authorization', auth);
    expect(get.body.applicable).toBe(false);

    const put = await request(app)
      .put(`/api/v1/projects/${id}/criteria`)
      .set('Authorization', auth)
      .send(body({}));
    expect(put.status).toBe(200);
    expect(put.body.installed).toBe(false);
    expect(await text(id, 'system/controlDict')).not.toContain('#include "pressureLossMonitors"');
  });
});

describe('install at run start', () => {
  it('re-installs the includes after a scaffold rewrote the controlDict', async () => {
    const { id, auth } = await makeProject('crit-run@x.test');
    await request(app).put(`/api/v1/projects/${id}/criteria`).set('Authorization', auth).send(body({}));
    // A solver change / scaffold re-renders the controlDict without the includes.
    await writeCaseFile(id, 'system/controlDict', renderSolverFile('simpleFoam', 'system/controlDict', []));
    expect(await text(id, 'system/controlDict')).not.toContain('#include');

    const start = await request(app).post(`/api/v1/projects/${id}/runs`).set('Authorization', auth).send({});
    expect(start.status).toBe(201);
    const controlDict = (await text(id, 'system/controlDict')) ?? '';
    expect(controlDict).toContain('#include "pressureLossMonitors"');
    expect(controlDict).toContain('#include "SimplePDropConvergence"');
  });

  it('installs the defaults when nothing was saved', async () => {
    const { id, auth } = await makeProject('crit-run-default@x.test');
    const start = await request(app).post(`/api/v1/projects/${id}/runs`).set('Authorization', auth).send({});
    expect(start.status).toBe(201);
    expect(await text(id, 'system/controlDict')).toContain('#include "SimplePDropConvergence"');
  });

  it('fails the start with 422 CRITERIA_INVALID when a saved patch disappeared', async () => {
    const { id, auth } = await makeProject('crit-run-bad@x.test');
    await request(app).put(`/api/v1/projects/${id}/criteria`).set('Authorization', auth).send(body({}));
    await writeCaseFile(id, 'constant/polyMesh/boundary', BOUNDARY.replace('outlet {', 'exit {'));
    const start = await request(app).post(`/api/v1/projects/${id}/runs`).set('Authorization', auth).send({});
    expect(start.status).toBe(422);
    expect(start.body.error.code).toBe('CRITERIA_INVALID');
    expect(await prisma.run.count({ where: { projectId: id } })).toBe(0);
  });
});

describe('POST /projects/:id/criteria/vortex', () => {
  const ok = (stdout: string): CommandResult => ({
    command: 'postProcess',
    args: [],
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 5,
    timedOut: false,
  });

  it('answers 409 NO_RESULTS without a time directory > 0', async () => {
    const { id, auth } = await makeProject('crit-vortex-none@x.test');
    const res = await request(app).post(`/api/v1/projects/${id}/criteria/vortex`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_RESULTS');
  });

  it('runs postProcess at the latest time and returns the parsed metrics', async () => {
    const { id, auth } = await makeProject('crit-vortex-ok@x.test');
    await writeCaseFile(id, '500/U', 'U');
    const calls: CommandSpec[] = [];
    setCommandRunner(async (spec) => {
      calls.push(spec);
      return ok(
        'Time = 500\ndiveVortexMetrics: time=500 qVolume=0.3 maskedQVolume=0.2 omegaRms=15.25 coreVolume=0.25 coreCells=77\nEnd\n',
      );
    });
    const res = await request(app).post(`/api/v1/projects/${id}/criteria/vortex`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.vortex).toEqual({
      time: 500,
      qVolume: 0.3,
      maskedQVolume: 0.2,
      omegaRms: 15.25,
      coreVolume: 0.25,
      coreCells: 77,
    });
    expect(calls).toHaveLength(1);
    const cmd = logicalCommand(calls[0]);
    expect(cmd.command).toBe('postProcess');
    expect(cmd.args).toContain('-latestTime');
    expect(cmd.args).toContain('diveVortexMetrics');
    expect(await text(id, 'system/diveVortexMetrics')).toContain('diveVortexMetrics');
  });

  it('answers 502 POSTPROCESS_FAILED when the tool fails', async () => {
    const { id, auth } = await makeProject('crit-vortex-fail@x.test');
    await writeCaseFile(id, '500/U', 'U');
    setCommandRunner(async () => ({
      ...ok(''),
      exitCode: 1,
      stderr: '--> FOAM FATAL ERROR: cannot find U\n',
    }));
    const res = await request(app).post(`/api/v1/projects/${id}/criteria/vortex`).set('Authorization', auth);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('POSTPROCESS_FAILED');
    expect(res.body.error.message).toMatch(/FOAM FATAL ERROR/);
  });

  it('refuses while a run is active (409 RUN_IN_PROGRESS)', async () => {
    const { id, auth } = await makeProject('crit-vortex-busy@x.test');
    await writeCaseFile(id, '500/U', 'U');
    await prisma.run.create({
      data: { projectId: id, solver: 'simpleFoam', status: 'running', command: '', logPath: '' },
    });
    const res = await request(app).post(`/api/v1/projects/${id}/criteria/vortex`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_IN_PROGRESS');
  });
});
