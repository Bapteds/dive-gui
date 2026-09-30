// Run classification with the pressure-drop convergence banners, and the
// `monitors` block of the run log payload (WS-G). The solver is faked with a
// streaming runner that writes a scripted log, like solver.test.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamRunner,
} from '../src/lib/streamRunner';
import { classifyExit } from '../src/modules/projects/runs.service';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
    walls { type wall; nFaces 20; startFace 120; }
)
`;

const OK: StreamExit = { exitCode: 0, signal: null };

describe('classifyExit with the pressure-drop banners', () => {
  it('reports converged with the method when a DIVE function object stopped the run', () => {
    expect(classifyExit(OK, false, 'Time = 400\nSimplePDropConvergence: CONVERGED. Writing and stopping.\nEnd\n')).toEqual({
      status: 'converged',
      reason: 'Pressure drop converged (simplePDrop).',
    });
    expect(
      classifyExit(OK, false, 'convergenceControl: CONVERGED (Dp0 stationary + residuals) @ iteration 400\nEnd\n'),
    ).toEqual({ status: 'converged', reason: 'Pressure drop converged (robust).' });
  });

  it('keeps the residual banner text (null reason) and the other outcomes', () => {
    expect(classifyExit(OK, false, 'SIMPLE solution converged in 12 iterations\n')).toEqual({
      status: 'converged',
      reason: null,
    });
    expect(classifyExit(OK, false, 'Time = 1000\nEnd\n').status).toBe('completed');
    // A banner does not hide a non-zero exit.
    expect(
      classifyExit({ exitCode: 1, signal: null }, false, 'SimplePDropConvergence: CONVERGED.\n').status,
    ).toBe('failed');
    // Stop requested wins.
    expect(classifyExit(OK, true, 'SimplePDropConvergence: CONVERGED.\n').status).toBe('stopped');
  });
});

/** A fake solver writing residuals + the monitor lines, then exiting 0. */
function monitorRunner(): StreamRunner {
  return (spec): StreamHandle => {
    let resolveExit!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((resolve) => {
      resolveExit = resolve;
    });
    void (async () => {
      await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
      const lines: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        lines.push(`Time = ${i}`);
        lines.push(`GAMG:  Solving for p, Initial residual = ${0.1 / i}, Final residual = 1e-4, No Iterations 5`);
        lines.push('surfaceFieldValue inlet_p0_flux write:');
        lines.push(`    weightedAverage(inlet) of pTotal = ${21000 - i * 100}`);
        lines.push('surfaceFieldValue outlet_p0_flux write:');
        lines.push('    weightedAverage(outlet) of pTotal = 1000');
        lines.push(`SimplePDropConvergence: filling window ${i}/100, dp0 = ${20000 - i * 100} Pa`);
      }
      lines.push(
        'diveVortexMetrics: time=3 qVolume=0.2 maskedQVolume=0.1 omegaRms=12.5 coreVolume=0.15 coreCells=42',
      );
      lines.push('SimplePDropConvergence: CONVERGED. Writing and stopping.');
      lines.push('End');
      await fs.writeFile(spec.logFile, `${lines.join('\n')}\n`);
      resolveExit(OK);
    })();
    return { pid: 4343, onExit, stop: () => resolveExit({ exitCode: null, signal: 'SIGTERM' }) };
  };
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setStreamRunner(monitorRunner());
});

afterEach(() => {
  setStreamRunner(null);
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('run log payload monitors', () => {
  it('carries the pressure drop, the criterion progress and the vortex metrics', async () => {
    const user = await createTestUser({ email: 'runs-monitors@x.test' });
    const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
    const auth = authHeader(user);
    for (const name of ['points', 'faces', 'owner', 'neighbour']) {
      await writeCaseFile(project.id, `constant/polyMesh/${name}`, name);
    }
    await writeCaseFile(project.id, 'constant/polyMesh/boundary', BOUNDARY);
    await request(app).post(`/api/v1/projects/${project.id}/runnable/scaffold`).set('Authorization', auth);

    const start = await request(app)
      .post(`/api/v1/projects/${project.id}/runs`)
      .set('Authorization', auth)
      .send({});
    expect(start.status).toBe(201);
    const runId = start.body.run.id as string;

    let body: { run: { status: string; reason: string | null }; monitors: unknown } | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/runs/${runId}/log`)
        .set('Authorization', auth);
      body = res.body;
      if (body && body.run.status !== 'running' && body.run.status !== 'queued') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body?.run.status).toBe('converged');
    expect(body?.run.reason).toBe('Pressure drop converged (simplePDrop).');
    expect(body?.monitors).toEqual({
      pressureDrop: [
        { time: 1, dp0: 19900 },
        { time: 2, dp0: 19800 },
        { time: 3, dp0: 19700 },
      ],
      criterion: {
        method: 'simplePDrop',
        consecutive: 0,
        required: null,
        devPct: null,
        mean: null,
        filling: { filled: 3, size: 100 },
      },
      vortex: [
        { time: 3, qVolume: 0.2, maskedQVolume: 0.1, omegaRms: 12.5, coreVolume: 0.15, coreCells: 42 },
      ],
    });
  });
});
