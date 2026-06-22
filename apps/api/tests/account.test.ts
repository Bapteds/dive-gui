// Self-service account endpoint tests: PATCH /auth/me and POST /auth/change-password.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, createTestUser, DEFAULT_PASSWORD, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Log a fixture user in via the API and return its access token + refresh cookie. */
async function loginAs(
  email: string,
  password: string = DEFAULT_PASSWORD,
): Promise<{ accessToken: string; setCookie: string[] }> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return {
    accessToken: res.body.accessToken as string,
    setCookie: res.headers['set-cookie'] as unknown as string[],
  };
}

describe('PATCH /api/v1/auth/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).patch('/api/v1/auth/me').send({ fullName: 'X' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it("updates the current user's own display name", async () => {
    const user = await createTestUser({ email: 'me@dive-turbinen.test', fullName: 'Old Name' });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('New Name');
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects a blank display name with 422 VALIDATION_ERROR', async () => {
    const user = await createTestUser({ email: 'me2@dive-turbinen.test' });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: '   ' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores attempts to change role or email (no privilege escalation)', async () => {
    const user = await createTestUser({
      email: 'fixed@dive-turbinen.test',
      fullName: 'Stay Put',
      role: 'USER',
    });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'Renamed', role: 'SUPER_ADMIN', email: 'attacker@dive-turbinen.test' });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Renamed');
    // role and email are not self-editable; the extra fields must be ignored.
    expect(res.body.user.role).toBe('USER');
    expect(res.body.user.email).toBe('fixed@dive-turbinen.test');
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'x', newPassword: 'a-strong-new-pass' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('changes the password with the correct current password', async () => {
    const user = await createTestUser({ email: 'pw@dive-turbinen.test' });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'Brand-New-Pass-1' });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.id).toBe(user.id);

    // The new password works...
    const withNew = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'Brand-New-Pass-1' });
    expect(withNew.status).toBe(200);

    // ...and the old one no longer does.
    const withOld = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it('rejects a wrong current password with 400 INVALID_PASSWORD', async () => {
    const user = await createTestUser({ email: 'pw2@dive-turbinen.test' });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: 'not-my-password', newPassword: 'Another-New-1' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
  });

  it('rejects a too-short new password with 422 VALIDATION_ERROR', async () => {
    const user = await createTestUser({ email: 'pw3@dive-turbinen.test' });
    const { accessToken } = await loginAs(user.email);

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('revokes other sessions but keeps the current device signed in', async () => {
    const user = await createTestUser({ email: 'pw4@dive-turbinen.test' });
    // Two independent sessions (e.g. two devices), both at tokenVersion 0.
    const sessionA = await loginAs(user.email);
    const sessionB = await loginAs(user.email);

    // Change the password from session A.
    const change = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${sessionA.accessToken}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'Rotated-Pass-1' });
    expect(change.status).toBe(200);

    // Session B's old refresh cookie is now revoked (tokenVersion moved on).
    const reuseB = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', sessionB.setCookie);
    expect(reuseB.status).toBe(401);
    expect(reuseB.body.error.code).toBe('UNAUTHENTICATED');

    // Session A keeps working via the rotated cookie change-password returned.
    const rotatedCookie = change.headers['set-cookie'] as unknown as string[];
    const reuseA = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookie);
    expect(reuseA.status).toBe(200);
  });
});
