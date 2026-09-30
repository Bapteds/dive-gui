// Mesh origin (WS-I spec §4): the case mesh records which meshing session it came
// from when it is sent with POST /projects/:id/mesh/from-meshing (case target),
// any other case-mesh replacement clears the record, a chamber import stamps the
// session with its chamber hash, and a chamber build keeps its ChamberInput next
// to params.json (metadata only, never part of the hash). No external tool runs:
// the session mesh is written straight to disk and the chamber builder is faked.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';
import { createSession, readMeta, sessionPolyMeshDir } from '../src/lib/meshingStorage';
import { chamberPaths } from '../src/lib/chamberStorage';
import { storageRoot } from '../src/lib/fileTreeStorage';
import { setCommandRunner, type CommandRunner } from '../src/lib/commandRunner';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 1; startFace 0; }
    walls { type wall; nFaces 5; startFace 1; }
)
`;

const MESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'] as const;

async function makeMeshedSession(name: string): Promise<string> {
  const meta = await createSession(name, 'cfmesh');
  const dir = sessionPolyMeshDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  for (const file of MESH_FILES) {
    await fs.writeFile(path.join(dir, file), file === 'boundary' ? BOUNDARY : `${file}-data`);
  }
  return meta.id;
}

async function makeProject(): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email: 'origin@dive-turbinen.test' });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

function originFile(projectId: string): string {
  return path.join(storageRoot(), 'projects', projectId, 'mesh-origin.json');
}

function asciiSolid(name: string): string {
  return [
    `solid ${name}`,
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    `endsolid ${name}`,
  ].join('\n');
}

beforeEach(async () => {
  await resetDatabase();
});
afterEach(() => setCommandRunner(null));

describe('Mesh origin', () => {
  it('is written by from-meshing (case target) and served by GET /mesh-origin', async () => {
    const { auth, id } = await makeProject();
    const sessionId = await makeMeshedSession('Origin session');

    const empty = await request(app).get(`/api/v1/projects/${id}/mesh-origin`).set('Authorization', auth);
    expect(empty.status).toBe(200);
    expect(empty.body.origin).toBeNull();

    await request(app)
      .post(`/api/v1/projects/${id}/mesh/from-meshing`)
      .set('Authorization', auth)
      .send({ sessionId, target: 'case' })
      .expect(200);

    const res = await request(app).get(`/api/v1/projects/${id}/mesh-origin`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.origin).toMatchObject({
      sessionId,
      sessionName: 'Origin session',
      engine: 'cfmesh',
      chamberHash: null,
    });
    expect(typeof res.body.origin.at).toBe('string');
  });

  it('is not written by a library send', async () => {
    const { auth, id } = await makeProject();
    const sessionId = await makeMeshedSession('Lib session');
    await request(app)
      .post(`/api/v1/projects/${id}/mesh/from-meshing`)
      .set('Authorization', auth)
      .send({ sessionId, target: 'library' })
      .expect(200);
    const res = await request(app).get(`/api/v1/projects/${id}/mesh-origin`).set('Authorization', auth);
    expect(res.body.origin).toBeNull();
  });

  it('is cleared by another case-mesh replacement (case import, reset)', async () => {
    const { auth, id } = await makeProject();
    const sessionId = await makeMeshedSession('Cleared session');
    await request(app)
      .post(`/api/v1/projects/${id}/mesh/from-meshing`)
      .set('Authorization', auth)
      .send({ sessionId, target: 'case' })
      .expect(200);
    await expect(fs.stat(originFile(id))).resolves.toBeTruthy();

    // A case import (folder upload) replaces the mesh: the origin is stale.
    const boundary = '----diveOriginTest';
    const multipart = Buffer.from(
      `--${boundary}
Content-Disposition: form-data; name="files"; filename="polyMesh/boundary"
` +
        `Content-Type: application/octet-stream

