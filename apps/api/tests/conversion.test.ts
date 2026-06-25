// Integration tests for CGNS upload and the CGNS -> OpenFOAM conversion
// pipeline. The external toolchain (python3 + VTK, plus OpenFOAM utilities) is
// not installed in CI / on a dev box, so the command runner is swapped for a
// fake that simulates each step (and writes the files the real tools would),
// letting us exercise the full orchestration: template application, base-file
// scaffolding, step ordering, short-circuit on failure, and the refreshed case.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { writeTemplateFile } from '../src/lib/templateStorage';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
)
`;

const MESH_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'] as const;

/** Build a success CommandResult for a spec. */
function ok(spec: { command: string; args: string[] }, stdout: string): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/**
 * A fake runner that simulates the whole toolchain succeeding, writing the same
 * artefacts the real tools would: python3 writes the VTK; vtkUnstructuredToFoam
 * writes constant/polyMesh; checkMesh just reports.
 */
const successRunner: CommandRunner = async (spec) => {
  if (spec.command === 'python3') {
    const vtkAbs = spec.args[2];
    await fs.mkdir(path.dirname(vtkAbs), { recursive: true });
    await fs.writeFile(vtkAbs, '# vtk DataFile Version 2.0\nfake\n');
    return ok(spec, `OK: VTK written -> ${vtkAbs}`);
  }
  if (spec.command === 'vtkUnstructuredToFoam') {
    const caseDir = spec.args[1]; // ['-case', <dir>, <vtk>]
    const polyMesh = path.join(caseDir, 'constant', 'polyMesh');
    await fs.mkdir(polyMesh, { recursive: true });
    for (const name of MESH_FILES) {
      await fs.writeFile(path.join(polyMesh, name), name === 'boundary' ? BOUNDARY : `${name}-data`);
    }
    return ok(spec, 'Foam mesh written');
  }
  if (spec.command === 'checkMesh') {
    return ok(spec, 'Mesh stats ...\nMesh OK.\n');
  }
  return ok(spec, '');
};

/** A fake runner that fails on the very first step (python3) and writes nothing. */
const failFirstRunner: CommandRunner = async (spec) => {
  if (spec.command === 'python3') {
    return {
      command: spec.command,
      args: spec.args,
      exitCode: 1,
      stdout: '',
      stderr: 'KO: VTK not created. CGNS read likely failed.',
      durationMs: 1,
      timedOut: false,
    };
  }
  return ok(spec, '');
};

/** A fake runner that simulates a missing binary at step 1 (ENOENT). */
const missingBinaryRunner: CommandRunner = async (spec) => {
  if (spec.command === 'python3') {
    return {
      command: spec.command,
      args: spec.args,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      spawnError: 'ENOENT: spawn python3 ENOENT',
    };
  }
  return ok(spec, '');
};

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ userId: string; auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { userId: user.id, auth: authHeader(user), id: project.id };
}

/** Create a shared template owned by `ownerId`, optionally with files. */
async function makeTemplate(
  ownerId: string,
  files: Array<{ path: string; content: string }> = [],
): Promise<string> {
  const template = await prisma.template.create({ data: { name: 'Steady RANS', ownerId } });
  for (const file of files) {
    await writeTemplateFile(template.id, file.path, file.content);
  }
  return template.id;
}

/** Upload a CGNS file to a project. */
function uploadCgns(id: string, auth: string, name: string, data: Buffer | string) {
  return request(app)
    .post(`/api/v1/projects/${id}/cgns`)
    .set('Authorization', auth)
    .attach('file', Buffer.from(data), name);
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setCommandRunner(successRunner);
});

afterEach(() => {
  setCommandRunner(null); // restore the real runner
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('POST /projects/:id/cgns (upload)', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('cg-auth@dive-turbinen.test');
    const res = await request(app).post(`/api/v1/projects/${id}/cgns`).attach('file', Buffer.from('x'), 'a.cgns');
    expect(res.status).toBe(401);
  });

  it('stores a .cgns upload and lists it', async () => {
    const { id, auth } = await makeProject('cg-ok@dive-turbinen.test');
    const res = await uploadCgns(id, auth, 'rotor.cgns', 'CGNS-bytes');
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ name: 'rotor.cgns' });
    expect(res.body.files).toHaveLength(1);

    const list = await request(app).get(`/api/v1/projects/${id}/cgns`).set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.files.map((f: { name: string }) => f.name)).toEqual(['rotor.cgns']);
  });

  it('rejects a non-.cgns file (400 INVALID_CGNS)', async () => {
    const { id, auth } = await makeProject('cg-bad@dive-turbinen.test');
    const res = await uploadCgns(id, auth, 'mesh.vtk', 'not cgns');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CGNS');
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('cg-owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'cg-stranger@dive-turbinen.test' });
    const res = await uploadCgns(id, authHeader(stranger), 'rotor.cgns', 'x');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /projects/:id/cgns', () => {
  it('removes a CGNS file', async () => {
    const { id, auth } = await makeProject('cg-del@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'x');

    const res = await request(app)
      .delete(`/api/v1/projects/${id}/cgns?name=rotor.cgns`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it('returns 404 deleting a CGNS file that does not exist', async () => {
    const { id, auth } = await makeProject('cg-del-missing@dive-turbinen.test');
    const res = await request(app)
      .delete(`/api/v1/projects/${id}/cgns?name=ghost.cgns`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/cgns/convert', () => {
  it('runs the full pipeline and writes the mesh (success)', async () => {
    const { id, auth, userId } = await makeProject('cv-ok@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    // Template already provides system/controlDict, so no scaffold is needed.
    const templateId = await makeTemplate(userId, [
      { path: 'system/controlDict', content: 'application foamRun;' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns', templateId });

    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(true);
    expect(result.steps.map((s: { id: string }) => s.id)).toEqual([
      'cgnsToVtk',
      'vtkToFoam',
      'checkMesh',
    ]);
    expect(result.steps.every((s: { status: string }) => s.status === 'success')).toBe(true);
    expect(result.verification.hasMesh).toBe(true);
    const paths = (result.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('constant/polyMesh/points');
    expect(paths).toContain('system/controlDict');
    // checkMesh output is surfaced.
    expect(result.steps[2].stdout).toContain('Mesh OK.');
    // The note records the applied template.
    expect(result.notes.join(' ')).toContain('Applied template');
  });

  it('scaffolds the minimal base files when the template lacks controlDict', async () => {
    const { id, auth, userId } = await makeProject('cv-scaffold@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    const templateId = await makeTemplate(userId, []); // empty template

    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns', templateId });

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.notes.join(' ')).toContain('Generated minimal base files');
    const paths = (res.body.result.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('system/controlDict');
    expect(paths).toContain('constant/polyMesh/points');
  });

  it('short-circuits and reports a failed first step (no mesh)', async () => {
    setCommandRunner(failFirstRunner);
    const { id, auth, userId } = await makeProject('cv-fail@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    const templateId = await makeTemplate(userId, [
      { path: 'system/controlDict', content: 'application foamRun;' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns', templateId });

    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(false);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[1].status).toBe('skipped');
    expect(result.steps[2].status).toBe('skipped');
    expect(result.verification.hasMesh).toBe(false);
  });

  it('reports a missing binary as a failed step (spawnError surfaced)', async () => {
    setCommandRunner(missingBinaryRunner);
    const { id, auth, userId } = await makeProject('cv-missing-bin@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    const templateId = await makeTemplate(userId, [
      { path: 'system/controlDict', content: 'application foamRun;' },
    ]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns', templateId });

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(false);
    expect(res.body.result.steps[0].status).toBe('failed');
    expect(res.body.result.steps[0].stderr).toContain('ENOENT');
  });

  it('returns 404 when the CGNS file is not in the project', async () => {
    const { id, auth, userId } = await makeProject('cv-no-cgns@dive-turbinen.test');
    const templateId = await makeTemplate(userId, []);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'ghost.cgns', templateId });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the template does not exist', async () => {
    const { id, auth } = await makeProject('cv-no-tpl@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns', templateId: 'does-not-exist' });
    expect(res.status).toBe(404);
  });

  it('rejects a convert with a missing field (422)', async () => {
    const { id, auth } = await makeProject('cv-validation@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', auth)
      .send({ cgnsFile: 'rotor.cgns' });
    expect(res.status).toBe(422);
  });

  it('lets a super-admin convert another user’s project', async () => {
    const { id, auth, userId } = await makeProject('cv-admin@dive-turbinen.test');
    await uploadCgns(id, auth, 'rotor.cgns', 'CGNS');
    const templateId = await makeTemplate(userId, [
      { path: 'system/controlDict', content: 'application foamRun;' },
    ]);
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post(`/api/v1/projects/${id}/cgns/convert`)
      .set('Authorization', authHeader(admin))
      .send({ cgnsFile: 'rotor.cgns', templateId });
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
  });
});
