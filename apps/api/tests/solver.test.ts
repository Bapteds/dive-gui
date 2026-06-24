// Integration tests for solver runs. The solver binary is not installed in CI /
// on a dev box, so the streaming runner is swapped for a fake that writes
// scripted residual lines to the log file and resolves with a chosen exit,
// letting us exercise the whole lifecycle (start, classify converged/completed/
// diverged/failed, stop, boot reconciliation), the concurrency guard, the gates,
// and access — without OpenFOAM.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  authHeader,
  createProtectedAdmin,
  createTestUser,
  resetDatabase,
} from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamRunner,
} from '../src/lib/streamRunner';
import { reconcileOrphanRuns } from '../src/modules/projects/runs.service';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls { type wall; nFaces 20; startFace 110; }
)
`;

type Mode = 'converge' | 'complete' | 'fail' | 'diverge' | 'fatal' | 'spawnError' | 'hang';

/** A fake streaming runner: writes scripted residuals, then resolves per mode. */
function fakeRunner(mode: Mode): StreamRunner {
  return (spec): StreamHandle => {
    let resolveExit!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((resolve) => {
      resolveExit = resolve;
    });

    void (async () => {
      await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
      if (mode === 'spawnError') {
        resolveExit({ exitCode: null, signal: null, spawnError: 'ENOENT: spawn simpleFoam ENOENT' });
        return;
      }
      const lines = [
        'Time = 1',
        'smoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 1e-3, No Iterations 2',
        'GAMG:  Solving for p, Initial residual = 0.2, Final residual = 1e-3, No Iterations 5',
        'Time = 2',
        'smoothSolver:  Solving for Ux, Initial residual = 0.01, Final residual = 1e-4, No Iterations 2',
        mode === 'diverge'
          ? 'GAMG:  Solving for p, Initial residual = nan, Final residual = nan'
          : 'GAMG:  Solving for p, Initial residual = 0.02, Final residual = 1e-4, No Iterations 5',
      ];
      if (mode === 'converge') lines.push('SIMPLE solution converged in 2 iterations');
      if (mode === 'fatal') lines.push('--> FOAM FATAL ERROR: No matching patches: (inlet)');
      lines.push('End');
      await fs.writeFile(spec.logFile, `${lines.join('\n')}\n`);

      if (mode === 'hang') return; // stays active until stop()
      resolveExit({ exitCode: mode === 'fail' || mode === 'fatal' ? 1 : 0, signal: null });
    })();

    return {
      pid: 4242,
      onExit,
      stop: () => resolveExit({ exitCode: null, signal: 'SIGTERM' }),
    };
  };
}

/** Create a project whose case has a mesh AND the simpleFoam files (runnable). */
async function makeRunnableProject(
  email: string,
): Promise<{ userId: string; id: string; auth: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  const auth = authHeader(user);

  for (const name of ['points', 'faces', 'owner', 'neighbour']) {
    await writeCaseFile(project.id, `constant/polyMesh/${name}`, name);
  }
  await writeCaseFile(project.id, 'constant/polyMesh/boundary', BOUNDARY);
  await request(app)
    .post(`/api/v1/projects/${project.id}/runnable/scaffold`)
    .set('Authorization', auth);

  return { userId: user.id, id: project.id, auth };
}

function startRun(id: string, auth: string) {
  return request(app).post(`/api/v1/projects/${id}/runs`).set('Authorization', auth).send({});
}

/** Poll a run until it leaves the active states (or time out). */
async function waitForTerminal(id: string, runId: string, auth: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/api/v1/projects/${id}/runs/${runId}`)
      .set('Authorization', auth);
    const status = res.body.run?.status;
    if (status && status !== 'queued' && status !== 'running') return res.body.run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run did not settle within the timeout');
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setStreamRunner(fakeRunner('converge'));
});