${BOUNDARY}
--${boundary}--
`,
    );
    await request(app)
      .post(`/api/v1/projects/${id}/files/import`)
      .set('Authorization', auth)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(multipart)
      .expect(201);
    const afterImport = await request(app)
      .get(`/api/v1/projects/${id}/mesh-origin`)
      .set('Authorization', auth);
    expect(afterImport.body.origin).toBeNull();

    // Reset clears it too.
    await request(app)
      .post(`/api/v1/projects/${id}/mesh/from-meshing`)
      .set('Authorization', auth)
      .send({ sessionId, target: 'case' })
      .expect(200);
    await request(app).delete(`/api/v1/projects/${id}/files`).set('Authorization', auth).expect(200);
    const afterReset = await request(app)
      .get(`/api/v1/projects/${id}/mesh-origin`)
      .set('Authorization', auth);
    expect(afterReset.body.origin).toBeNull();
  });

  it('answers 404 for a stranger', async () => {
    const { id } = await makeProject();
    const stranger = await createTestUser({ email: 'stranger@dive-turbinen.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${id}/mesh-origin`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });

  it('carries the chamber hash of a session filled from a chamber build', async () => {
    const { auth, id } = await makeProject();
    const zip = new AdmZip();
    zip.addFile('inlet.stl', Buffer.from(asciiSolid('inlet')));
    zip.addFile('walls.stl', Buffer.from(asciiSolid('walls')));
    const { exportsDir } = chamberPaths('abcdabcdabcdabcd');
    await fs.mkdir(exportsDir, { recursive: true });
    await fs.writeFile(path.join(exportsDir, 'trisurface.zip'), zip.toBuffer());

    const created = await request(app)
      .post('/api/v1/meshing/from-chamber')
      .set('Authorization', auth)
      .send({ mode: 'new', chamberHash: 'abcdabcdabcdabcd', name: 'Chamber mesh', engine: 'cfmesh' })
      .expect(201);
    const sessionId = created.body.session.id as string;
    expect((await readMeta(sessionId))?.origin).toEqual({ chamberHash: 'abcdabcdabcdabcd' });

    // Mesh it (straight to disk) and send it to the case: the origin keeps the hash.
    const dir = sessionPolyMeshDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    for (const file of MESH_FILES) {
      await fs.writeFile(path.join(dir, file), file === 'boundary' ? BOUNDARY : `${file}-data`);
    }
    await writeCaseFile(id, 'system/controlDict', 'user-controlDict');
    await request(app)
      .post(`/api/v1/projects/${id}/mesh/from-meshing`)
      .set('Authorization', auth)
      .send({ sessionId, target: 'case' })
      .expect(200);
    const res = await request(app).get(`/api/v1/projects/${id}/mesh-origin`).set('Authorization', auth);
    expect(res.body.origin.chamberHash).toBe('abcdabcdabcdabcd');
  });
});

describe('Chamber build input.json', () => {
  const successRunner: CommandRunner = async (spec) => {
    const outDir = spec.args[2];
    await fs.mkdir(path.join(outDir, 'exports'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'chamber.glb'), Buffer.from('glTF-fake'));
    await fs.writeFile(path.join(outDir, 'manifest.json'), '[]');
    return { command: spec.command, args: spec.args, exitCode: 0, stdout: 'OK:', stderr: '', durationMs: 1, timedOut: false };
  };

  it('writes the ChamberInput next to params.json without changing the hash', async () => {
    await fs.rm(path.join(storageRoot(), 'chamber'), { recursive: true, force: true });
    const auth = authHeader(await createTestUser());
    setCommandRunner(successRunner);
    const body = { x1: 1450, x2: 7.85, x3: 8 };
    const res = await request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(body);
    expect(res.status).toBe(200);
    const hash = res.body.hash;
    expect(typeof hash).toBe('string');
    const dir = chamberPaths(hash).dir;
    const input = JSON.parse(await fs.readFile(path.join(dir, 'input.json'), 'utf8'));
    expect(input).toMatchObject(body);
    const params = JSON.parse(await fs.readFile(path.join(dir, 'params.json'), 'utf8'));
    expect(params).not.toHaveProperty('input');

    // A second identical build is a cache hit with the same key.
    const again = await request(app).post('/api/v1/chamber/build').set('Authorization', auth).send(body);
    expect(again.body.hash).toBe(hash);
  });
});
