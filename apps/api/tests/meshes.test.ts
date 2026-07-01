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

// --- ASCII points helpers (real FoamFile points, for the transform tests) ----

/** Build a minimal ASCII FoamFile points file with the given vertices. */
function makePoints(points: Array<[number, number, number]>): string {
  const body = points.map(([x, y, z]) => `(${x} ${y} ${z})`).join('\n');
  return `FoamFile { class vectorField; object points; }\n${points.length}\n(\n${body}\n)\n`;
}

/** Extract the (x y z) vectors out of an ASCII points file. */
function readPoints(content: string): Array<[number, number, number]> {
  const num = '[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?';
  const re = new RegExp(`\\(\\s*(${num})\\s+(${num})\\s+(${num})\\s*\\)`, 'g');
  const out: Array<[number, number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  return out;
}

// --- Fake command runners ---------------------------------------------------

function ok(spec: { command: string; args: string[] }, stdout: string): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/**
 * Every OpenFOAM invocation the merge pipeline makes, in order. Lets a test pin
 * the exact CLI contract (the real mergeMeshes / stitchMesh are not in CI), so a
 * regression back to the pre-v11 positional signature is caught here, not on the
 * server. Reset in beforeEach.
 */
const recordedCommands: Array<{ command: string; args: string[] }> = [];

/** Pull the single path out of a -addCases list literal, e.g. ("/a/b") -> /a/b. */
function addCasePath(addCasesArg: string): string {
  return addCasesArg.match(/"([^"]+)"/)?.[1] ?? '';
}

/** Pull the two patch names out of a stitchMesh patchPairs literal "((a b))". */
function patchPair(pairsArg: string): string[] {
  return pairsArg.replace(/[()]/g, ' ').trim().split(/\s+/);
}

