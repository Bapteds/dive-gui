// Integration tests for shared file templates: CRUD + ownership guards, template
// files (create/import/read/delete), and applying a template to a project's case
// (preview + conflict-resolved apply, gated by project visibility).
import { promises as fs } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';

/** Create a template via the API, returning its id. */
async function makeTemplate(auth: string, name = 'My template'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/templates')
    .set('Authorization', auth)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.template.id as string;
}

/** Populate a template with files (with content) via a .zip import. */
function importTemplateZip(
  id: string,
  auth: string,
  files: Array<{ path: string; data: string }>,
) {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.path, Buffer.from(f.data));
  return request(app)
    .post(`/api/v1/templates/${id}/files/import`)
    .set('Authorization', auth)
    .attach('archive', zip.toBuffer(), 'tpl.zip');
}

/** Populate a project's case with files (with content) via a .zip import. */
function importCaseZip(id: string, auth: string, files: Array<{ path: string; data: string }>) {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.path, Buffer.from(f.data));
  return request(app)
    .post(`/api/v1/projects/${id}/files/import`)
    .set('Authorization', auth)
    .attach('archive', zip.toBuffer(), 'case.zip');
}

/** Read a single case file's text content. */
async function readCaseContent(id: string, auth: string, path: string): Promise<string> {
  const res = await request(app)
    .get(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent(path)}`)
    .set('Authorization', auth);
  expect(res.status).toBe(200);
  return res.body.file.content as string;
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('templates CRUD + sharing', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/templates');
    expect(res.status).toBe(401);
  });

  it('creates a template and lists it for every user (shared, with author)', async () => {
    const author = await createTestUser({ email: 'author@dive-turbinen.test' });
    const other = await createTestUser({ email: 'other@dive-turbinen.test' });

    const id = await makeTemplate(authHeader(author), 'Steady RANS');

    const list = await request(app)
      .get('/api/v1/templates')
      .set('Authorization', authHeader(other));
    expect(list.status).toBe(200);
    const found = (list.body.templates as Array<{ id: string; owner: { email: string } }>).find(
      (t) => t.id === id,
    );
    expect(found).toBeTruthy();
    expect(found?.owner.email).toBe('author@dive-turbinen.test');
  });

  it('returns 404 for an unknown template', async () => {
    const user = await createTestUser();
    const res = await request(app)
      .get('/api/v1/templates/does-not-exist')
      .set('Authorization', authHeader(user));
    expect(res.status).toBe(404);
  });

  it('lets the author update, blocks a stranger, allows a super-admin', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 's@dive-turbinen.test' });
    const admin = await createProtectedAdmin();
    const id = await makeTemplate(authHeader(author));

    const byAuthor = await request(app)
      .patch(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(author))
      .send({ name: 'Renamed' });
    expect(byAuthor.status).toBe(200);
    expect(byAuthor.body.template.name).toBe('Renamed');

    const byStranger = await request(app)
      .patch(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(stranger))
      .send({ name: 'Hacked' });
    expect(byStranger.status).toBe(403);

    const byAdmin = await request(app)
      .patch(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(admin))
      .send({ description: 'curated' });
    expect(byAdmin.status).toBe(200);
  });

  it('lets the author delete but not a stranger', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 's@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));

    const byStranger = await request(app)
      .delete(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(stranger));
    expect(byStranger.status).toBe(403);

    const byAuthor = await request(app)
      .delete(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(author));
    expect(byAuthor.status).toBe(204);

    const after = await request(app)
      .get(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(author));
    expect(after.status).toBe(404);
  });
});

describe('template files', () => {
  it('creates a file (author), rejects a duplicate, blocks a stranger', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 's@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));

    const create = await request(app)
      .post(`/api/v1/templates/${id}/files/content`)
      .set('Authorization', authHeader(author))
      .send({ path: 'system/controlDict' });
    expect(create.status).toBe(201);
    expect(create.body.path).toBe('system/controlDict');

    const dup = await request(app)
      .post(`/api/v1/templates/${id}/files/content`)
      .set('Authorization', authHeader(author))
      .send({ path: 'system/controlDict' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('FILE_EXISTS');

    const byStranger = await request(app)
      .post(`/api/v1/templates/${id}/files/content`)
      .set('Authorization', authHeader(stranger))
      .send({ path: 'other' });
    expect(byStranger.status).toBe(403);
  });

  it('lets any authenticated user read a shared template\'s files', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const other = await createTestUser({ email: 'o@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));
    await importTemplateZip(id, authHeader(author), [{ path: 'system/controlDict', data: 'hello' }]);

    const list = await request(app)
      .get(`/api/v1/templates/${id}/files`)
      .set('Authorization', authHeader(other));
    expect(list.status).toBe(200);
    const paths = (list.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/controlDict');

    const content = await request(app)
      .get(`/api/v1/templates/${id}/files/content?path=system/controlDict`)
      .set('Authorization', authHeader(other));
    expect(content.status).toBe(200);
    expect(content.body.file.content).toBe('hello');
  });

  it('blocks a stranger from importing into a template', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 's@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));

    const res = await importTemplateZip(id, authHeader(stranger), [{ path: 'a', data: 'x' }]);
    expect(res.status).toBe(403);
  });

  it('returns 404 deleting a file that does not exist', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));
    const res = await request(app)
      .delete(`/api/v1/templates/${id}/files/content?path=nope`)
      .set('Authorization', authHeader(author));
    expect(res.status).toBe(404);
  });

  it('deletes a whole folder subtree (author)', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));
    await importTemplateZip(id, authHeader(author), [
      { path: '0/U', data: 'a' },
      { path: '0/p', data: 'b' },
      { path: 'system/controlDict', data: 'c' },
    ]);

    const res = await request(app)
      .delete(`/api/v1/templates/${id}/files/dir?path=0`)
      .set('Authorization', authHeader(author));
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).not.toContain('0/U');
    expect(paths).toContain('system/controlDict');
  });

  it('moves a file within a template (author)', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));
    await importTemplateZip(id, authHeader(author), [{ path: '0/U', data: 'x' }]);

    const res = await request(app)
      .post(`/api/v1/templates/${id}/files/move`)
      .set('Authorization', authHeader(author))
      .send({ from: '0/U', to: 'system/U' });
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/U');
    expect(paths).not.toContain('0/U');
  });

  it('blocks a stranger from moving or deleting a folder (403)', async () => {
    const author = await createTestUser({ email: 'a@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 's@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(author));
    await importTemplateZip(id, authHeader(author), [{ path: 'dir/file', data: 'x' }]);

    const move = await request(app)
      .post(`/api/v1/templates/${id}/files/move`)
      .set('Authorization', authHeader(stranger))
      .send({ from: 'dir/file', to: 'other/file' });
    expect(move.status).toBe(403);

    const del = await request(app)
      .delete(`/api/v1/templates/${id}/files/dir?path=dir`)
      .set('Authorization', authHeader(stranger));
    expect(del.status).toBe(403);
  });
});

describe('applying a template to a project', () => {
  it('previews conflicts and new files', async () => {
    const owner = await createTestUser({ email: 'owner@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    await importCaseZip(project.id, authHeader(owner), [
      { path: 'system/controlDict', data: 'CASE-ORIGINAL' },
    ]);

    const id = await makeTemplate(authHeader(owner));
    await importTemplateZip(id, authHeader(owner), [
      { path: 'system/controlDict', data: 'TPL-CONTROL' },
      { path: '0/U', data: 'TPL-U' },
    ]);

    const res = await request(app)
      .get(`/api/v1/projects/${project.id}/apply-template/${id}/preview`)
      .set('Authorization', authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.preview.conflicts).toEqual(['system/controlDict']);
    expect(res.body.preview.newFiles).toEqual(['0/U']);
  });

  it('keeps existing files by default and writes new ones', async () => {
    const owner = await createTestUser({ email: 'owner@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    await importCaseZip(project.id, authHeader(owner), [
      { path: 'system/controlDict', data: 'CASE-ORIGINAL' },
    ]);
    const id = await makeTemplate(authHeader(owner));
    await importTemplateZip(id, authHeader(owner), [
      { path: 'system/controlDict', data: 'TPL-CONTROL' },
      { path: '0/U', data: 'TPL-U' },
    ]);

    const apply = await request(app)
      .post(`/api/v1/projects/${project.id}/apply-template/${id}`)
      .set('Authorization', authHeader(owner))
      .send({});
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toEqual(['0/U']);
    expect(apply.body.skipped).toEqual(['system/controlDict']);

    expect(await readCaseContent(project.id, authHeader(owner), 'system/controlDict')).toBe(
      'CASE-ORIGINAL',
    );
    expect(await readCaseContent(project.id, authHeader(owner), '0/U')).toBe('TPL-U');
  });

  it('overwrites a conflicting file when the decision says so', async () => {
    const owner = await createTestUser({ email: 'owner@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    await importCaseZip(project.id, authHeader(owner), [
      { path: 'system/controlDict', data: 'CASE-ORIGINAL' },
    ]);
    const id = await makeTemplate(authHeader(owner));
    await importTemplateZip(id, authHeader(owner), [
      { path: 'system/controlDict', data: 'TPL-CONTROL' },
    ]);

    const apply = await request(app)
      .post(`/api/v1/projects/${project.id}/apply-template/${id}`)
      .set('Authorization', authHeader(owner))
      .send({ decisions: { 'system/controlDict': 'overwrite' } });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toEqual(['system/controlDict']);

    expect(await readCaseContent(project.id, authHeader(owner), 'system/controlDict')).toBe(
      'TPL-CONTROL',
    );
  });

  it('returns 404 when the viewer cannot see the project', async () => {
    const owner = await createTestUser({ email: 'owner@dive-turbinen.test' });
    const stranger = await createTestUser({ email: 'stranger@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    const id = await makeTemplate(authHeader(stranger));

    const res = await request(app)
      .get(`/api/v1/projects/${project.id}/apply-template/${id}/preview`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });

  it('lets a project collaborator apply a third party\'s template', async () => {
    const owner = await createTestUser({ email: 'owner@dive-turbinen.test' });
    const collaborator = await createTestUser({ email: 'collab@dive-turbinen.test' });
    const author = await createTestUser({ email: 'author@dive-turbinen.test' });

    const project = await prisma.project.create({
      data: {
        title: 'P',
        ownerId: owner.id,
        collaborators: { connect: { id: collaborator.id } },
      },
    });
    const id = await makeTemplate(authHeader(author));
    await importTemplateZip(id, authHeader(author), [{ path: '0/p', data: 'TPL-P' }]);

    const apply = await request(app)
      .post(`/api/v1/projects/${project.id}/apply-template/${id}`)
      .set('Authorization', authHeader(collaborator))
      .send({});
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toEqual(['0/p']);
    expect(await readCaseContent(project.id, authHeader(collaborator), '0/p')).toBe('TPL-P');
  });

  it('imports only the selected template files (per-file), overwriting the case', async () => {
    const owner = await createTestUser({ email: 'perfile@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    await importCaseZip(project.id, authHeader(owner), [
      { path: 'system/controlDict', data: 'CASE-ORIGINAL' },
    ]);
    const id = await makeTemplate(authHeader(owner));
    await importTemplateZip(id, authHeader(owner), [
      { path: 'system/controlDict', data: 'TPL-CONTROL' },
      { path: '0/U', data: 'TPL-U' },
      { path: '0/p', data: 'TPL-P' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/apply-template/${id}/files`)
      .set('Authorization', authHeader(owner))
      .send({ paths: ['0/U', 'system/controlDict', 'does/not/exist'] });
    expect(res.status).toBe(200);
    expect((res.body.applied as string[]).sort()).toEqual(['0/U', 'system/controlDict']);
    expect(res.body.skipped).toContain('does/not/exist');
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).not.toContain('0/p'); // not selected, so not imported

    // Selected files overwrite the case (the user picked them on purpose).
    expect(await readCaseContent(project.id, authHeader(owner), 'system/controlDict')).toBe(
      'TPL-CONTROL',
    );
    expect(await readCaseContent(project.id, authHeader(owner), '0/U')).toBe('TPL-U');
  });

  it('rejects a per-file import with an empty paths list', async () => {
    const owner = await createTestUser({ email: 'perfile-empty@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: owner.id } });
    const id = await makeTemplate(authHeader(owner));
    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/apply-template/${id}/files`)
      .set('Authorization', authHeader(owner))
      .send({ paths: [] });
    expect(res.status).toBe(422);
  });
});

describe('template tags + single-file create', () => {
  it('normalizes, dedupes and drops junk tags on create', async () => {
    const user = await createTestUser({ email: 'tags@dive-turbinen.test' });
    const res = await request(app)
      .post('/api/v1/templates')
      .set('Authorization', authHeader(user))
      .send({ name: 'Starter', tags: ['Steady RANS', 'steady rans', 'k-Omega!', '  '] });
    expect(res.status).toBe(201);
    expect(res.body.template.tags).toEqual(['steady-rans', 'k-omega']);
  });

  it('creates a single-file template with inline content', async () => {
    const user = await createTestUser({ email: 'onefile@dive-turbinen.test' });
    const res = await request(app)
      .post('/api/v1/templates')
      .set('Authorization', authHeader(user))
      .send({
        name: 'One file',
        tags: ['snippet'],
        file: { path: 'system/fvSolution', content: 'FoamFile { object fvSolution; }\n' },
      });
    expect(res.status).toBe(201);
    expect(res.body.template.tags).toEqual(['snippet']);
    const id = res.body.template.id as string;

    const files = await request(app)
      .get(`/api/v1/templates/${id}/files`)
      .set('Authorization', authHeader(user));
    const paths = (files.body.entries as Array<{ path: string; type: string }>)
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path);
    expect(paths).toContain('system/fvSolution');

    const content = await request(app)
      .get(`/api/v1/templates/${id}/files/content?path=system/fvSolution`)
      .set('Authorization', authHeader(user));
    expect(content.body.file.content).toMatch(/object fvSolution/);
  });

  it('updates tags and returns them from the list', async () => {
    const user = await createTestUser({ email: 'updtags@dive-turbinen.test' });
    const id = await makeTemplate(authHeader(user), 'T');

    const patched = await request(app)
      .patch(`/api/v1/templates/${id}`)
      .set('Authorization', authHeader(user))
      .send({ tags: ['MESH', 'mesh', 'inlet'] });
    expect(patched.status).toBe(200);
    expect(patched.body.template.tags).toEqual(['mesh', 'inlet']);

    const list = await request(app).get('/api/v1/templates').set('Authorization', authHeader(user));
    const found = (list.body.templates as Array<{ id: string; tags: string[] }>).find(
      (template) => template.id === id,
    );
    expect(found?.tags).toEqual(['mesh', 'inlet']);
  });
});
