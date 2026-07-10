// Integration tests for the active-run guard (M1): while a solver run is active,
// destructive case mutations must be refused with 409 RUN_IN_PROGRESS so they
// cannot corrupt the case the solver is reading/writing. A terminal (completed)
// run must NOT block anything.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';

async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

/** Insert a Run row in the given (default active) status for a project. */
function createRun(projectId: string, status = 'running') {
  return prisma.run.create({
    data: {
      projectId,
      solver: 'simpleFoam',
      status,
      command: 'simpleFoam -case case',
      logPath: `runs/${projectId}/solver.log`,
    },
  });
}

/** Seed a minimal polyMesh so the mutation reaches its own logic if not guarded. */
async function seedMesh(id: string): Promise<void> {
  await writeCaseFile(id, 'constant/polyMesh/boundary', 'FoamFile { class polyBoundaryMesh; object boundary; }\n0\n(\n)\n');
  await writeCaseFile(id, 'constant/polyMesh/points', 'points');
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('active-run guard on destructive case mutations (M1)', () => {
  it('blocks reset, auto-patch and sync-boundaries with 409 while a run is active', async () => {
    const { id, auth } = await makeProject('rg-block@dive-turbinen.test');
    await seedMesh(id);
    await createRun(id, 'running');

    const reset = await request(app).delete(`/api/v1/projects/${id}/files`).set('Authorization', auth);
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('RUN_IN_PROGRESS');

    const autoPatch = await request(app)
      .post(`/api/v1/projects/${id}/mesh/auto-patch`)
      .set('Authorization', auth)
      .send({ featureAngle: 45 });
    expect(autoPatch.status).toBe(409);
    expect(autoPatch.body.error.code).toBe('RUN_IN_PROGRESS');

    const sync = await request(app)
      .post(`/api/v1/projects/${id}/files/sync-boundaries`)
      .set('Authorization', auth);
    expect(sync.status).toBe(409);
    expect(sync.body.error.code).toBe('RUN_IN_PROGRESS');
  });

  it('blocks editing a case file while a run is active', async () => {
    const { id, auth } = await makeProject('rg-edit@dive-turbinen.test');
    await writeCaseFile(id, 'system/controlDict', 'FoamFile {}\n');
    await createRun(id, 'queued'); // queued is also an active status

    const save = await request(app)
      .put(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent('system/controlDict')}`)
      .set('Authorization', auth)
      .set('Content-Type', 'text/plain')
      .send('FoamFile {}\n// edited\n');
    expect(save.status).toBe(409);
    expect(save.body.error.code).toBe('RUN_IN_PROGRESS');
  });

  it('does NOT block a mutation once the run is terminal (completed)', async () => {
    const { id, auth } = await makeProject('rg-terminal@dive-turbinen.test');
    await createRun(id, 'completed'); // terminal -> not active

    // Reset now succeeds (200) instead of 409 — the guard only trips on active runs.
    const reset = await request(app).delete(`/api/v1/projects/${id}/files`).set('Authorization', auth);
    expect(reset.status).toBe(200);
  });
});
