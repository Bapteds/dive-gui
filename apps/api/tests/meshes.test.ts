// Integration tests for the multi-mesh library + merge pipeline. The OpenFOAM
// toolchain (mergeMeshes / stitchMesh / checkMesh) is not installed in CI / on a
// dev box, so the command runner is swapped for a fake that simulates each step
// AND writes the boundary the real tools would produce — letting us exercise the
// full orchestration: per-mesh patch prefixing, combine, conformal stitch,
// empty-patch cleanup, checkMesh, and the promote into the case mesh.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';

// --- Boundary-file helpers (tiny OpenFOAM polyBoundaryMesh format) ----------

/** Build a boundary file with the given patches (inline blocks, like real ones). */
function makeBoundary(patches: Array<{ name: string; type?: string; nFaces?: number }>): string {
  const blocks = patches
    .map(
      (p, i) =>
        `    ${p.name} { type ${p.type ?? 'patch'}; nFaces ${p.nFaces ?? 10}; startFace ${100 + i * 10}; }`,
    )
    .join('\n');
  return `FoamFile { class polyBoundaryMesh; object boundary; }\n${patches.length}\n(\n${blocks}\n)\n`;
}

/** The `name { ... }` patch blocks of a boundary file (header stripped). */
function patchBlocks(boundary: string): string[] {
  const body = boundary.replace(/FoamFile\s*\{[^}]*\}/, '');
  return [...body.matchAll(/[A-Za-z_][A-Za-z0-9_]*\s*\{[^}]*\}/g)].map((m) => m[0].trim());
}

/** Reassemble a boundary file from patch blocks. */
function buildBoundary(blocks: string[]): string {
  const list = blocks.map((b) => `    ${b}`).join('\n');
  return `FoamFile { class polyBoundaryMesh; object boundary; }\n${blocks.length}\n(\n${list}\n)\n`;
}

/** Simulate mergeMeshes: the master boundary gains the add mesh's patch blocks. */
function mergeBoundaries(master: string, add: string): string {
  return buildBoundary([...patchBlocks(master), ...patchBlocks(add)]);
}

/** Simulate stitchMesh: the two fused patches lose all their faces (nFaces 0). */
function zeroOutPatches(boundary: string, names: string[]): string {
  const blocks = patchBlocks(boundary).map((b) => {
    const name = b.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? '';
    return names.includes(name) ? b.replace(/nFaces\s+\d+/, 'nFaces 0') : b;
  });
  return buildBoundary(blocks);
}

// --- Fake command runners ---------------------------------------------------

function ok(spec: { command: string; args: string[] }, stdout: string): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/** A runner that simulates the whole merge toolchain succeeding. */
const mergeRunner: CommandRunner = async (spec) => {
  if (spec.command === 'mergeMeshes') {
    // args: [masterDir, addDir, '-overwrite']
    const masterB = path.join(spec.args[0], 'constant', 'polyMesh', 'boundary');
    const addB = path.join(spec.args[1], 'constant', 'polyMesh', 'boundary');
    const merged = mergeBoundaries(await fs.readFile(masterB, 'utf8'), await fs.readFile(addB, 'utf8'));
    await fs.writeFile(masterB, merged);
    return ok(spec, 'Merged meshes');
  }
  if (spec.command === 'stitchMesh') {
    // args: [masterPatch, slavePatch, '-overwrite', '-partial', '-case', masterDir]
    const caseDir = spec.args[spec.args.indexOf('-case') + 1];
    const boundaryAbs = path.join(caseDir, 'constant', 'polyMesh', 'boundary');
    const stitched = zeroOutPatches(await fs.readFile(boundaryAbs, 'utf8'), [spec.args[0], spec.args[1]]);
    await fs.writeFile(boundaryAbs, stitched);
    return ok(spec, 'Stitched patches');
  }
  if (spec.command === 'checkMesh') {
    return ok(spec, 'Mesh stats ...\nMesh OK.\n');
  }
  return ok(spec, '');
};

/** A runner whose mergeMeshes fails (writes nothing). */
const mergeFailsRunner: CommandRunner = async (spec) => {
  if (spec.command === 'mergeMeshes') {
    return { command: spec.command, args: spec.args, exitCode: 1, stdout: '', stderr: 'Cannot merge: incompatible meshes', durationMs: 1, timedOut: false };
  }
  return ok(spec, '');
};

/** Write a fake constant/polyMesh (points + boundary) into a case dir. */
async function writePolyMesh(caseDir: string): Promise<void> {
  const pm = path.join(caseDir, 'constant', 'polyMesh');
  await fs.mkdir(pm, { recursive: true });
  await fs.writeFile(path.join(pm, 'points'), 'points-data');
  await fs.writeFile(path.join(pm, 'boundary'), makeBoundary([{ name: 'inlet' }, { name: 'outlet' }]));
}

