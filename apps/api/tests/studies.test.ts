// Integration tests of the optimisation studies API (WS-H spec §0 + §7 + §9):
// CRUD under /projects/:id/studies, permissions (visibility = the project's,
// control = study owner + super-admin), the setup endpoint, the search-space
// validation (band ∩ table Min / Max, 50 mm grid, empty range 422), draft-only
// edits, start / resume guards, CSV export, deletion paths and boot reconciliation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { computeChamberOutputs } from '@dive/shared';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner } from '../src/lib/commandRunner';
import { setStreamRunner } from '../src/lib/streamRunner';
import { storageRoot } from '../src/lib/fileTreeStorage';
import { writeCaseFile } from '../src/lib/caseStorage';
import { writeMeshOrigin } from '../src/lib/meshOriginStorage';
import { chamberPaths } from '../src/lib/chamberStorage';
import { reconcileOrphanStudies } from '../src/modules/studies/studyRunner';
import {
  BASE_INPUT,
  makeStudyProject,
  settled,
  studiesUrl,
  studyBody,
  studyFakes,
  waitForStudy,
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

function create(f: StudyProject, extra: Record<string, unknown> = {}, auth = f.auth) {
  return request(app).post(studiesUrl(f)).set('Authorization', auth).send(studyBody(f, extra));
}

async function addCollaborator(f: StudyProject, email: string) {
  const user = await createTestUser({ email });
  await prisma.project.update({
    where: { id: f.projectId },
    data: { collaborators: { connect: { id: user.id } } },
  });
  return authHeader(user);
}

describe('Studies: access', () => {
  it('requires authentication', async () => {
    const f = await makeStudyProject();
    await request(app).get(studiesUrl(f)).expect(401);
  });

  it('answers 404 for a project the viewer cannot see', async () => {
    const f = await makeStudyProject();
    const stranger = authHeader(await createTestUser({ email: 'stranger@dive-turbinen.test' }));
    await request(app).get(studiesUrl(f)).set('Authorization', stranger).expect(404);
    await create(f, {}, stranger).expect(404);
  });

  it('lets a project member read and only the owner or a super-admin control', async () => {
    const f = await makeStudyProject();
    const created = await create(f).expect(201);
    const id = created.body.study.id as string;
    expect(created.body.study.canControl).toBe(true);

    const member = await addCollaborator(f, 'member@dive-turbinen.test');
    const list = await request(app).get(studiesUrl(f)).set('Authorization', member).expect(200);
    expect(list.body.studies.map((s: { id: string }) => s.id)).toEqual([id]);
    const detail = await request(app)
      .get(`${studiesUrl(f)}/${id}`)
      .set('Authorization', member)
      .expect(200);
    expect(detail.body.study.canControl).toBe(false);

    for (const [method, suffix] of [
      ['patch', ''],
      ['post', '/start'],
      ['post', '/stop'],
      ['post', '/resume'],
      ['delete', ''],
    ] as const) {
      const agent = request(app);
      const res = await agent[method](`${studiesUrl(f)}/${id}${suffix}`)
        .set('Authorization', member)
        .send({ name: 'Hijack' });
      expect(res.status, `${method} ${suffix}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    const admin = authHeader(await createProtectedAdmin());
    const renamed = await request(app)
      .patch(`${studiesUrl(f)}/${id}`)
      .set('Authorization', admin)
      .send({ name: 'Renamed by admin' })
      .expect(200);
    expect(renamed.body.study.name).toBe('Renamed by admin');
  });
});

describe('Studies: creation and search space', () => {
  it('creates a draft on this project with the band snapped to the grid', async () => {
    const f = await makeStudyProject();
    const res = await create(f, {
      keys: ['width', 'hMiddle'],
      bandOverrides: { hMiddle: 20 },
    }).expect(201);
    const study = res.body.study;
    expect(study).toMatchObject({
      name: 'Width sweep',
      projectId: f.projectId,
      status: 'draft',
      baseSource: 'save',
      bandPct: 10,
      weights: { headLoss: 0.5, vortex: 0.5 },
      mode: 'weighted',
      sampler: 'tpe',
      vortexMetric: 'maskedQVolume',
      maxEvaluations: 30,
      keepBest: 3,
      keepLast: 2,
      meshingSourceId: f.sessionId,
      criteria: null,
      counted: 0,
    });
    expect(study.baseInput).toEqual(BASE_INPUT);
    const outputs = computeChamberOutputs(BASE_INPUT);
    const width = outputs.find((o) => o.key === 'width')!.final;
    const hle = outputs.find((o) => o.key === 'hMiddle')!.final;
    expect(study.paramSpace).toEqual([
      expect.objectContaining({
        key: 'width',
        base: width,
        min: Math.ceil((width * 0.9) / 50) * 50,
        max: Math.floor((width * 1.1) / 50) * 50,
        step: 50,
        source: 'band',
      }),
      expect.objectContaining({
        key: 'hMiddle',
        base: hle,
        min: Math.ceil((hle * 0.8) / 50) * 50,
        max: Math.floor((hle * 1.2) / 50) * 50,
        bandPct: 20,
      }),
    ]);
    // No project was created: the study works in this project.
    expect(await prisma.project.count()).toBe(1);
  });

  it('intersects the band with the table Min / Max of the base design', async () => {
    const f = await makeStudyProject({
      input: { ...BASE_INPUT, constraints: { width: { max: 4500 } } },
    });
    const res = await create(f).expect(201);
    expect(res.body.study.paramSpace[0]).toMatchObject({
      key: 'width',
      max: 4500,
      source: 'table',
    });
  });

  it('refuses an empty range, no parameter, zero weights, a bad session or a permanent row (422)', async () => {
    const f = await makeStudyProject({
      input: { ...BASE_INPUT, constraints: { width: { min: 4460, max: 4480 } } },
    });
    const empty = await create(f).expect(422);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    expect(empty.body.error.message).toMatch(/B Kammer: no value on the 50 mm grid/);

    const none = await create(f, { keys: [] }).expect(422);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');

    const weights = await create(f, {
      keys: ['hMiddle'],
      weights: { headLoss: 0, vortex: 0 },
    }).expect(422);
    expect(weights.body.error.code).toBe('VALIDATION_ERROR');

    const session = await create(f, {
      keys: ['hMiddle'],
      meshingSourceId: 'no-such-session',
    }).expect(422);
    expect(session.body.error.message).toMatch(/meshing session/i);

    const bf1 = await create(f, { keys: ['chamferWidth1'] }).expect(422);
    expect(bf1.body.error.message).toMatch(/BF1/);

    const save = await create(f, {
      keys: ['hMiddle'],
      base: { kind: 'save', saveId: 'nope' },
    }).expect(422);
    expect(save.body.error.message).toMatch(/save/i);
  });

  it('uses the chamber of the mesh origin as base and its session as reference', async () => {
    const f = await makeStudyProject();
    const noOrigin = await create(f, {
      base: { kind: 'meshOrigin' },
      meshingSourceId: undefined,
    }).expect(422);
    expect(noOrigin.body.error.message).toMatch(/mesh origin|chamber/i);

    const hash = 'abcdef0123456789';
    const originInput = { ...BASE_INPUT, x1: 1500 };
    await fs.mkdir(chamberPaths(hash).dir, { recursive: true });
    await fs.writeFile(
      path.join(chamberPaths(hash).dir, 'input.json'),
      JSON.stringify(originInput),
    );
    await writeMeshOrigin(f.projectId, {
      sessionId: f.sessionId,
      sessionName: 'Chamber reference',
      engine: 'cfmesh',
      chamberHash: hash,
      at: new Date().toISOString(),
    });

    const setup = await request(app)
      .get(`${studiesUrl(f)}/setup`)
      .set('Authorization', f.auth)
      .expect(200);
    expect(setup.body.originInput).toEqual(originInput);
    expect(setup.body.defaultSessionId).toBe(f.sessionId);
    expect(setup.body.sessions.map((s: { id: string }) => s.id)).toContain(f.sessionId);
    expect(setup.body.criteriaApplicable).toBe(true);
    expect(setup.body.runningStudy).toBeNull();

    const res = await create(f, {
      base: { kind: 'meshOrigin' },
      meshingSourceId: undefined,
    }).expect(201);
    expect(res.body.study.baseSource).toBe('meshOrigin');
    expect(res.body.study.baseInput).toEqual(originInput);
    expect(res.body.study.meshingSourceId).toBe(f.sessionId);
  });
});

describe('Studies: lifecycle guards', () => {
  it('edits drafts only (409 STUDY_NOT_DRAFT) and recomputes the space', async () => {
    const f = await makeStudyProject();
    const id = (await create(f).expect(201)).body.study.id as string;
    const edited = await request(app)
      .patch(`${studiesUrl(f)}/${id}`)
      .set('Authorization', f.auth)
      .send({ bandPct: 5, maxEvaluations: 12 })
      .expect(200);
    expect(edited.body.study.maxEvaluations).toBe(12);
    expect(edited.body.study.paramSpace[0].bandPct).toBe(5);

    await prisma.study.update({ where: { id }, data: { status: 'completed' } });
    const refused = await request(app)
      .patch(`${studiesUrl(f)}/${id}`)
      .set('Authorization', f.auth)
      .send({ name: 'Too late' })
      .expect(409);
    expect(refused.body.error.code).toBe('STUDY_NOT_DRAFT');
    const again = await request(app)
      .post(`${studiesUrl(f)}/${id}/start`)
      .set('Authorization', f.auth)
      .expect(409);
    expect(again.body.error.code).toBe('STUDY_NOT_DRAFT');
  });

  it('resumes paused studies only (409 STUDY_NOT_PAUSED)', async () => {
    const f = await makeStudyProject();
    const id = (await create(f).expect(201)).body.study.id as string;
    const res = await request(app)
      .post(`${studiesUrl(f)}/${id}/resume`)
      .set('Authorization', f.auth)
      .expect(409);
    expect(res.body.error.code).toBe('STUDY_NOT_PAUSED');
  });

  it('runs one study at a time globally (409 STUDY_IN_PROGRESS)', async () => {
    const f = await makeStudyProject();
    const first = (await create(f).expect(201)).body.study.id as string;
    const second = (await create(f, { name: 'Other' }).expect(201)).body.study.id as string;
    await prisma.study.update({ where: { id: first }, data: { status: 'running' } });
    const res = await request(app)
      .post(`${studiesUrl(f)}/${second}/start`)
      .set('Authorization', f.auth)
      .expect(409);
    expect(res.body.error.code).toBe('STUDY_IN_PROGRESS');
  });

  it('refuses to start without a steady incompressible solver in the case (422)', async () => {
    const f = await makeStudyProject();
    const id = (await create(f).expect(201)).body.study.id as string;
    await writeCaseFile(
      f.projectId,
      'system/controlDict',
      'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }\napplication pimpleFoam;\n',
    );
    const res = await request(app)
      .post(`${studiesUrl(f)}/${id}/start`)
      .set('Authorization', f.auth)
      .expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/steady incompressible/);
  });

  it('deletes a draft (204) and cascades with the project', async () => {
    const f = await makeStudyProject();
    const id = (await create(f).expect(201)).body.study.id as string;
    await request(app)
      .delete(`${studiesUrl(f)}/${id}`)
      .set('Authorization', f.auth)
      .expect(204);
    await request(app)
      .get(`${studiesUrl(f)}/${id}`)
      .set('Authorization', f.auth)
      .expect(404);

    await create(f).expect(201);
    await request(app)
      .delete(`/api/v1/projects/${f.projectId}`)
      .set('Authorization', f.auth)
      .expect(204);
    expect(await prisma.study.count()).toBe(0);
  });
});

describe('Studies: results', () => {
  it('exports one CSV row per evaluation and serves the archived metrics', async () => {
    const f = await makeStudyProject();
    const fakes = studyFakes({ suggestions: [{ width: 4200 }] });
    setCommandRunner(fakes.commandRunner);
    setStreamRunner(fakes.streamRunner);
    const id = (await create(f, { maxEvaluations: 2 }).expect(201)).body.study.id as string;
    await request(app)
      .post(`${studiesUrl(f)}/${id}/start`)
      .set('Authorization', f.auth)
      .expect(202);
    const detail = await waitForStudy(f, id, settled);
    expect(detail.study.status).toBe('completed');

    const csv = await request(app)
      .get(`${studiesUrl(f)}/${id}/export.csv`)
      .set('Authorization', f.auth)
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(
      /^index,status,width,dp0_Pa,headLoss_m,maskedQVolume_m3,omegaRms_1_s,objective/,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^1,done,4200,/);

    const evaluation = await request(app)
      .get(`${studiesUrl(f)}/${id}/evaluations/1`)
      .set('Authorization', f.auth)
      .expect(200);
    expect(evaluation.body.evaluation).toMatchObject({ index: 1, status: 'done' });
    expect(evaluation.body.metrics.pressureDrop.length).toBeGreaterThan(0);
    expect(evaluation.body.metrics.vortex).toMatchObject({ maskedQVolume: 0.5, omegaRms: 12 });
    await request(app)
      .get(`${studiesUrl(f)}/${id}/evaluations/9`)
      .set('Authorization', f.auth)
      .expect(404);
  });

  it('pauses a study left running by a dead process on boot', async () => {
    const f = await makeStudyProject();
    const id = (await create(f).expect(201)).body.study.id as string;
    await prisma.study.update({
      where: { id },
      data: { status: 'running', startedAt: new Date() },
    });
    await prisma.evaluation.create({
      data: { studyId: id, index: 0, designParams: '{}', status: 'solving', startedAt: new Date() },
    });
    expect(await reconcileOrphanStudies()).toBe(1);
    const detail = await request(app)
      .get(`${studiesUrl(f)}/${id}`)
      .set('Authorization', f.auth)
      .expect(200);
    expect(detail.body.study.status).toBe('paused');
    expect(detail.body.study.reason).toBe('Interrupted by a server restart');
    expect(detail.body.evaluations[0]).toMatchObject({ status: 'interrupted', stage: 'solving' });
  });
});
