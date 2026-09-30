// Stage machine of the optimisation study runner (WS-H spec §6 + §9), with the
// fakes of studyFixtures.ts: happy path, builder refusal (CHAMBER_REFUSED) and
// checkMesh failures as infeasible trials, mesher failure and divergence as
// failed ones, budget-hit runs, baseline failure, evaluation and time budgets,
// disk hygiene (best K + last N sessions), duplicate designs, pause / resume and
// the project locks.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GRAVITY } from '@dive/shared';
import { app, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner } from '../src/lib/commandRunner';
import { setStreamRunner } from '../src/lib/streamRunner';
import { storageRoot } from '../src/lib/fileTreeStorage';
import { sessionExists } from '../src/lib/meshingStorage';
import { readMeshOrigin } from '../src/lib/meshOriginStorage';
import {
  makeStudyProject,
  settled,
  studiesUrl,
  studyBody,
  studyFakes,
  waitForStudy,
  type StudyFakeOptions,
  type StudyProject,
} from './studyFixtures';

beforeEach(async () => {
  await resetDatabase();
  for (const dir of ['projects', 'meshing', 'chamber', 'studies']) {
    await fs.rm(path.join(storageRoot(), dir), { recursive: true, force: true });
  }
});
afterEach(() => {
  setCommandRunner(null);
  setStreamRunner(null);
});

type Evaluation = {
  index: number;
  status: string;
  stage: string | null;
  designParams: Record<string, number>;
  meshingSessionId: string | null;
  sessionAvailable: boolean;
  runId: string | null;
  runStatus: string | null;
  budgetHit: boolean;
  dp0: number | null;
  headLoss: number | null;
  maskedQVolume: number | null;
  omegaRms: number | null;
  objective: number | null;
  refusalReason: string | null;
  warnings: string[];
};

async function startStudy(
  f: StudyProject,
  fake: StudyFakeOptions,
  extra: Record<string, unknown> = {},
) {
  const fakes = studyFakes(fake);
  setCommandRunner(fakes.commandRunner);
  setStreamRunner(fakes.streamRunner);
  const created = await request(app)
    .post(studiesUrl(f))
    .set('Authorization', f.auth)
    .send(studyBody(f, extra))
    .expect(201);
  const id = created.body.study.id as string;
  const started = await request(app)
    .post(`${studiesUrl(f)}/${id}/start`)
    .set('Authorization', f.auth);
  expect(started.status).toBe(202);
  expect(started.body.study.status).toBe('running');
  return { id, state: fakes.state };
}

const evals = (d: { evaluations: Record<string, unknown>[] }) => d.evaluations as unknown as Evaluation[];

