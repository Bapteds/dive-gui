// Projects tests: authenticated, owner-scoped create + list.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/projects', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/projects').send({ title: 'Stage 1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates a project owned by the current user and returns 201', async () => {
    const user = await createTestUser({ email: 'owner@dive-turbinen.test' });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(user))
      .send({ title: 'Rotor stage tip-clearance study' });

    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ title: 'Rotor stage tip-clearance study' });
    expect(res.body.project.id).toEqual(expect.any(String));
    expect(res.body.project.createdAt).toEqual(expect.any(String));
    // The owner id is internal and must not be serialized.
    expect(res.body.project.ownerId).toBeUndefined();

    const stored = await prisma.project.findUnique({ where: { id: res.body.project.id } });
    expect(stored?.ownerId).toBe(user.id);
  });

  it('rejects a blank title with 422 VALIDATION_ERROR', async () => {
    const user = await createTestUser({ email: 'blank@dive-turbinen.test' });

    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(user))
      .send({ title: '   ' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/v1/projects/:id', () => {
  async function createProject(user: Awaited<ReturnType<typeof createTestUser>>, title: string) {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(user))
      .send({ title });
    return res.body.project.id as string;
  }

  it('renames the owner\'s project and returns 200', async () => {
    const user = await createTestUser({ email: 'renamer@dive-turbinen.test' });
    const id = await createProject(user, 'Old title');

    const res = await request(app)
      .patch(`/api/v1/projects/${id}`)
      .set('Authorization', authHeader(user))
      .send({ title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ id, title: 'New title' });
    const stored = await prisma.project.findUnique({ where: { id } });
    expect(stored?.title).toBe('New title');
  });

  it('rejects a blank title with 422 VALIDATION_ERROR', async () => {
    const user = await createTestUser({ email: 'blankrename@dive-turbinen.test' });
    const id = await createProject(user, 'Keep me');

    const res = await request(app)
      .patch(`/api/v1/projects/${id}`)
      .set('Authorization', authHeader(user))
      .send({ title: '   ' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a stranger (no existence leak)', async () => {
    const owner = await createTestUser({ email: 'owner2@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 'stranger@dive-turbinen.test' });
    const id = await createProject(owner, 'Private');

    const res = await request(app)
      .patch(`/api/v1/projects/${id}`)
      .set('Authorization', authHeader(stranger))
      .send({ title: 'Hijack' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/projects', () => {
  it('lists only the current user\'s own projects, newest first', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });

    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(alice))
      .send({ title: 'Alpha' });
    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(alice))
      .send({ title: 'Beta' });
    await request(app)
      .post('/api/v1/projects')
      .set('Authorization', authHeader(bob))
      .send({ title: 'Bob only' });

    const res = await request(app).get('/api/v1/projects').set('Authorization', authHeader(alice));

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(2);
    // Newest first.
    expect(res.body.projects[0].title).toBe('Beta');
    expect(res.body.projects[1].title).toBe('Alpha');
    // Bob's project never leaks into Alice's list.
    const titles = res.body.projects.map((p: { title: string }) => p.title);
    expect(titles).not.toContain('Bob only');
  });
});