/** A runner that simulates the whole merge toolchain succeeding. */
const mergeRunner: CommandRunner = async (spec) => {
  recordedCommands.push({ command: spec.command, args: [...spec.args] });
  if (spec.command === 'mergeMeshes') {
    // v11+: ['-case', masterDir, '-addCases', '("<addDir>")', '-overwrite']
    const masterDir = spec.args[spec.args.indexOf('-case') + 1];
    const addDir = addCasePath(spec.args[spec.args.indexOf('-addCases') + 1]);
    const masterB = path.join(masterDir, 'constant', 'polyMesh', 'boundary');
    const addB = path.join(addDir, 'constant', 'polyMesh', 'boundary');
    const merged = mergeBoundaries(await fs.readFile(masterB, 'utf8'), await fs.readFile(addB, 'utf8'));
    await fs.writeFile(masterB, merged);
    return ok(spec, 'Merged meshes');
  }
  if (spec.command === 'stitchMesh') {
    // v11+: ['((master slave))', '-overwrite', '-case', masterDir]
    const caseDir = spec.args[spec.args.indexOf('-case') + 1];
    const boundaryAbs = path.join(caseDir, 'constant', 'polyMesh', 'boundary');
    const stitched = zeroOutPatches(await fs.readFile(boundaryAbs, 'utf8'), patchPair(spec.args[0]));
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

/** A runner where stitchMesh runs (exit 0) but fuses NO faces (patches keep every face). */
const stitchNoOpRunner: CommandRunner = async (spec) => {
  if (spec.command === 'stitchMesh') return ok(spec, 'Stitched 0 faces');
  return mergeRunner(spec);
};

/** A runner like mergeRunner, but checkMesh reports failed checks while still exiting 0. */
const checkMeshIssuesRunner: CommandRunner = async (spec) =>
  spec.command === 'checkMesh'
    ? ok(spec, 'Checking geometry...\n***High non-orthogonality...\nFailed 2 mesh checks.\n')
    : mergeRunner(spec);

/**
 * A runner like mergeRunner, but its mergeMeshes ALSO folds the added part's
 * points into the master (concatenated) — the real tool combines points, the
 * default mergeRunner only combines boundaries. This lets a test read the
 * promoted case points back and see the added part's *staged* (transformed)
 * coordinates that stageSource wrote before this mergeMeshes ran.
 */
const transformMergeRunner: CommandRunner = async (spec) => {
  if (spec.command === 'mergeMeshes') {
    recordedCommands.push({ command: spec.command, args: [...spec.args] });
    const masterDir = spec.args[spec.args.indexOf('-case') + 1];
    const addDir = addCasePath(spec.args[spec.args.indexOf('-addCases') + 1]);
    // Boundaries: same as mergeRunner.
    const masterB = path.join(masterDir, 'constant', 'polyMesh', 'boundary');
    const addB = path.join(addDir, 'constant', 'polyMesh', 'boundary');
    await fs.writeFile(masterB, mergeBoundaries(await fs.readFile(masterB, 'utf8'), await fs.readFile(addB, 'utf8')));
    // Points: master ++ add, so the added (already-transformed) points are promoted.
    const masterP = path.join(masterDir, 'constant', 'polyMesh', 'points');
    const addP = path.join(addDir, 'constant', 'polyMesh', 'points');
    const combined = [
      ...readPoints(await fs.readFile(masterP, 'utf8')),
      ...readPoints(await fs.readFile(addP, 'utf8')),
    ];
    await fs.writeFile(masterP, makePoints(combined));
    return ok(spec, 'Merged meshes + points');
  }
  return mergeRunner(spec);
};

/** Minimal stand-in for a GLB — just enough header for the byte assertions. */
const FAKE_GLB = Buffer.from('glTF\x02\x00\x00\x00fake-binary-gltf', 'binary');
/** Stand-in cell-edge buffer (12 vertices x 3 float32). */
const FAKE_EDGES = Buffer.from(new Float32Array(12 * 3).buffer);
/** The manifest the real extractor would write for a source. */
const SOURCE_MANIFEST = [{ name: 'inlet', type: 'patch', nFaces: 10, edgeOffset: 0, edgeCount: 12 }];

/**
 * A fake extractor runner for the per-source render: writes the GLB, manifest and
 * edges.bin to the paths the service passes (argv[2] = glb, argv[3] = manifest),
 * exactly like the Visualize-tab test's successRunner, so the real PyVista script
 * never runs.
 */
const sourceVizRunner: CommandRunner = async (spec) => {
  const [, , glbPath, manifestPath] = spec.args;
  await fs.mkdir(path.dirname(glbPath), { recursive: true });
  await fs.writeFile(glbPath, FAKE_GLB);
  await fs.writeFile(manifestPath, JSON.stringify(SOURCE_MANIFEST));
  await fs.writeFile(path.join(path.dirname(glbPath), 'edges.bin'), FAKE_EDGES);
  return ok(spec, `OK: ${SOURCE_MANIFEST.length} patches -> ${glbPath}`);
};

/** Collect a binary response body into a Buffer (supertest does not by default). */
const binaryParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
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

/** A runner simulating autoPatch: split the boundary into autoN + an empty leftover. */
const autoPatchRunner: CommandRunner = async (spec) => {
  if (spec.command === 'autoPatch') {
    const caseDir = spec.args[spec.args.indexOf('-case') + 1];
    const boundaryAbs = path.join(caseDir, 'constant', 'polyMesh', 'boundary');
    // autoPatch keeps the (collapsed) patch as empty and appends the split patches.
    await fs.writeFile(
      boundaryAbs,
      makeBoundary([
        { name: 'defaultFaces', nFaces: 0 },
        { name: 'auto0', nFaces: 12 },
        { name: 'auto1', type: 'wall', nFaces: 8 },
      ]),
    );
    return ok(spec, 'autoPatch: created 2 patches');
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

/** Like meshFiles but with a REAL ASCII points file (for the transform tests). */
function meshFilesP(
  wrapper: string,
  boundary: string,
  points: Array<[number, number, number]>,
): Array<{ relativePath: string; data: string }> {
  return ['faces', 'owner', 'neighbour']
    .map((leaf) => ({ relativePath: `${wrapper}/polyMesh/${leaf}`, data: `${leaf}-data` }))
    .concat([
      { relativePath: `${wrapper}/polyMesh/points`, data: makePoints(points) },
      { relativePath: `${wrapper}/polyMesh/boundary`, data: boundary },
    ]);
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

/** Read the text content of any case file via the editor content endpoint. */
function caseFileContent(id: string, auth: string, relPath: string) {
  return request(app)
    .get(`/api/v1/projects/${id}/files/content?path=${encodeURIComponent(relPath)}`)
    .set('Authorization', auth);
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  recordedCommands.length = 0;
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
    // The id is the readable slug of the source name, not an opaque UUID.
    expect(res.body.mesh.id).toBe('inlet-part');
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

    // The merge invoked the OpenFOAM.org v11+ CLI, not the old positional signature
    // (mergeMeshes uses -addCases; stitchMesh a single patchPairs list, no -partial).
    const mergeCall = recordedCommands.find((c) => c.command === 'mergeMeshes')!;
    expect(mergeCall.args).toEqual([
      '-case', expect.any(String), '-addCases', expect.stringMatching(/^\("[^"]+"\)$/), '-overwrite',
    ]);
    const stitchCall = recordedCommands.find((c) => c.command === 'stitchMesh')!;
    expect(stitchCall.args[0]).toBe('((m1_ifaceA m2_ifaceB))');
    expect(stitchCall.args).toContain('-overwrite');
    expect(stitchCall.args).not.toContain('-partial');
    expect(stitchCall.args).not.toContain('-perfect');

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

  it('fails the merge when a stitch fuses no faces (non-coincident patches)', async () => {
    setCommandRunner(stitchNoOpRunner);
    const { id, auth } = await makeProject('mg-nofuse@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [{ aMeshId: a, aPatch: 'ifaceA', bMeshId: b, bPatch: 'ifaceB' }] });
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(false);
    const steps = result.steps as Array<{ kind: string; status: string }>;
    expect(steps.find((s) => s.kind === 'stitchMesh')!.status).toBe('failed');
    // Aborted before checkMesh; nothing promoted into the case.
    expect(steps.some((s) => s.kind === 'checkMesh')).toBe(false);
    expect((result.entries as Array<{ path: string }>).some((e) => e.path === 'constant/polyMesh/boundary')).toBe(false);
  });

  it('promotes but warns when checkMesh reports failed checks (exit 0)', async () => {
    setCommandRunner(checkMeshIssuesRunner);
    const { id, auth } = await makeProject('mg-checkwarn@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [{ aMeshId: a, aPatch: 'ifaceA', bMeshId: b, bPatch: 'ifaceB' }] });
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect((res.body.result.notes as string[]).some((n) => /checkMesh reported 2 failed mesh check/i.test(n))).toBe(true);
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

describe('POST /projects/:id/meshes/merge (rigid part transforms)', () => {
  // Canonical parity fixture, shared with meshTransform.test.ts and the web
  // placement.test.ts: 90° about +Z, then translate by (1,2,3). R·[1,0,0]=[0,1,0].
  const Q90Z = [0, 0, 0.7071067811865476, 0.7071067811865476] as [number, number, number, number];
  const T123 = [1, 2, 3] as [number, number, number];

  /** Import a base (A) + an added (B) part, each with a single real vertex. */
  async function importTwoPlaced(
    id: string,
    auth: string,
    aPoint: [number, number, number],
    bPoint: [number, number, number],
  ): Promise<{ a: string; b: string }> {
    const a = await importMesh(
      id,
      auth,
      meshFilesP('base-part', makeBoundary([{ name: 'inlet' }, { name: 'ifaceA' }]), [aPoint]),
    );
    const b = await importMesh(
      id,
      auth,
      meshFilesP('added-part', makeBoundary([{ name: 'ifaceB' }, { name: 'outlet' }]), [bPoint]),
    );
    return { a: a.body.mesh.id, b: b.body.mesh.id };
  }

  it('bakes an added part’s placement into its points during staging (preview parity)', async () => {
    setCommandRunner(transformMergeRunner);
    const { id, auth } = await makeProject('mg-transform@dive-turbinen.test');
    const { a, b } = await importTwoPlaced(id, auth, [0, 0, 0], [1, 0, 0]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [], transforms: [{ meshId: b, translation: T123, rotation: Q90Z }] });

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    // The prepare step for the added part records that it was transformed.
    const bPrepare = (res.body.result.steps as Array<{ kind: string; label: string; stdout: string }>).filter(
      (s) => s.kind === 'prepare',
    )[1];
    expect(bPrepare.stdout).toContain('Transformed');

    // The promoted case points = base (unmoved) ++ added (R·p + t).
    const pts = readPoints((await caseFileContent(id, auth, 'constant/polyMesh/points')).body.file.content);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual([0, 0, 0]); // base master never moved
    expect(pts[1][0]).toBeCloseTo(1, 9); // 90°Z: [1,0,0] -> [0,1,0], +t -> [1,3,3]
    expect(pts[1][1]).toBeCloseTo(3, 9);
    expect(pts[1][2]).toBeCloseTo(3, 9);
  });

  it('leaves every part’s points untouched when transforms is omitted (backward compatible)', async () => {
    setCommandRunner(transformMergeRunner);
    const { id, auth } = await makeProject('mg-notransform@dive-turbinen.test');
    const { a, b } = await importTwoPlaced(id, auth, [5, 6, 7], [1, 2, 3]);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [] }); // no transforms => today's behaviour

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    const pts = readPoints((await caseFileContent(id, auth, 'constant/polyMesh/points')).body.file.content);
    expect(pts).toEqual([[5, 6, 7], [1, 2, 3]]); // both parts verbatim, nothing moved
  });

  it('never moves the base master even if a transform targets it', async () => {
    setCommandRunner(transformMergeRunner);
    const { id, auth } = await makeProject('mg-masterfixed@dive-turbinen.test');
    const { a, b } = await importTwoPlaced(id, auth, [1, 0, 0], [9, 9, 9]);

    // A transform on the master (order[0]) must be ignored — the base is fixed.
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [], transforms: [{ meshId: a, translation: T123, rotation: Q90Z }] });

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    const pts = readPoints((await caseFileContent(id, auth, 'constant/polyMesh/points')).body.file.content);
    expect(pts[0]).toEqual([1, 0, 0]); // master untouched despite the transform
  });

  it('rejects a transform with a non-finite component (422 validation)', async () => {
    const { id, auth } = await makeProject('mg-badtransform@dive-turbinen.test');
    const { a, b } = await importTwoPlaced(id, auth, [0, 0, 0], [1, 0, 0]);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/merge`)
      .set('Authorization', auth)
      .send({ order: [a, b], stitches: [], transforms: [{ meshId: b, translation: [1, 2, null], rotation: Q90Z }] });
    expect(res.status).toBe(422);
  });
});

describe('GET /projects/:id/meshes/:meshId/{manifest,geometry,edges} (source render)', () => {
  it('builds a source render on demand and streams its GLB as model/gltf-binary', async () => {
    setCommandRunner(sourceVizRunner);
    const { id, auth } = await makeProject('ms-geo@dive-turbinen.test');
    const imported = await importMesh(id, auth, meshFiles('part', makeBoundary([{ name: 'inlet' }, { name: 'outlet' }])));
    const meshId = imported.body.mesh.id;

    // The manifest call builds the render (GLB + manifest + edges) on demand.
    const manifest = await request(app)
      .get(`/api/v1/projects/${id}/meshes/${meshId}/manifest`)
      .set('Authorization', auth);
    expect(manifest.status).toBe(200);
    expect(manifest.body.manifest.patches).toEqual(SOURCE_MANIFEST);

    const geo = await request(app)
      .get(`/api/v1/projects/${id}/meshes/${meshId}/geometry`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);
    expect(geo.status).toBe(200);
    expect(geo.headers['content-type']).toContain('model/gltf-binary');
    expect(Buffer.isBuffer(geo.body)).toBe(true);
    expect(geo.body.equals(FAKE_GLB)).toBe(true);
  });

  it('builds the render on demand when geometry is fetched before the manifest', async () => {
    // Regression: the Assemble tab fetches a source's geometry directly (never its
    // manifest), so geometry must build the render itself instead of 409-ing.
    setCommandRunner(sourceVizRunner);
    const { id, auth } = await makeProject('ms-geo-direct@dive-turbinen.test');
    const imported = await importMesh(id, auth, meshFiles('part', makeBoundary([{ name: 'inlet' }])));
    const res = await request(app)
      .get(`/api/v1/projects/${id}/meshes/${imported.body.mesh.id}/geometry`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('model/gltf-binary');
    expect(res.body.equals(FAKE_GLB)).toBe(true);
  });

  it('serves 204 for source edges before a build, then the buffer after', async () => {
    setCommandRunner(sourceVizRunner);
    const { id, auth } = await makeProject('ms-edges@dive-turbinen.test');
    const imported = await importMesh(id, auth, meshFiles('part', makeBoundary([{ name: 'inlet' }])));
    const meshId = imported.body.mesh.id;

    const before = await request(app).get(`/api/v1/projects/${id}/meshes/${meshId}/edges`).set('Authorization', auth);
    expect(before.status).toBe(204);

    await request(app).get(`/api/v1/projects/${id}/meshes/${meshId}/manifest`).set('Authorization', auth);
    const after = await request(app)
      .get(`/api/v1/projects/${id}/meshes/${meshId}/edges`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);
    expect(after.status).toBe(200);
    expect(after.headers['content-type']).toContain('application/octet-stream');
    expect(after.body.equals(FAKE_EDGES)).toBe(true);
  });

  it('returns 404 for the manifest of an unknown source', async () => {
    const { id, auth } = await makeProject('ms-404@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/meshes/ghost/manifest`).set('Authorization', auth);
    expect(res.status).toBe(404);
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

  it('persists and reads back the rigid part transforms in a draft', async () => {
    const { id, auth } = await makeProject('mp-transforms@dive-turbinen.test');
    const { a, b } = await importTwoParts(id, auth);
    const plan = {
      order: [a, b],
      stitches: [],
      transforms: [{ meshId: b, translation: [1, 2, 3], rotation: [0, 0, 0.7071067811865476, 0.7071067811865476] }],
    };

    const put = await request(app).put(`/api/v1/projects/${id}/meshes/plan`).set('Authorization', auth).send(plan);
    expect(put.status).toBe(200);
    expect(put.body.plan.transforms).toEqual(plan.transforms);

    const get = await request(app).get(`/api/v1/projects/${id}/meshes/plan`).set('Authorization', auth);
    expect(get.status).toBe(200);
    expect(get.body.plan.transforms).toEqual(plan.transforms);
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
    // The display name drops the extension and the id is its readable slug.
    expect(res.body.mesh.name).toBe('rotor');
    expect(res.body.mesh.id).toBe('rotor');
    expect(res.body.mesh.patches.map((p: { name: string }) => p.name)).toEqual(['inlet', 'outlet']);
    expect(res.body.meshes).toHaveLength(1);
  });

  it('converts a Fluent .msh file into a library source', async () => {
    setCommandRunner(meshImportRunner);
    const { id, auth } = await makeProject('mi-msh@dive-turbinen.test');
    const res = await importMeshFile(id, auth, 'part.msh', 'MSH-bytes');
    expect(res.status).toBe(201);
    expect(res.body.conversion.success).toBe(true);
    expect(res.body.mesh.name).toBe('part');
    expect(res.body.mesh.id).toBe('part');
    expect(res.body.meshes).toHaveLength(1);
  });

  it('gives a second same-named file a distinct slug id (-2)', async () => {
    setCommandRunner(meshImportRunner);
    const { id, auth } = await makeProject('mi-dup@dive-turbinen.test');
    const first = await importMeshFile(id, auth, 'rotor.cgns', 'CGNS-1');
    const second = await importMeshFile(id, auth, 'rotor.cgns', 'CGNS-2');
    expect(first.body.mesh.id).toBe('rotor');
    expect(second.body.mesh.id).toBe('rotor-2');
    // Both display the same human name; only the id disambiguates them.
    expect(second.body.mesh.name).toBe('rotor');
    const list = await request(app).get(`/api/v1/projects/${id}/meshes`).set('Authorization', auth);
    expect(list.body.meshes).toHaveLength(2);
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

describe('POST /meshes/:meshId/auto-patch + /patches/rename (re-patch a library mesh)', () => {
  it('splits a single-patch library mesh, then names a patch', async () => {
    setCommandRunner(autoPatchRunner);
    const { id, auth } = await makeProject('mr-repatch@dive-turbinen.test');
    const imported = await importMesh(id, auth, meshFiles('part', makeBoundary([{ name: 'defaultFaces' }])));
    const meshId = imported.body.mesh.id;

    const split = await request(app)
      .post(`/api/v1/projects/${id}/meshes/${meshId}/auto-patch`)
      .set('Authorization', auth)
      .send({ featureAngle: 45 });
    expect(split.status).toBe(200);
    expect(split.body.result.success).toBe(true);
    // The empty leftover is cleaned up; only the split patches remain.
    expect(split.body.mesh.patches.map((p: { name: string }) => p.name)).toEqual(['auto0', 'auto1']);

    const renamed = await request(app)
      .post(`/api/v1/projects/${id}/meshes/${meshId}/patches/rename`)
      .set('Authorization', auth)
      .send({ from: 'auto0', to: 'interface' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.mesh.patches.map((p: { name: string }) => p.name)).toEqual(['interface', 'auto1']);
  });

  it('rejects renaming a patch onto an existing name (409 PATCH_EXISTS)', async () => {
    const { id, auth } = await makeProject('mr-dup@dive-turbinen.test');
    const { a } = await importTwoParts(id, auth);
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/${a}/patches/rename`)
      .set('Authorization', auth)
      .send({ from: 'inlet', to: 'ifaceA' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PATCH_EXISTS');
  });

  it('returns 404 when auto-patching an unknown mesh', async () => {
    setCommandRunner(autoPatchRunner);
    const { id, auth } = await makeProject('mr-404@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/meshes/ghost/auto-patch`)
      .set('Authorization', auth)
      .send({ featureAngle: 45 });
    expect(res.status).toBe(404);
  });
});