/** A runner that simulates the mesh-file conversion toolchain (CGNS + Fluent) succeeding. */
const meshImportRunner: CommandRunner = async (spec) => {
  if (spec.command === 'python3') {
    // CgnsToVtk: [script, src, vtk] -> write the VTK output the next step reads.
    const vtkAbs = spec.args[2];
    await fs.mkdir(path.dirname(vtkAbs), { recursive: true });
    await fs.writeFile(vtkAbs, '# vtk DataFile Version 4.2\nfake\n');
    return ok(spec, 'VTK written');
  }
  if (spec.command === 'vtkUnstructuredToFoam') {
    await writePolyMesh(spec.args[1]); // ['-case', caseDir, vtk]
    return ok(spec, 'Foam mesh written');
  }
  if (spec.command === 'fluent3DMeshToFoam') {
    await writePolyMesh(spec.args[spec.args.indexOf('-case') + 1]); // [src, '-case', caseDir]
    return ok(spec, 'Foam mesh written');
  }
  if (spec.command === 'checkMesh') return ok(spec, 'Mesh OK.\n');
  return ok(spec, '');
};

/** A runner whose CGNS->VTK step fails (no mesh produced). */
const importFailsRunner: CommandRunner = async (spec) => {
  if (spec.command === 'python3') {
    return { command: spec.command, args: spec.args, exitCode: 1, stdout: '', stderr: 'CGNS read failed', durationMs: 1, timedOut: false };
  }
  return ok(spec, '');
};

// --- Project + upload helpers ----------------------------------------------

async function makeProject(email: string): Promise<{ userId: string; auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { userId: user.id, auth: authHeader(user), id: project.id };
}

