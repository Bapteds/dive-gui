// Users back-office tests: CRUD plus the hard business rules.
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

describe('authorization', () => {
  it('rejects an unauthenticated request to /users with 401', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a normal USER hitting /users with 403 FORBIDDEN', async () => {
    await createProtectedAdmin();
    const normal = await createTestUser({ email: 'normal@dive-turbinen.test', role: 'USER' });

    const res = await request(app).get('/api/v1/users').set('Authorization', authHeader(normal));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/v1/users', () => {
  it('lists all users with the protected super-admin first', async () => {
    const admin = await createProtectedAdmin();
    await createTestUser({ email: 'b@dive-turbinen.test', fullName: 'Bravo' });
    await createTestUser({ email: 'c@dive-turbinen.test', fullName: 'Charlie' });

    const res = await request(app).get('/api/v1/users').set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users).toHaveLength(3);
    // Protected super-admin sorts first.
    expect(res.body.users[0].id).toBe(admin.id);
    expect(res.body.users[0].isProtected).toBe(true);
    // No secrets leak.
    for (const u of res.body.users) {
      expect(u.passwordHash).toBeUndefined();
      expect(u.tokenVersion).toBeUndefined();
    }
  });
});

describe('POST /api/v1/users', () => {
  it('creates a normal user and returns 201 with the public user', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', authHeader(admin))
      .send({
        fullName: 'New Operator',
        email: 'new@dive-turbinen.test',
        password: 'Brand-New-Pass1',
        role: 'USER',
      });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'new@dive-turbinen.test',
      fullName: 'New Operator',
      role: 'USER',
      isProtected: false,
    });
    expect(res.body.user.passwordHash).toBeUndefined();

    // The created account can actually log in.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'new@dive-turbinen.test', password: 'Brand-New-Pass1' });
    expect(login.status).toBe(200);
  });

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    const admin = await createProtectedAdmin();
    await createTestUser({ email: 'dupe@dive-turbinen.test' });

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', authHeader(admin))
      .send({
        fullName: 'Duplicate',
        email: 'dupe@dive-turbinen.test',
        password: 'Another-Pass-1',
        role: 'USER',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a short password with 422 VALIDATION_ERROR', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', authHeader(admin))
      .send({ fullName: 'Short', email: 'short@dive-turbinen.test', password: 'x', role: 'USER' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/users/:id', () => {
  it('returns a single user', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'one@dive-turbinen.test' });

    const res = await request(app)
      .get(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('returns 404 for an unknown id', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .get('/api/v1/users/does-not-exist')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/v1/users/:id', () => {
  it('updates a normal user (name, role, password)', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'edit@dive-turbinen.test', role: 'USER' });

    const res = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ fullName: 'Edited Name', role: 'SUPER_ADMIN', password: 'Changed-Pass-9' });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Edited Name');
    expect(res.body.user.role).toBe('SUPER_ADMIN');

    // New password works.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'edit@dive-turbinen.test', password: 'Changed-Pass-9' });
    expect(login.status).toBe(200);
  });

  it('rejects downgrading the protected super-admin role with 409 PROTECTED_ROLE', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set('Authorization', authHeader(admin))
      .send({ role: 'USER' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROTECTED_ROLE');
    expect(res.body.error.message).toBe('The super-admin role cannot be changed');
  });

  it('allows a no-op role update of the protected super-admin (role stays SUPER_ADMIN)', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set('Authorization', authHeader(admin))
      .send({ role: 'SUPER_ADMIN', fullName: 'Still Admin' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('SUPER_ADMIN');
    expect(res.body.user.fullName).toBe('Still Admin');
  });

  it('rejects changing an email to one already taken with 409 EMAIL_TAKEN', async () => {
    const admin = await createProtectedAdmin();
    const a = await createTestUser({ email: 'a@dive-turbinen.test' });
    await createTestUser({ email: 'taken@dive-turbinen.test' });

    const res = await request(app)
      .patch(`/api/v1/users/${a.id}`)
      .set('Authorization', authHeader(admin))
      .send({ email: 'taken@dive-turbinen.test' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects an empty PATCH body with 422 VALIDATION_ERROR', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'empty@dive-turbinen.test' });

    const res = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/v1/users/:id', () => {
  it('deletes a normal user and returns 204', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'gone@dive-turbinen.test' });

    const res = await request(app)
      .delete(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(204);
    const stillThere = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stillThere).toBeNull();
  });

  it('refuses to delete the protected super-admin with 409 PROTECTED_ACCOUNT', async () => {
    const admin = await createProtectedAdmin();
    // A second super-admin acts as the requester so this is not self-deletion.
    const otherAdmin = await createTestUser({
      email: 'other-admin@dive-turbinen.test',
      role: 'SUPER_ADMIN',
    });

    const res = await request(app)
      .delete(`/api/v1/users/${admin.id}`)
      .set('Authorization', authHeader(otherAdmin));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROTECTED_ACCOUNT');
    expect(res.body.error.message).toBe(
      'The super-admin account is permanent and cannot be deleted',
    );
  });

  it('refuses self-deletion with 409 SELF_DELETE_FORBIDDEN', async () => {
    // A non-protected super-admin deleting themselves must still be blocked by
    // the self-delete rule (proving the rule is independent of protection).
    const selfAdmin = await createTestUser({
      email: 'self@dive-turbinen.test',
      role: 'SUPER_ADMIN',
      isProtected: false,
    });

    const res = await request(app)
      .delete(`/api/v1/users/${selfAdmin.id}`)
      .set('Authorization', authHeader(selfAdmin));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_DELETE_FORBIDDEN');
    expect(res.body.error.message).toBe('You cannot delete your own account');
  });

  it('returns 404 when deleting an unknown id', async () => {
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .delete('/api/v1/users/nope')
      .set('Authorization', authHeader(admin));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/v1/users/:id session revocation', () => {
  it("revokes the target's sessions when their password is reset", async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'reset@dive-turbinen.test', role: 'USER' });

    // The user signs in (refresh token issued at tokenVersion 0).
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: DEFAULT_PASSWORD });
    const userCookie = login.headers['set-cookie'] as unknown as string[];

    // The admin resets the user's password from the back office.
    const patch = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ password: 'Admin-Reset-1' });
    expect(patch.status).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.tokenVersion).toBe(1);

    // The user's pre-existing refresh token is now rejected.
    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', userCookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('revokes sessions when the role is actually changed', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'promote@dive-turbinen.test', role: 'USER' });

    const patch = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ role: 'SUPER_ADMIN' });
    expect(patch.status).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.tokenVersion).toBe(1);
  });

  it('does NOT revoke sessions for a name-only update', async () => {
    const admin = await createProtectedAdmin();
    const user = await createTestUser({ email: 'rename@dive-turbinen.test', role: 'USER' });

    const patch = await request(app)
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', authHeader(admin))
      .send({ fullName: 'Just A Rename' });
    expect(patch.status).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed?.tokenVersion).toBe(0);
  });

  it('does NOT revoke sessions for a no-op role write (super-admin stays SUPER_ADMIN)', async () => {
    const admin = await createProtectedAdmin();

    const patch = await request(app)
      .patch(`/api/v1/users/${admin.id}`)
      .set('Authorization', authHeader(admin))
      .send({ role: 'SUPER_ADMIN', fullName: 'Still Admin' });
    expect(patch.status).toBe(200);

    const refreshed = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(refreshed?.tokenVersion).toBe(0);
  });
});

// Sanity check that DEFAULT_PASSWORD is exported and used (keeps lint happy and
// documents the fixture password contract for readers of this file).
describe('fixture sanity', () => {
  it('uses a default password that satisfies the create schema minimum', () => {
    expect(DEFAULT_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });
});
