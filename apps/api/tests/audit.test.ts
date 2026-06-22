// Audit trail tests: recording of admin/auth actions and the read endpoint.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  authHeader,
  createProtectedAdmin,
  createTestUser,
  DEFAULT_PASSWORD,
  resetDatabase,
} from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/audit-logs authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/v1/audit-logs');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a normal USER with 403 FORBIDDEN', async () => {
    await createProtectedAdmin();
    const normal = await createTestUser({ email: 'normal@dive-turbinen.test', role: 'USER' });

    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', authHeader(normal));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('audit recording', () => {
  it('records a LOGIN entry with the actor email', async () => {
    const admin = await createProtectedAdmin();

    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });

    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    const login = res.body.logs.find(
      (l: { action: string }) => l.action === 'LOGIN',
    );
    expect(login).toBeTruthy();
    expect(login.actorEmail).toBe(admin.email);
    expect(login.createdAt).toEqual(expect.any(String));
  });

  it('records USER_CREATED with role metadata when an account is created', async () => {
    const admin = await createProtectedAdmin();

    await request(app)
      .post('/api/v1/users')
      .set('Authorization', authHeader(admin))
      .send({
        fullName: 'Audited User',
        email: 'audited@dive-turbinen.test',
        password: 'Audited-Pass-1',
        role: 'USER',
      });

    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', authHeader(admin));

    const created = res.body.logs.find(
      (l: { action: string }) => l.action === 'USER_CREATED',
    );
    expect(created).toBeTruthy();
    expect(created.actorEmail).toBe(admin.email);
    expect(created.targetEmail).toBe('audited@dive-turbinen.test');
    expect(created.metadata).toMatchObject({ role: 'USER' });
  });

  it('records USER_DISABLED when an account is disabled', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'audit-disable@dive-turbinen.test', role: 'USER' });

    await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ isActive: false });

    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', authHeader(admin));

    const disabled = res.body.logs.find(
      (l: { action: string }) => l.action === 'USER_DISABLED',
    );
    expect(disabled).toBeTruthy();
    expect(disabled.targetEmail).toBe(user.email);
  });

  it('returns entries newest first and respects the limit query', async () => {
    const admin = await createProtectedAdmin();

    // Generate a few distinct actions.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });
    await request(app)
      .post('/api/v1/users')
      .set('Authorization', authHeader(admin))
      .send({
        fullName: 'Limit One',
        email: 'limit1@dive-turbinen.test',
        password: 'Limit-Pass-1',
        role: 'USER',
      });

    const res = await request(app)
      .get('/api/v1/audit-logs?limit=1')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
  });

  it('rejects an out-of-range limit with 422 VALIDATION_ERROR', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .get('/api/v1/audit-logs?limit=9999')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
