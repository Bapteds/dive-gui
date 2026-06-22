// Account status tests: disabling / re-enabling accounts and the access it gates.
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

describe('PATCH /api/v1/users/:id account status', () => {
  it('disables an account, revokes its sessions, and blocks login', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'disable@dive-turbinen.test', role: 'USER' });

    // The user has an active session before being disabled.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(login.status).toBe(200);
    const accessToken = login.body.accessToken as string;
    const setCookie = login.headers['set-cookie'] as unknown as string[];

    // The admin disables the account.
    const patch = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(patch.body.user.isActive).toBe(false);

    // tokenVersion bumped => existing refresh token rejected.
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.tokenVersion).toBe(1);

    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', setCookie);
    expect(reuse.status).toBe(401);

    // The still-unexpired access token is rejected on the next request.
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(401);

    // A fresh login is refused with the dedicated code.
    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('re-enables a disabled account so it can log in again', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'reenable@dive-turbinen.test', role: 'USER' });

    await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ isActive: false });

    const enable = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ isActive: true });
    expect(enable.status).toBe(200);
    expect(enable.body.user.isActive).toBe(true);

    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(relogin.status).toBe(200);
  });

  it('refuses to disable the protected super-admin with 409 PROTECTED_ACCOUNT', async () => {
    const admin = await createProtectedAdmin();
    const otherAdmin = await createTestUser({
      email: 'other-admin@dive-turbinen.test',
      role: 'SUPER_ADMIN',
    });

    const res = await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set('Authorization', authHeader(otherAdmin))
      .send({ isActive: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROTECTED_ACCOUNT');
  });

  it('refuses to disable your own account with 409 SELF_DISABLE_FORBIDDEN', async () => {
    // A non-protected super-admin disabling themselves must still be blocked.
    const selfAdmin = await createTestUser({
      email: 'self-disable@dive-turbinen.test',
      role: 'SUPER_ADMIN',
      isProtected: false,
    });

    const res = await request(app)
      .patch(`/api/v1/users/${selfAdmin.id}`)
      .set('Authorization', authHeader(selfAdmin))
      .send({ isActive: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_DISABLE_FORBIDDEN');
  });

  it('does NOT revoke sessions for a no-op re-enable of an active account', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'noop-active@dive-turbinen.test', role: 'USER' });

    const patch = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ isActive: true });
    expect(patch.status).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.tokenVersion).toBe(0);
  });
});

describe('login tracking', () => {
  it('stamps lastLoginAt on a successful login', async () => {
    const user = await createTestUser({ email: 'stamp@dive-turbinen.test' });
    expect(user.lastLoginAt).toBeNull();

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.lastLoginAt).toEqual(expect.any(String));

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.lastLoginAt).not.toBeNull();
  });
});
