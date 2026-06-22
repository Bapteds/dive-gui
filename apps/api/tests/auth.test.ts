// Auth endpoint tests: login, /me, refresh, logout (revocation).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  createProtectedAdmin,
  DEFAULT_PASSWORD,
  extractRefreshCookie,
  resetDatabase,
} from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with valid credentials, returns an access token + user, and sets the refresh cookie', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.accessToken.length).toBeGreaterThan(10);
    expect(res.body.user).toMatchObject({
      id: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      role: 'SUPER_ADMIN',
      isProtected: true,
    });
    // Secrets must never be serialized.
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.tokenVersion).toBeUndefined();

    const cookie = extractRefreshCookie(res.headers['set-cookie']);
    expect(cookie).toBeTruthy();

    // The refresh cookie must be httpOnly and path-scoped to the auth routes.
    const rawCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('Path=/api/v1/auth');
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: 'totally-wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('rejects an unknown email with the same 401 INVALID_CREDENTIALS message', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@dive-turbinen.test', password: DEFAULT_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('rejects a malformed body with 422 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 with the current user when a valid token is provided', async () => {
    const admin = await createProtectedAdmin();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(admin.id);
    expect(res.body.user.email).toBe(admin.email);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('returns 401 with a malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('issues a fresh access token from a valid refresh cookie', async () => {
    const admin = await createProtectedAdmin();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });

    const setCookie = login.headers['set-cookie'];

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', setCookie as unknown as string[]);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.id).toBe(admin.id);
  });

  it('returns 401 when no refresh cookie is present', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 204, clears the cookie, and revokes outstanding refresh tokens', async () => {
    const admin = await createProtectedAdmin();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: DEFAULT_PASSWORD });

    const accessToken = login.body.accessToken as string;
    const setCookie = login.headers['set-cookie'];

    // Logout with the access token.
    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(logout.status).toBe(204);

    // tokenVersion must have been bumped server-side.
    const refreshed = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(refreshed?.tokenVersion).toBe(1);

    // The OLD refresh token (issued at version 0) must now be rejected.
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', setCookie as unknown as string[]);

    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