describe('Study runner', () => {
  it('evaluates the baseline then two suggested designs (happy path)', async () => {
    const f = await makeStudyProject();
    const { id, state } = await startStudy(
      f,
      {
        suggestions: [{ width: 4200 }, { width: 4700 }],
        dp0: (n) => [19620, 9810, 29430][n],
        vortex: (n) => [
          { maskedQVolume: 0.5, omegaRms: 10 },
          { maskedQVolume: 0.25, omegaRms: 8 },
          { maskedQVolume: 1, omegaRms: 20 },
        ][n],
      },
      { maxEvaluations: 3 },
    );
    const d = await waitForStudy(f, id, settled);
    expect(d.study.status).toBe('completed');
    expect(d.study.reason).toMatch(/3 evaluations/);
    expect(d.study.counted).toBe(3);
    expect(d.study.criteria).toMatchObject({ convergence: { method: 'simplePDrop' } });
    const e = evals(d);
    expect(e.map((x) => x.status)).toEqual(['done', 'done', 'done']);
    expect(e.map((x) => x.designParams.width)).toEqual([4450, 4200, 4700]);
    expect(e[0].dp0).toBeCloseTo(19620);
    expect(e[0].headLoss).toBeCloseTo(19620 / (1000 * GRAVITY));
    expect(e[1].maskedQVolume).toBeCloseTo(0.25);
    expect(e[1].omegaRms).toBeCloseTo(8);
    expect(e[0].objective).toBeCloseTo(1);
    expect(e[1].objective).toBeCloseTo(0.5 * 0.5 + 0.5 * 0.5);
    expect(e[2].objective).toBeCloseTo(0.5 * 1.5 + 0.5 * 2);
    expect(d.study.normalisation).toEqual({
      headLoss: expect.closeTo(2, 6),
      vortex: expect.closeTo(0.5, 6),
    });
    expect(d.best).toBe(1);
    expect(e.every((x) => x.runStatus === 'converged' && !x.budgetHit)).toBe(true);

    // The baseline is the unmodified base design; the others pin width as Exact.
    expect(state.builds[0].constraints?.width).toBeUndefined();
    expect(state.builds[1].constraints?.width).toEqual({ exact: 4200 });
    // Ask / tell: the history is rebuilt from the Evaluation rows at each step.
    expect(state.suggestRequests).toHaveLength(2);
    expect(state.suggestRequests[0].space).toEqual([{ key: 'width', low: 4050, high: 4850, step: 50 }]);
    expect(state.suggestRequests[0].history).toHaveLength(1);
    expect(state.suggestRequests[1].history).toHaveLength(2);
    expect(state.suggestRequests[1].history[1]).toMatchObject({
      params: { width: 4200 },
      state: 'COMPLETE',
      values: [expect.closeTo(0.5, 6)],
    });

    // The project case now holds the last evaluation's mesh.
    expect((await readMeshOrigin(f.projectId))?.sessionId).toBe(e[2].meshingSessionId);
    // Every session is kept (best 3 + last 2 covers 3 evaluations).
    expect(e.every((x) => x.sessionAvailable)).toBe(true);
  });

  it('marks a builder refusal (CHAMBER_REFUSED) infeasible and continues', async () => {
    const f = await makeStudyProject();
    const { id } = await startStudy(
      f,
      {
        suggestions: [{ width: 4050 }, { width: 4600 }],
        refuse: (input) =>
          input.constraints?.width?.exact === 4050 ? 'the guide vanes do not fit in B Kammer' : null,
      },
      { maxEvaluations: 3 },
    );
    const d = await waitForStudy(f, id, settled);
    const e = evals(d);
    expect(e.map((x) => x.status)).toEqual(['done', 'infeasible', 'done']);
    expect(e[1].refusalReason).toMatch(/guide vanes do not fit/);
    expect(e[1].stage).toBe('building');
    expect(d.study.status).toBe('completed');
  });

  it('marks failed mesh checks infeasible without retrying', async () => {
    const f = await makeStudyProject();
    const { id, state } = await startStudy(
      f,
      { suggestions: [{ width: 4200 }, { width: 4300 }], checkMeshFails: (n) => n === 1 },
      { maxEvaluations: 3 },
    );
    const d = await waitForStudy(f, id, settled);
    const e = evals(d);
    expect(e[1].status).toBe('infeasible');
    expect(e[1].refusalReason).toMatch(/Failed 2 mesh checks/);
    expect(e[1].refusalReason).toMatch(/High aspect ratio/);
    expect(state.meshRuns).toBe(3);
    expect(state.solves).toBe(2);
  });

  it('marks a mesher failure and a divergence failed, and counts budget-hit runs', async () => {
    const f = await makeStudyProject();
    const { id } = await startStudy(
      f,
      {
        suggestions: [{ width: 4200 }, { width: 4300 }, { width: 4400 }],
        meshFails: (n) => n === 1,
        solve: (n) => (n === 1 ? 'diverged' : n === 2 ? 'budget' : 'converged'),
      },
      { maxEvaluations: 4 },
    );
    const d = await waitForStudy(f, id, settled);
    const e = evals(d);
    expect(e.map((x) => x.status)).toEqual(['done', 'failed', 'failed', 'done']);
    expect(e[1].stage).toBe('meshing');
    expect(e[2].stage).toBe('solving');
    expect(e[2].runStatus).toBe('diverged');
    expect(e[3]).toMatchObject({ runStatus: 'completed', budgetHit: true });
    expect(e[3].headLoss).not.toBeNull();
  });

  it('fails the study when the baseline is infeasible', async () => {
    const f = await makeStudyProject();
    const { id, state } = await startStudy(f, { refuse: () => 'the chamber is too small' });
    const d = await waitForStudy(f, id, settled);
    expect(d.study.status).toBe('failed');
    expect(d.study.reason).toMatch(/baseline/i);
    expect(d.study.reason).toMatch(/too small/);
    expect(evals(d)).toHaveLength(1);
    expect(state.suggestRequests).toHaveLength(0);
  });

  it('stops on the time budget', async () => {
    const f = await makeStudyProject();
    const { id } = await startStudy(f, {}, { maxEvaluations: 10, maxDurationHours: 1e-6 });
    const d = await waitForStudy(f, id, settled);
    expect(d.study.status).toBe('completed');
    expect(d.study.reason).toMatch(/time budget/i);
    expect(evals(d)).toHaveLength(1);
  });

  it('keeps the sessions of the best K and last N evaluations only', async () => {
    const f = await makeStudyProject();
    // Objectives: #0 = 1, #1 = 0.5 (best), #2 = 2, #3 = 1.5 (last).
    const { id } = await startStudy(
      f,
      {
        suggestions: [{ width: 4200 }, { width: 4300 }, { width: 4400 }],
        dp0: (n) => [19620, 9810, 39240, 29430][n],
        vortex: (n) => [0.5, 0.25, 1, 0.75].map((v) => ({ maskedQVolume: v, omegaRms: 10 }))[n],
      },
      { maxEvaluations: 4, keepBest: 1, keepLast: 1 },
    );
    const d = await waitForStudy(f, id, settled);
    const e = evals(d);
    expect(e.map((x) => x.sessionAvailable)).toEqual([false, true, false, true]);
    expect(await sessionExists(e[0].meshingSessionId!)).toBe(false);
    expect(await sessionExists(e[2].meshingSessionId!)).toBe(false);
    expect(await sessionExists(e[1].meshingSessionId!)).toBe(true);
    expect(await sessionExists(e[3].meshingSessionId!)).toBe(true);
    // The reference session is never touched.
    expect(await sessionExists(f.sessionId)).toBe(true);
  });

  it('reuses the metrics of a duplicate design without re-solving', async () => {
    const f = await makeStudyProject();
    const { id, state } = await startStudy(
      f,
      { suggestions: [{ width: 4200 }, { width: 4200 }] },
      { maxEvaluations: 3 },
    );
    const d = await waitForStudy(f, id, settled);
    const e = evals(d);
    expect(e[2].status).toBe('done');
    expect(e[2].warnings).toContain('duplicate of #1');
    expect(e[2].headLoss).toBeCloseTo(e[1].headLoss!);
    expect(state.solves).toBe(2);
  });

  it('locks the project while running, pauses on stop and resumes the interrupted design', async () => {
    const f = await makeStudyProject();
    const { id, state } = await startStudy(
      f,
      { suggestions: [{ width: 4200 }, { width: 4700 }], solve: (n) => (n === 1 ? 'hang' : 'converged') },
      { maxEvaluations: 3 },
    );
    await waitForStudy(f, id, (d) => {
      const e = evals(d)[1];
      return e?.status === 'solving' && !!e.runId;
    });

    // The project lock: manual run, case mutation, free-surface start, another study.
    const run = await request(app).post(`/api/v1/projects/${f.projectId}/runs`).set('Authorization', f.auth).send({});
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('STUDY_IN_PROGRESS');
    const reset = await request(app).delete(`/api/v1/projects/${f.projectId}/files`).set('Authorization', f.auth);
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('STUDY_IN_PROGRESS');
    const send = await request(app)
      .post(`/api/v1/projects/${f.projectId}/mesh/from-meshing`)
      .set('Authorization', f.auth)
      .send({ sessionId: f.sessionId, target: 'case' });
    expect(send.body.error.code).toBe('STUDY_IN_PROGRESS');
    const fs1 = await request(app)
      .post(`/api/v1/projects/${f.projectId}/free-surface`)
      .set('Authorization', f.auth)
      .send({ lidPatch: 'outlet', inletPatch: 'inlet', sourceSessionId: f.sessionId });
    expect(fs1.status).toBe(409);
    expect(fs1.body.error.code).toBe('STUDY_IN_PROGRESS');
    const other = await request(app)
      .post(studiesUrl(f))
      .set('Authorization', f.auth)
      .send(studyBody(f, { name: 'Second' }))
      .expect(201);
    const second = await request(app)
      .post(`${studiesUrl(f)}/${other.body.study.id}/start`)
      .set('Authorization', f.auth);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('STUDY_IN_PROGRESS');
    await request(app).delete(`${studiesUrl(f)}/${other.body.study.id}`).set('Authorization', f.auth).expect(204);

    // Stop = pause: the run is stopped, the evaluation interrupted.
    const stop = await request(app).post(`${studiesUrl(f)}/${id}/stop`).set('Authorization', f.auth).expect(200);
    expect(['pausing', 'paused']).toContain(stop.body.study.status);
    const paused = await waitForStudy(f, id, settled);
    expect(paused.study.status).toBe('paused');
    const interrupted = evals(paused)[1];
    expect(interrupted).toMatchObject({ status: 'interrupted', stage: 'solving' });
    const runRow = await prisma.run.findUnique({ where: { id: interrupted.runId! } });
    expect(runRow?.status).toBe('stopped');
    // Idempotent stop; unlocked once paused.
    await request(app).post(`${studiesUrl(f)}/${id}/stop`).set('Authorization', f.auth).expect(200);
    const unlocked = await request(app)
      .post(`/api/v1/projects/${f.projectId}/mesh/from-meshing`)
      .set('Authorization', f.auth)
      .send({ sessionId: 'no-such-session', target: 'case' });
    expect(unlocked.status).toBe(404);

    // Resume: the interrupted design is evaluated first (same index), then the next.
    const resumed = await request(app).post(`${studiesUrl(f)}/${id}/resume`).set('Authorization', f.auth);
    expect(resumed.status).toBe(202);
    const done = await waitForStudy(f, id, settled);
    expect(done.study.status).toBe('completed');
    const e = evals(done);
    expect(e.map((x) => [x.index, x.status, x.designParams.width])).toEqual([
      [0, 'done', 4450],
      [1, 'done', 4200],
      [2, 'done', 4700],
    ]);
    expect(state.suggestRequests).toHaveLength(2);
  });

  it('fails the study with the optimiser message when the suggestion fails', async () => {
    const f = await makeStudyProject();
    const { id } = await startStudy(f, { suggestFails: 'optuna is not installed' }, { maxEvaluations: 3 });
    const d = await waitForStudy(f, id, settled);
    expect(d.study.status).toBe('failed');
    expect(d.study.reason).toMatch(/optuna is not installed/);
    expect(evals(d)).toHaveLength(1);
  });
});
