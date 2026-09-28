// Integration tests for saved chamber builds (/chamber/saves): named,
// team-shared snapshots of the POST /chamber/build body. Exercises auth, the
// shared list, snapshot validation (a save can never hold an unbuildable
// state), the unique-name 409, the author/super-admin management guard, and
// rename/overwrite/delete.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  authHeader,
  createProtectedAdmin,
  createTestUser,
  resetDatabase,
} from './helpers';

/** A minimal valid snapshot (mid-range inputs; everything else defaulted). */
const SNAPSHOT = { x1: 1450, x2: 7.85, x3: 8 };

describe('chamber saves', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/chamber/saves').expect(401);
    await request(app)
      .post('/api/v1/chamber/saves')
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(401);
  });

  it('creates a save and lists it for every user, with attribution', async () => {
    const author = await createTestUser();
    const other = await createTestUser({ email: 'other@dive-turbinen.test', fullName: 'Other' });

    const created = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', authHeader(author))
      .send({ name: '  Runner A  ', snapshot: SNAPSHOT })
      .expect(201);
    expect(created.body.save.name).toBe('Runner A'); // trimmed
    expect(created.body.save.owner).toEqual({ id: author.id, fullName: author.fullName });
    // The stored snapshot is the schema-normalized build body (defaults applied).
    expect(created.body.save.snapshot).toMatchObject({
      ...SNAPSHOT,
      variant: 'stepped',
      guideVanes: false,
      vaneAngleDeg: 50,
    });

    const list = await request(app)
      .get('/api/v1/chamber/saves')
      .set('Authorization', authHeader(other))
      .expect(200);
    expect(list.body.saves).toHaveLength(1);
    expect(list.body.saves[0].name).toBe('Runner A');
  });

  it('rejects a snapshot that could not build (schema-invalid)', async () => {
    const user = await createTestUser();
    await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', authHeader(user))
      .send({ name: 'Broken', snapshot: { ...SNAPSHOT, x1: -1 } })
      .expect(422);
    // The hollow variant requires hollowLength — same rule as /chamber/build.
    await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', authHeader(user))
      .send({ name: 'Broken hollow', snapshot: { ...SNAPSHOT, variant: 'hollow' } })
      .expect(422);
  });

  it('refuses a taken name with 409 (create and rename)', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(201);
    const second = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(409);
    expect(second.body.error.code).toBe('NAME_TAKEN');

    const b = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .send({ name: 'Runner B', snapshot: SNAPSHOT })
      .expect(201);
    const renamed = await request(app)
      .put(`/api/v1/chamber/saves/${b.body.save.id}`)
      .set('Authorization', auth)
      .send({ name: 'Runner A' })
      .expect(409);
    expect(renamed.body.error.code).toBe('NAME_TAKEN');
  });

  it('overwrites the snapshot and renames via PUT (author)', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const created = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(201);

    const updated = await request(app)
      .put(`/api/v1/chamber/saves/${created.body.save.id}`)
      .set('Authorization', auth)
      .send({ name: 'Runner A v2', snapshot: { ...SNAPSHOT, x1: 1500, guideVanes: true } })
      .expect(200);
    expect(updated.body.save.name).toBe('Runner A v2');
    expect(updated.body.save.snapshot).toMatchObject({ x1: 1500, guideVanes: true });

    // Rename-only PUT keeps the snapshot.
    const renamed = await request(app)
      .put(`/api/v1/chamber/saves/${created.body.save.id}`)
      .set('Authorization', auth)
      .send({ name: 'Runner A v3' })
      .expect(200);
    expect(renamed.body.save.snapshot).toMatchObject({ x1: 1500, guideVanes: true });
  });

  it('rejects an update with neither name nor snapshot', async () => {
    const user = await createTestUser();
    const created = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', authHeader(user))
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(201);
    await request(app)
      .put(`/api/v1/chamber/saves/${created.body.save.id}`)
      .set('Authorization', authHeader(user))
      .send({})
      .expect(422);
  });

  it('guards mutations: non-author 403, super-admin allowed, 404 unknown id', async () => {
    const author = await createTestUser();
    const other = await createTestUser({ email: 'other@dive-turbinen.test', fullName: 'Other' });
    const admin = await createProtectedAdmin();
    const created = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', authHeader(author))
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(201);
    const id = created.body.save.id;

    await request(app)
      .put(`/api/v1/chamber/saves/${id}`)
      .set('Authorization', authHeader(other))
      .send({ name: 'Hijacked' })
      .expect(403);
    await request(app)
      .delete(`/api/v1/chamber/saves/${id}`)
      .set('Authorization', authHeader(other))
      .expect(403);

    await request(app)
      .put(`/api/v1/chamber/saves/${id}`)
      .set('Authorization', authHeader(admin))
      .send({ name: 'Admin renamed' })
      .expect(200);
    await request(app)
      .delete(`/api/v1/chamber/saves/${id}`)
      .set('Authorization', authHeader(admin))
      .expect(204);

    await request(app)
      .delete(`/api/v1/chamber/saves/${id}`)
      .set('Authorization', authHeader(admin))
      .expect(404);
  });

  it('deletes a save (author) and the list reflects it', async () => {
    const user = await createTestUser();
    const auth = authHeader(user);
    const created = await request(app)
      .post('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .send({ name: 'Runner A', snapshot: SNAPSHOT })
      .expect(201);
    await request(app)
      .delete(`/api/v1/chamber/saves/${created.body.save.id}`)
      .set('Authorization', auth)
      .expect(204);
    const list = await request(app)
      .get('/api/v1/chamber/saves')
      .set('Authorization', auth)
      .expect(200);
    expect(list.body.saves).toHaveLength(0);
  });
});
