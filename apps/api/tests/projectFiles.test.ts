// Integration tests for project case files: import (folder + zip), tree
// listing, verification, scaffolding, download, and access control.
import { promises as fs } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
)
`;

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ userId: string; auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { userId: user.id, auth: authHeader(user), id: project.id };
}

/**
 * Build a raw multipart body. superagent's `.attach()` basenames the part
 * filename, which would strip the relative path a folder upload carries; the
 * browser (and busboy with preservePath) keep it. We craft the body by hand so
 * the tests exercise the real directory-preserving behavior.
 */
function buildMultipart(parts: Array<{ field: string; filename: string; data: Buffer | string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----DiveTestBoundary7MA4YWxkTrZu0gW';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data);
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
    );
    chunks.push(data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Import a folder (files carrying relative paths) via a raw multipart body. */
function importFolder(
  id: string,
  auth: string,
  files: Array<{ relativePath: string; data: Buffer | string }>,
) {
  const { body, contentType } = buildMultipart(
    files.map((f) => ({ field: 'files', filename: f.relativePath, data: f.data })),
  );
  return request(app)
    .post(`/api/v1/projects/${id}/files/import`)
    .set('Authorization', auth)
    .set('Content-Type', contentType)
    .send(body);
}

beforeEach(async () => {
  await resetDatabase();
  // Each test starts from an empty, isolated storage tree.
  await fs.rm('./test-storage', { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('GET /projects/:id/files', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('a@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/files`);
    expect(res.status).toBe(401);
  });

  it('returns an empty tree for a project with no imports', async () => {
    const { id, auth } = await makeProject('b@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/files`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'stranger@dive-turbinen.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${id}/files`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/files/import (folder)', () => {
  it('imports a bare polyMesh folder under constant/polyMesh/', async () => {
    const { id, auth } = await makeProject('c@dive-turbinen.test');
    const res = await importFolder(id, auth, [
      { relativePath: 'polyMesh/points', data: 'points data' },
      { relativePath: 'polyMesh/boundary', data: BOUNDARY },
    ]);

    expect(res.status).toBe(201);
    expect(res.body.written).toEqual(
      expect.arrayContaining(['constant/polyMesh/points', 'constant/polyMesh/boundary']),
    );
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('constant/polyMesh/points');
  });

  it('rejects an import with no files (400 NO_FILES_UPLOADED)', async () => {
    const { id, auth } = await makeProject('d@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/import`)
      .set('Authorization', auth)
      .field('note', 'nothing attached');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILES_UPLOADED');
  });
});

describe('POST /projects/:id/files/import (zip)', () => {
  it('extracts a .zip archive into the case tree', async () => {
    const { id, auth } = await makeProject('e@dive-turbinen.test');
    const zip = new AdmZip();
    zip.addFile('polyMesh/points', Buffer.from('points'));
    zip.addFile('polyMesh/boundary', Buffer.from(BOUNDARY));

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/import`)
      .set('Authorization', auth)
      .attach('archive', zip.toBuffer(), 'mesh.zip');

    expect(res.status).toBe(201);
    expect(res.body.written).toEqual(
      expect.arrayContaining(['constant/polyMesh/points', 'constant/polyMesh/boundary']),
    );
  });

  it('rejects a zip containing a traversal path (400 INVALID_ARCHIVE)', async () => {
    const { id, auth } = await makeProject('f@dive-turbinen.test');
    const zip = new AdmZip();
    // adm-zip normalizes `../` away on add, so force the malicious entry name
    // directly (this is exactly the zip-slip payload the server must refuse).
    zip.addFile('placeholder.txt', Buffer.from('pwned'));
    zip.getEntries()[0].entryName = '../../evil.txt';

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/import`)
      .set('Authorization', auth)
      .attach('archive', zip.toBuffer(), 'evil.zip');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ARCHIVE');
  });
});