/** Build a raw multipart body (superagent's .attach basenames the filename). */
function buildMultipart(parts: Array<{ field: string; filename: string; data: Buffer | string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----DiveMeshTestBoundary7MA4YWxkTrZu0gW';
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

/** The 5 polyMesh files for one source, wrapped in a folder (drives the name). */
function meshFiles(wrapper: string, boundary: string): Array<{ relativePath: string; data: string }> {
  return ['points', 'faces', 'owner', 'neighbour'].map((leaf) => ({
    relativePath: `${wrapper}/polyMesh/${leaf}`,
    data: `${leaf}-data`,
  })).concat([{ relativePath: `${wrapper}/polyMesh/boundary`, data: boundary }]);
}

/** Import a polyMesh folder into the library. */
function importMesh(id: string, auth: string, files: Array<{ relativePath: string; data: string }>) {
  const { body, contentType } = buildMultipart(
    files.map((f) => ({ field: 'files', filename: f.relativePath, data: f.data })),
  );
  return request(app)
    .post(`/api/v1/projects/${id}/meshes/import`)
    .set('Authorization', auth)
    .set('Content-Type', contentType)
    .send(body);
}

/** Import a single mesh FILE (.cgns / .msh) into the library (field 'meshFile'). */
function importMeshFile(id: string, auth: string, name: string, data: string) {
  const { body, contentType } = buildMultipart([{ field: 'meshFile', filename: name, data }]);
  return request(app)
    .post(`/api/v1/projects/${id}/meshes/import`)
    .set('Authorization', auth)
    .set('Content-Type', contentType)
    .send(body);
}

/** Import the two standard test parts (A = inlet side, B = outlet side). */
async function importTwoParts(id: string, auth: string): Promise<{ a: string; b: string }> {
  const a = await importMesh(id, auth, meshFiles('inlet-part', makeBoundary([
    { name: 'inlet' }, { name: 'ifaceA' }, { name: 'wallsA', type: 'wall' },
  ])));
  const b = await importMesh(id, auth, meshFiles('outlet-part', makeBoundary([
    { name: 'ifaceB' }, { name: 'outlet' }, { name: 'wallsB', type: 'wall' },
  ])));
  return { a: a.body.mesh.id, b: b.body.mesh.id };
}

function caseBoundary(id: string, auth: string) {
  return request(app)
    .get(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent('constant/polyMesh/boundary')}`)
    .set('Authorization', auth);
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setCommandRunner(mergeRunner);
});

afterEach(() => {
  setCommandRunner(null);
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('POST /projects/:id/meshes/import', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('m-auth@dive-turbinen.test');
    const { body, contentType } = buildMultipart([{ field: 'files', filename: 'polyMesh/boundary', data: 'x' }]);
    const res = await request(app).post(`/api/v1/projects/${id}/meshes/import`).set('Content-Type', contentType).send(body);
    expect(res.status).toBe(401);
  });

  it('imports a polyMesh folder and lists it with its patches', async () => {
    const { id, auth } = await makeProject('m-import@dive-turbinen.test');
    const res = await importMesh(id, auth, meshFiles('inlet-part', makeBoundary([
      { name: 'inlet' }, { name: 'ifaceA' }, { name: 'wallsA', type: 'wall' },
    ])));

    expect(res.status).toBe(201);
    expect(res.body.mesh.name).toBe('inlet-part');
    expect(res.body.mesh.patches.map((p: { name: string }) => p.name)).toEqual(['inlet', 'ifaceA', 'wallsA']);
    expect(res.body.mesh.patches.find((p: { name: string }) => p.name === 'wallsA').type).toBe('wall');
    expect(res.body.meshes).toHaveLength(1);

    const list = await request(app).get(`/api/v1/projects/${id}/meshes`).set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.meshes).toHaveLength(1);
  });

  it('rejects an upload that contains no polyMesh boundary (400 NO_MESH)', async () => {
    const { id, auth } = await makeProject('m-noboundary@dive-turbinen.test');
    const res = await importMesh(id, auth, [{ relativePath: 'x/polyMesh/points', data: 'points' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_MESH');
    // The partial source was cleaned up.
    const list = await request(app).get(`/api/v1/projects/${id}/meshes`).set('Authorization', auth);
    expect(list.body.meshes).toEqual([]);
  });
});

describe('GET /meshes/:meshId/patches + DELETE /meshes/:meshId', () => {
  it('returns one source patches and deletes a source', async () => {
    const { id, auth } = await makeProject('m-crud@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);

    const patches = await request(app).get(`/api/v1/projects/${id}/meshes/${a}/patches`).set('Authorization', auth);
    expect(patches.status).toBe(200);
    expect(patches.body.patches.map((p: { name: string }) => p.name)).toEqual(['inlet', 'ifaceA', 'wallsA']);

    const del = await request(app).delete(`/api/v1/projects/${id}/meshes/${b}`).set('Authorization', auth);
    expect(del.status).toBe(200);
    expect(del.body.meshes).toHaveLength(1);
    expect(del.body.meshes[0].id).toBe(a);
  });

  it('returns 404 for an unknown mesh id', async () => {
    const { id, auth } = await makeProject('m-404@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/meshes/ghost/patches`).set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/meshes/merge', () => {
  it('combines + stitches two meshes into the case mesh (success)', async () => {
    const { id, auth } = await makeProject('mg-ok@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [{ aMeshId: a, aPatch: 'ifaceA', bMeshId: b, bPatch: 'ifaceB' }] });

    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(true);
    expect(result.steps.map((s: { kind: string }) => s.kind)).toEqual([
      'prepare', 'prepare', 'mergeMeshes', 'stitchMesh', 'cleanup', 'checkMesh',
    ]);
    // The stitched interface patches are fused away; the rest survive, prefixed.
    const names = result.boundaryPatches.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['m1_inlet', 'm1_wallsA', 'm2_outlet', 'm2_wallsB']);
    // The combined mesh was promoted into the case.
    const paths = (result.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('constant/polyMesh/boundary');
    expect(paths).toContain('constant/polyMesh/points');

    const boundary = await caseBoundary(id, auth);
    expect(boundary.body.file.content).not.toContain('ifaceA');
    expect(boundary.body.file.content).toContain('m1_inlet');
  });

  it('imports and promotes a single mesh without prefixing (no merge/stitch steps)', async () => {
    const { id, auth } = await makeProject('mg-single@dive-turbinen.test');
    const single = await importMesh(id, auth, meshFiles('part', makeBoundary([{ name: 'inlet' }, { name: 'outlet' }])));
    const meshId = single.body.mesh.id;

    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [meshId], stitches: [] });

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.steps.map((s: { kind: string }) => s.kind)).toEqual(['prepare', 'cleanup', 'checkMesh']);
    // Single mesh keeps its original patch names (no m1_ prefix).
    expect(res.body.result.boundaryPatches.map((p: { name: string }) => p.name).sort()).toEqual(['inlet', 'outlet']);
  });

  it('short-circuits and leaves the case untouched when mergeMeshes fails', async () => {
    setCommandRunner(mergeFailsRunner);
    const { id, auth } = await makeProject('mg-fail@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [] });

    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(false);
    const steps = result.steps as Array<{ kind: string; status: string }>;
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'mergeMeshes', status: 'failed' });
    expect(steps.some((s) => s.kind === 'checkMesh')).toBe(false);
    // No mesh was promoted into the case.
    expect((result.entries as Array<{ path: string }>).some((e) => e.path === 'constant/polyMesh/boundary')).toBe(false);
  });

  it('rejects an empty order (422 validation)', async () => {
    const { id, auth } = await makeProject('mg-empty@dive-turbinen.test');
    const res = await request(app).post(`/api/v1/projects/${id}/meshes/merge`).set('Authorization', auth).send({ order: [] });
    expect(res.status).toBe(422);
  });

  it('rejects an order referencing an unknown mesh (422 INVALID_MERGE_PLAN)', async () => {
    const { id, auth } = await makeProject('mg-unknown@dive-turbinen.test');
    const { a } = await importTwoParts(id, auth);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, 'ghost'], stitches: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_MERGE_PLAN');
  });

  it('rejects a stitch to a patch that does not exist (422 STITCH_PATCH_NOT_FOUND)', async () => {
    const { id, auth } = await makeProject('mg-badpatch@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [{ aMeshId: a, aPatch: 'nope', bMeshId: b, bPatch: 'ifaceB' }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STITCH_PATCH_NOT_FOUND');
  });

  it('lets a super-admin merge another user’s project', async () => {
    const { id, auth } = await makeProject('mg-admin@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const admin = await createProtectedAdmin();
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', authHeader(admin))
      .send({ order: [a, b], stitches: [] });
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
  });
});

