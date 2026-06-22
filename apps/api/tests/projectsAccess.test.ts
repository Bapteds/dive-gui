// Project access tests: collaborator visibility, super-admin sees all, detail
// guards, delete permissions, and collaborator management.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import type { User } from '@prisma/client';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Create a project via the API and return the serialized project. */
async function makeProject(owner: User, title: string) {
  const res = await request(app)
    .post('/api/v1/projects')
    .set('Authorization', authHeader(owner))
    .send({ title });
  return res.body.project as { id: string; collaborators: { email: string }[] };
}

describe('project visibility', () => {
  it('hides a project from a user who is neither owner nor collaborator', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    await makeProject(alice, 'Alice secret');

    const list = await request(app).get('/api/v1/projects').set('Authorization', authHeader(bob));
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(0);
  });

  it('shows a project to a collaborator once added', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'Shared study');

    await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: bob.email });

    const list = await request(app).get('/api/v1/projects').set('Authorization', authHeader(bob));
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].id).toBe(project.id);
  });

  it('lets a super-admin see every project', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const admin = await createTestUser({ email: 'admin@dive-turbinen.test', role: 'SUPER_ADMIN' });
    await makeProject(alice, 'A');
    await makeProject(bob, 'B');

    const list = await request(app).get('/api/v1/projects').set('Authorization', authHeader(admin));
    expect(list.body.projects).toHaveLength(2);
  });
});

describe('GET /api/v1/projects/:id', () => {
  it('returns 404 for a non-member (no existence leak)', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'Private');

    const res = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(bob));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns the project with owner and collaborators for the owner', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const project = await makeProject(alice, 'Mine');

    const res = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.project.owner.email).toBe(alice.email);
    expect(Array.isArray(res.body.project.collaborators)).toBe(true);
  });
});

describe('DELETE /api/v1/projects/:id', () => {
  it('lets the owner delete and returns 204', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const project = await makeProject(alice, 'To delete');

    const res = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(alice));
    expect(res.status).toBe(204);
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
  });

  it('forbids a collaborator from deleting (403)', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'Shared');
    await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: bob.email });

    const res = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(bob));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when a stranger tries to delete', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'Private');

    const res = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(bob));
    expect(res.status).toBe(404);
  });

  it('lets a super-admin delete any project', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const admin = await createTestUser({ email: 'admin@dive-turbinen.test', role: 'SUPER_ADMIN' });
    const project = await makeProject(alice, 'Admin can remove');

    const res = await request(app)
      .delete(`/api/v1/projects/${project.id}`)
      .set('Authorization', authHeader(admin));
    expect(res.status).toBe(204);
  });
});

describe('collaborator management', () => {
  it('adds a collaborator by email and returns the updated project', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'Team project');

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: bob.email });
    expect(res.status).toBe(200);
    expect(res.body.project.collaborators.map((c: { email: string }) => c.email)).toContain(
      bob.email,
    );
  });

  it('rejects an unknown email with 404 USER_NOT_FOUND', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const project = await makeProject(alice, 'P');

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: 'nobody@dive-turbinen.test' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('rejects adding the owner as a collaborator with 409 COLLABORATOR_EXISTS', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const project = await makeProject(alice, 'P');

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: alice.email });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COLLABORATOR_EXISTS');
  });

  it('forbids a collaborator from managing collaborators (403)', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const carol = await createTestUser({ email: 'carol@dive-turbinen.test' });
    const project = await makeProject(alice, 'P');
    await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: bob.email });

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(bob))
      .send({ email: carol.email });
    expect(res.status).toBe(403);
  });

  it('removes a collaborator', async () => {
    const alice = await createTestUser({ email: 'alice@dive-turbinen.test' });
    const bob = await createTestUser({ email: 'bob@dive-turbinen.test' });
    const project = await makeProject(alice, 'P');
    await request(app)
      .post(`/api/v1/projects/${project.id}/collaborators`)
      .set('Authorization', authHeader(alice))
      .send({ email: bob.email });

    const res = await request(app)
      .delete(`/api/v1/projects/${project.id}/collaborators/${bob.id}`)
      .set('Authorization', authHeader(alice));
    expect(res.status).toBe(200);
    expect(res.body.project.collaborators).toHaveLength(0);
  });
});