describe('DELETE /projects/:id/files (reset)', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('reset-auth@dive-turbinen.test');
    const res = await request(app).delete(`/api/v1/projects/${id}/files`);
    expect(res.status).toBe(401);
  });

  it('removes all imported files and returns an empty tree', async () => {
    const { id, auth } = await makeProject('reset@dive-turbinen.test');
    await importFolder(id, auth, [
      { relativePath: 'polyMesh/points', data: 'points' },
      { relativePath: 'polyMesh/boundary', data: BOUNDARY },
    ]);

    const reset = await request(app).delete(`/api/v1/projects/${id}/files`).set('Authorization', auth);
    expect(reset.status).toBe(200);
    expect(reset.body.entries).toEqual([]);

    const tree = await request(app).get(`/api/v1/projects/${id}/files`).set('Authorization', auth);
    expect(tree.body.entries).toEqual([]);
  });
});

describe('GET /projects/:id/files/verify', () => {
  it('reports every mandatory file missing for an empty case', async () => {
    const { id, auth } = await makeProject('g@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/verify`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.verification.complete).toBe(false);
    expect(res.body.verification.canScaffold).toBe(true);
    expect(res.body.verification.hasMesh).toBe(false);
    expect(res.body.verification.missingBase).toEqual(
      expect.arrayContaining(['system/controlDict', 'system/fvSchemes', '0/U', '0/p']),
    );
  });
});

describe('POST /projects/:id/files/scaffold', () => {
  it('creates the missing base files and reports the case complete', async () => {
    const { id, auth } = await makeProject('h@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/scaffold`)
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    expect(res.body.created).toEqual(
      expect.arrayContaining([
        'system/controlDict',
        'system/fvSchemes',
        'system/fvSolution',
        '0/U',
        '0/p',
      ]),
    );
    expect(res.body.verification.complete).toBe(true);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/controlDict');
  });

  it('does not overwrite a base file that already exists', async () => {
    const { id, auth } = await makeProject('i@dive-turbinen.test');
    // Import an existing controlDict with a sentinel value.
    await importFolder(id, auth, [{ relativePath: 'system/controlDict', data: 'SENTINEL' }]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/scaffold`)
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    expect(res.body.created).not.toContain('system/controlDict');

    // The original content survives (verified via the downloaded archive).
    const download = await request(app)
      .get(`/api/v1/projects/${id}/files/download`)
      .set('Authorization', auth)
      .buffer(true)
      .parse((res2, cb) => {
        const chunks: Buffer[] = [];
        res2.on('data', (c: Buffer) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const zip = new AdmZip(download.body as Buffer);
    expect(zip.getEntry('system/controlDict')?.getData().toString()).toBe('SENTINEL');
  });
});

describe('GET /projects/:id/files/download', () => {
  it('returns 404 when there is nothing to download', async () => {
    const { id, auth } = await makeProject('j@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/download`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('returns a zip after files are imported', async () => {
    const { id, auth } = await makeProject('k@dive-turbinen.test');
    await importFolder(id, auth, [{ relativePath: 'polyMesh/points', data: 'points' }]);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/download`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
  });
});

describe('access control for case files', () => {
  it('lets a collaborator import and a super-admin verify', async () => {
    const { id, auth } = await makeProject('l@dive-turbinen.test');
    const collaborator = await createTestUser({ email: 'collab@dive-turbinen.test' });
    await prisma.project.update({
      where: { id },
      data: { collaborators: { connect: { id: collaborator.id } } },
    });
    const admin = await createProtectedAdmin();

    const importRes = await importFolder(id, authHeader(collaborator), [
      { relativePath: 'polyMesh/points', data: 'points' },
    ]);
    expect(importRes.status).toBe(201);

    const verifyRes = await request(app)
      .get(`/api/v1/projects/${id}/files/verify`)
      .set('Authorization', authHeader(admin));
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verification.hasMesh).toBe(false);

    // Owner auth still works too.
    const treeRes = await request(app)
      .get(`/api/v1/projects/${id}/files`)
      .set('Authorization', auth);
    expect(treeRes.status).toBe(200);
  });
});

describe('GET /projects/:id/files/content', () => {
  it('returns the text content of an imported file', async () => {
    const { id, auth } = await makeProject('m@dive-turbinen.test');
    await importFolder(id, auth, [{ relativePath: 'system/controlDict', data: 'application foamRun;' }]);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=system/controlDict`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.file).toMatchObject({ path: 'system/controlDict', content: 'application foamRun;' });
  });

  it('returns 404 for a file that does not exist', async () => {
    const { id, auth } = await makeProject('n@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=system/missing`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('rejects a traversal path with 400', async () => {
    const { id, auth } = await makeProject('o@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent('../../secret')}`)
      .set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('refuses to open a file larger than the editable cap (413)', async () => {
    const { id, auth } = await makeProject('p@dive-turbinen.test');
    // 2 MB + 1 byte exceeds EDITABLE_FILE_MAX_BYTES.
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    await importFolder(id, auth, [{ relativePath: 'constant/polyMesh/points', data: big }]);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=constant/polyMesh/points`)
      .set('Authorization', auth);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('PUT /projects/:id/files/content', () => {
  it('saves edited content to an existing file', async () => {
    const { id, auth } = await makeProject('q@dive-turbinen.test');
    await importFolder(id, auth, [{ relativePath: 'system/controlDict', data: 'old;' }]);

    const put = await request(app)
      .put(`/api/v1/projects/${id}/files/content?path=system/controlDict`)
      .set('Authorization', auth)
      .set('Content-Type', 'text/plain')
      .send('application simpleFoam;\nendTime 500;\n');
    expect(put.status).toBe(200);

    const read = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=system/controlDict`)
      .set('Authorization', auth);
    expect(read.body.file.content).toBe('application simpleFoam;\nendTime 500;\n');
  });

  it('returns 404 when saving to a file that does not exist', async () => {
    const { id, auth } = await makeProject('r@dive-turbinen.test');
    const res = await request(app)
      .put(`/api/v1/projects/${id}/files/content?path=system/controlDict`)
      .set('Authorization', auth)
      .set('Content-Type', 'text/plain')
      .send('content');
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/files/content (create)', () => {
  it('creates a new empty file and returns the refreshed tree', async () => {
    const { id, auth } = await makeProject('create-ok@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/content`)
      .set('Authorization', auth)
      .send({ path: 'system/myDict' });

    expect(res.status).toBe(201);
    expect(res.body.path).toBe('system/myDict');
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/myDict');

    // The created file is readable and empty.
    const read = await request(app)
      .get(`/api/v1/projects/${id}/files/content?path=system/myDict`)
      .set('Authorization', auth);
    expect(read.status).toBe(200);
    expect(read.body.file.content).toBe('');
  });

  it('rejects creating a file that already exists (409 FILE_EXISTS)', async () => {
    const { id, auth } = await makeProject('create-dup@dive-turbinen.test');
    await importFolder(id, auth, [{ relativePath: 'system/controlDict', data: 'x' }]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/content`)
      .set('Authorization', auth)
      .send({ path: 'system/controlDict' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_EXISTS');
  });

  it('rejects a blank path with 422', async () => {
    const { id, auth } = await makeProject('create-blank@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/content`)
      .set('Authorization', auth)
      .send({ path: '   ' });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /projects/:id/files/content (single file)', () => {
  it('deletes an existing file and returns the refreshed tree', async () => {
    const { id, auth } = await makeProject('del-ok@dive-turbinen.test');
    await importFolder(id, auth, [
      { relativePath: 'system/controlDict', data: 'a' },
      { relativePath: 'system/fvSchemes', data: 'b' },
    ]);

    const res = await request(app)
      .delete(`/api/v1/projects/${id}/files/content?path=system/controlDict`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).not.toContain('system/controlDict');
    expect(paths).toContain('system/fvSchemes');
  });

  it('returns 404 deleting a file that does not exist', async () => {
    const { id, auth } = await makeProject('del-missing@dive-turbinen.test');
    const res = await request(app)
      .delete(`/api/v1/projects/${id}/files/content?path=system/nope`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('rejects a traversal path with 400', async () => {
    const { id, auth } = await makeProject('del-traversal@dive-turbinen.test');
    const res = await request(app)
      .delete(
        `/api/v1/projects/${id}/files/content?path=${encodeURIComponent('../../secret')}`,
      )
      .set('Authorization', auth);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /projects/:id/files/dir (folder)', () => {
  it('deletes a whole folder subtree and returns the refreshed tree', async () => {
    const { id, auth } = await makeProject('deldir-ok@dive-turbinen.test');
    await importFolder(id, auth, [
      { relativePath: '0/U', data: 'a' },
      { relativePath: '0/p', data: 'b' },
      { relativePath: 'system/controlDict', data: 'c' },
    ]);

    const res = await request(app)
      .delete(`/api/v1/projects/${id}/files/dir?path=0`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).not.toContain('0');
    expect(paths).not.toContain('0/U');
    expect(paths).toContain('system/controlDict');
  });

  it('returns 404 deleting a folder that does not exist', async () => {
    const { id, auth } = await makeProject('deldir-missing@dive-turbinen.test');
    const res = await request(app)
      .delete(`/api/v1/projects/${id}/files/dir?path=nope`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/files/move', () => {
  it('moves a file to a new path and returns the refreshed tree', async () => {
    const { id, auth } = await makeProject('move-file@dive-turbinen.test');
    await importFolder(id, auth, [{ relativePath: '0/U', data: 'x' }]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/move`)
      .set('Authorization', auth)
      .send({ from: '0/U', to: 'system/U' });
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/U');
    expect(paths).not.toContain('0/U');
    // The now-empty source folder is pruned.
    expect(paths).not.toContain('0');
  });

  it('moves a whole folder, carrying its contents', async () => {
    const { id, auth } = await makeProject('move-dir@dive-turbinen.test');
    // The top-level `keep.txt` sibling stops the case importer from stripping
    // `src` as a common wrapper folder, so it survives as a real directory.
    await importFolder(id, auth, [
      { relativePath: 'src/a', data: '1' },
      { relativePath: 'src/sub/b', data: '2' },
      { relativePath: 'keep.txt', data: '0' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/move`)
      .set('Authorization', auth)
      .send({ from: 'src', to: 'dst' });
    expect(res.status).toBe(200);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['dst', 'dst/a', 'dst/sub', 'dst/sub/b']));
    expect(paths).not.toContain('src');
  });

  it('rejects moving onto an existing path (409 FILE_EXISTS)', async () => {
    const { id, auth } = await makeProject('move-conflict@dive-turbinen.test');
    await importFolder(id, auth, [
      { relativePath: 'a.txt', data: '1' },
      { relativePath: 'b.txt', data: '2' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/move`)
      .set('Authorization', auth)
      .send({ from: 'a.txt', to: 'b.txt' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_EXISTS');
  });

  it('rejects moving a folder into itself (400)', async () => {
    const { id, auth } = await makeProject('move-self@dive-turbinen.test');
    // `keep.txt` keeps `dir` from being stripped as a wrapper on import.
    await importFolder(id, auth, [
      { relativePath: 'dir/file', data: '1' },
      { relativePath: 'keep.txt', data: '0' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/move`)
      .set('Authorization', auth)
      .send({ from: 'dir', to: 'dir/inner' });
    expect(res.status).toBe(400);
  });

  it('returns 404 moving a source that does not exist', async () => {
    const { id, auth } = await makeProject('move-missing@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/move`)
      .set('Authorization', auth)
      .send({ from: 'ghost', to: 'elsewhere' });
    expect(res.status).toBe(404);
  });
});