describe('GET/PUT /projects/:id/meshes/plan', () => {
  it('persists and reads back a merge plan draft', async () => {
    const { id, auth } = await makeProject('mp-plan@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const plan = { order: [a, b], stitches: [{ aMeshId: a, aPatch: 'ifaceA', bMeshId: b, bPatch: 'ifaceB' }] };

    const put = await request(app).put(`/api/v1/projects/${id}/meshes/plan`).set('Authorization', auth).send(plan);
    expect(put.status).toBe(200);

    const get = await request(app).get(`/api/v1/projects/${id}/meshes/plan`).set('Authorization', auth);
    expect(get.status).toBe(200);
    expect(get.body.plan).toMatchObject(plan);
  });

  it('returns a null plan when none was saved', async () => {
    const { id, auth } = await makeProject('mp-none@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/meshes/plan`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
  });
});

describe('POST /projects/:id/meshes/import (mesh file -> library)', () => {
  it('converts a .cgns file into a library source', async () => {
    setCommandRunner(meshImportRunner);
    const { id, auth } = await makeProject('mi-cgns@dive-turbinen.test');
    const res = await importMeshFile(id, auth, 'rotor.cgns', 'CGNS-bytes');
    expect(res.status).toBe(201);
    expect(res.body.conversion.success).toBe(true);
    expect(res.body.mesh.name).toBe('rotor.cgns');
    expect(res.body.mesh.patches.map((p: { name: string }) => p.name)).toEqual(['inlet', 'outlet']);
    expect(res.body.meshes).toHaveLength(1);
  });

  it('converts a Fluent .msh file into a library source', async () => {
    setCommandRunner(meshImportRunner);
    const { id, auth } = await makeProject('mi-msh@dive-turbinen.test');
    const res = await importMeshFile(id, auth, 'part.msh', 'MSH-bytes');
    expect(res.status).toBe(201);
    expect(res.body.conversion.success).toBe(true);
    expect(res.body.mesh.name).toBe('part.msh');
    expect(res.body.meshes).toHaveLength(1);
  });

  it('reports a conversion failure and keeps no source', async () => {
    setCommandRunner(importFailsRunner);
    const { id, auth } = await makeProject('mi-fail@dive-turbinen.test');
    const res = await importMeshFile(id, auth, 'bad.cgns', 'x');
    expect(res.status).toBe(201);
    expect(res.body.conversion.success).toBe(false);
    expect(res.body.mesh).toBeUndefined();
    expect(res.body.meshes).toEqual([]);
  });
});

describe('POST /projects/:id/files/import (mesh file -> case)', () => {
  it('converts a .cgns file directly into the case mesh', async () => {
    setCommandRunner(meshImportRunner);
    const { id, auth } = await makeProject('fi-cgns@dive-turbinen.test');
    const { body, contentType } = buildMultipart([
      { field: 'meshFile', filename: 'rotor.cgns', data: 'CGNS' },
    ]);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/import`)
      .set('Authorization', auth)
      .set('Content-Type', contentType)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.conversion.success).toBe(true);
    const paths = (res.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('constant/polyMesh/boundary');
  });
});