afterEach(() => {
  setStreamRunner(null); // restore the real runner
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('solver run lifecycle', () => {
  it('starts a run (201 running) and settles converged, with a residual series', async () => {
    const { id, auth } = await makeRunnableProject('solver-converge@x.test');

    const start = await startRun(id, auth);
    expect(start.status).toBe(201);
    expect(start.body.run.status).toBe('running');
    expect(start.body.run.solver).toBe('simpleFoam');

    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('converged');
    expect(settled.exitCode).toBe(0);

    const log = await request(app)
      .get(`/api/v1/projects/${id}/runs/${start.body.run.id}/log`)
      .set('Authorization', auth);
    expect(log.status).toBe(200);
    expect(log.body.series.length).toBeGreaterThan(0);
    expect(log.body.series[0].values).toHaveProperty('Ux');
    expect(log.body.logTail).toContain('Solving for');
  });

  it('classifies exit 0 without the banner as completed', async () => {
    setStreamRunner(fakeRunner('complete'));
    const { id, auth } = await makeRunnableProject('solver-complete@x.test');
    const start = await startRun(id, auth);
    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('completed');
  });

  it('classifies a non-zero exit as failed', async () => {
    setStreamRunner(fakeRunner('fail'));
    const { id, auth } = await makeRunnableProject('solver-fail@x.test');
    const start = await startRun(id, auth);
    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('failed');
    expect(settled.exitCode).toBe(1);
  });

  it('classifies nan residuals as diverged even on exit 0', async () => {
    setStreamRunner(fakeRunner('diverge'));
    const { id, auth } = await makeRunnableProject('solver-diverge@x.test');
    const start = await startRun(id, auth);
    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('diverged');
  });

  it('classifies a FOAM fatal error as failed (not diverged)', async () => {
    setStreamRunner(fakeRunner('fatal'));
    const { id, auth } = await makeRunnableProject('solver-fatal@x.test');
    const start = await startRun(id, auth);
    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('failed');
  });

  it('classifies a spawn error (missing binary) as failed', async () => {
    setStreamRunner(fakeRunner('spawnError'));
    const { id, auth } = await makeRunnableProject('solver-enoent@x.test');
    const start = await startRun(id, auth);
    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('failed');
    expect(settled.reason).toMatch(/binary not found/i);
  });

  it('stops a running run (graceful then SIGTERM fallback)', async () => {
    setStreamRunner(fakeRunner('hang'));
    const { id, auth } = await makeRunnableProject('solver-stop@x.test');
    const start = await startRun(id, auth);
    expect(start.body.run.status).toBe('running');

    const stop = await request(app)
      .post(`/api/v1/projects/${id}/runs/${start.body.run.id}/stop`)
      .set('Authorization', auth);
    expect(stop.status).toBe(200);

    const settled = await waitForTerminal(id, start.body.run.id, auth);
    expect(settled.status).toBe('stopped');
  });
});

describe('solver run guards and access', () => {
  it('rejects a second concurrent run with 409 RUN_IN_PROGRESS', async () => {
    setStreamRunner(fakeRunner('hang'));
    const { id, auth } = await makeRunnableProject('solver-concurrent@x.test');
    const first = await startRun(id, auth);
    expect(first.status).toBe(201);

    const second = await startRun(id, auth);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RUN_IN_PROGRESS');
  });

  it('rejects a run on a case with no mesh (409 NO_MESH)', async () => {
    const user = await createTestUser({ email: 'solver-nomesh@x.test' });
    const project = await prisma.project.create({ data: { title: 'Empty', ownerId: user.id } });
    const res = await startRun(project.id, authHeader(user));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_MESH');
  });

  it('rejects a mesh-only case as 422 NOT_RUNNABLE', async () => {
    const user = await createTestUser({ email: 'solver-notrunnable@x.test' });
    const project = await prisma.project.create({ data: { title: 'MeshOnly', ownerId: user.id } });
    for (const name of ['points', 'faces', 'owner', 'neighbour']) {
      await writeCaseFile(project.id, `constant/polyMesh/${name}`, name);
    }
    await writeCaseFile(project.id, 'constant/polyMesh/boundary', BOUNDARY);
    const res = await startRun(project.id, authHeader(user));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_RUNNABLE');
  });

  it('returns 404 for a stranger and allows a super-admin', async () => {
    const { id } = await makeRunnableProject('solver-owner@x.test');

    const stranger = await createTestUser({ email: 'solver-stranger@x.test' });
    const denied = await startRun(id, authHeader(stranger));
    expect(denied.status).toBe(404);

    const admin = await createProtectedAdmin({ email: 'solver-admin@x.test' });
    const allowed = await request(app)
      .get(`/api/v1/projects/${id}/runs`)
      .set('Authorization', authHeader(admin));
    expect(allowed.status).toBe(200);
  });

  it('reconciles an orphaned running run to failed on boot', async () => {
    const { id } = await makeRunnableProject('solver-orphan@x.test');
    // Simulate a run left active by a crashed previous process.
    const orphan = await prisma.run.create({
      data: { projectId: id, solver: 'simpleFoam', status: 'running', command: 'x', logPath: 'x' },
    });

    const fixed = await reconcileOrphanRuns();
    expect(fixed).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.run.findUnique({ where: { id: orphan.id } });
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.reason).toMatch(/restart/i);
  });
});
