// Integration tests for the 3D mesh viewer ("Visualize" tab) endpoints. The
// real extractor (Python + PyVista) is not installed in CI, so the command
// runner is swapped for a fake that writes the artifacts the real script would
// (a tiny GLB + a JSON manifest) to the expected paths. This lets us exercise
// the full orchestration: the polyMesh gate, build-on-demand, geometry
// streaming, build-failure surfacing, visibility scoping, and cache reuse.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createProtectedAdmin, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { readCaseFile, writeCaseFile } from '../src/lib/caseStorage';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls { type wall; nFaces 20; startFace 110; }
)
`;

/** The five files that make up a polyMesh (full case-relative paths). */
const MESH_FILES = [
  'constant/polyMesh/points',
  'constant/polyMesh/faces',
  'constant/polyMesh/owner',
  'constant/polyMesh/neighbour',
  'constant/polyMesh/boundary',
] as const;

/** The manifest the real extractor would write (a bare patch list with edge ranges). */
const MANIFEST = [
  { name: 'inlet', type: 'patch', nFaces: 10, edgeOffset: 0, edgeCount: 8 },
  { name: 'walls', type: 'wall', nFaces: 20, edgeOffset: 8, edgeCount: 16 },
];

/** Minimal stand-in for a GLB: the magic header is enough for our byte assertions. */
const FAKE_GLB = Buffer.from('glTF\x02\x00\x00\x00fake-binary-gltf', 'binary');

/** Stand-in cell-edge buffer (24 vertices x 3 float32 = 288 bytes). */
const FAKE_EDGES = Buffer.from(new Float32Array(24 * 3).buffer);

/** Build a success CommandResult for a spec. */
function ok(spec: { command: string; args: string[] }, stdout: string): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/**
 * A fake runner that simulates the extractor succeeding: it writes the GLB and
 * the JSON manifest to the paths the service passes (argv[2] = glb, argv[3] =
 * manifest), then reports OK. Counts invocations so tests can assert cache reuse.
 */
let runCount = 0;
const successRunner: CommandRunner = async (spec) => {
  runCount += 1;
  const [, , glbPath, manifestPath] = spec.args;
  await fs.writeFile(glbPath, FAKE_GLB);
  await fs.writeFile(manifestPath, JSON.stringify(MANIFEST));
  // The real extractor writes edges.bin beside the GLB; the staleness check
  // requires it, so the fake must too (else every read would re-build).
  await fs.writeFile(path.join(path.dirname(glbPath), 'edges.bin'), FAKE_EDGES);
  return ok(spec, `OK: ${MANIFEST.length} patches -> ${glbPath}`);
};

/** A fake runner that fails (non-zero exit) and writes nothing. */
const failRunner: CommandRunner = async (spec) => {
  runCount += 1;
  return {
    command: spec.command,
    args: spec.args,
    exitCode: 1,
    stdout: '',
    stderr: 'KO: could not read the case',
    durationMs: 1,
    timedOut: false,
  };
};

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ userId: string; auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { userId: user.id, auth: authHeader(user), id: project.id };
}

/** Write the five polyMesh files so the server-side hasPolyMesh gate passes. */
async function writePolyMesh(projectId: string): Promise<void> {
  for (const file of MESH_FILES) {
    await writeCaseFile(projectId, file, file.endsWith('boundary') ? BOUNDARY : `${file}-data`);
  }
}

/** Collect a binary response body into a Buffer (supertest does not by default). */
const binaryParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  runCount = 0;
  setCommandRunner(successRunner);
});

afterEach(() => {
  setCommandRunner(null); // restore the real runner
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('GET /projects/:id/mesh/manifest', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('mesh-auth@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`);
    expect(res.status).toBe(401);
  });

  it('returns 409 NO_MESH when the project has no polyMesh', async () => {
    const { id, auth } = await makeProject('mesh-nomesh@dive-turbinen.test');
    const res = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_MESH');
    expect(runCount).toBe(0); // gated before any build
  });

  it('builds on demand and returns the patch manifest', async () => {
    const { id, auth } = await makeProject('mesh-ok@dive-turbinen.test');
    await writePolyMesh(id);

    const res = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.manifest.patches).toEqual(MANIFEST);
    expect(typeof res.body.manifest.generatedAt).toBe('string');
    expect(runCount).toBe(1);
  });

  it('reuses the cached render on a second call (does not re-run the extractor)', async () => {
    const { id, auth } = await makeProject('mesh-cache@dive-turbinen.test');
    await writePolyMesh(id);

    const first = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(first.status).toBe(200);
    const second = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(second.status).toBe(200);
    expect(runCount).toBe(1); // not stale -> no rebuild
  });

  it('returns 502 MESH_BUILD_FAILED when the extractor fails', async () => {
    setCommandRunner(failRunner);
    const { id, auth } = await makeProject('mesh-fail@dive-turbinen.test');
    await writePolyMesh(id);

    const res = await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('MESH_BUILD_FAILED');
  });

  it('returns 404 for a project the viewer cannot see (no existence leak)', async () => {
    const { id } = await makeProject('mesh-owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'mesh-stranger@dive-turbinen.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${id}/mesh/manifest`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:id/mesh/geometry', () => {
  it('streams the cached GLB with model/gltf-binary content type', async () => {
    const { id, auth } = await makeProject('mesh-geo@dive-turbinen.test');
    await writePolyMesh(id);
    // Manifest call builds the render first.
    await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/mesh/geometry`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('model/gltf-binary');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(FAKE_GLB)).toBe(true);
  });

  it('returns 409 MESH_NOT_BUILT when the geometry has not been built', async () => {
    const { id, auth } = await makeProject('mesh-geo-missing@dive-turbinen.test');
    await writePolyMesh(id); // mesh present, but no manifest call yet -> not built
    const res = await request(app).get(`/api/v1/projects/${id}/mesh/geometry`).set('Authorization', auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MESH_NOT_BUILT');
  });
});

describe('GET /projects/:id/mesh/edges', () => {
  it('streams the cell-edge buffer after the render is built', async () => {
    const { id, auth } = await makeProject('mesh-edges@dive-turbinen.test');
    await writePolyMesh(id);
    await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/mesh/edges`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(FAKE_EDGES)).toBe(true);
  });

  it('returns 404 when the render (and its edges) have not been built', async () => {
    const { id, auth } = await makeProject('mesh-edges-missing@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await request(app).get(`/api/v1/projects/${id}/mesh/edges`).set('Authorization', auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/mesh/rebuild', () => {
  it('forces a rebuild and returns the fresh manifest', async () => {
    const { id, auth } = await makeProject('mesh-rebuild@dive-turbinen.test');
    await writePolyMesh(id);

    await request(app).get(`/api/v1/projects/${id}/mesh/manifest`).set('Authorization', auth);
    expect(runCount).toBe(1);

    const res = await request(app).post(`/api/v1/projects/${id}/mesh/rebuild`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.manifest.patches).toEqual(MANIFEST);
    expect(runCount).toBe(2); // rebuild always re-runs
  });

  it('lets a super-admin rebuild another user’s project mesh', async () => {
    const { id } = await makeProject('mesh-admin@dive-turbinen.test');
    await writePolyMesh(id);
    const admin = await createProtectedAdmin();

    const res = await request(app)
      .post(`/api/v1/projects/${id}/mesh/rebuild`)
      .set('Authorization', authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.manifest.patches).toEqual(MANIFEST);
  });
});

/** A field file whose boundaryField references the boundary patches. */
const FIELD_U = `FoamFile { class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }
    walls
    {
        type            noSlip;
    }
}
`;

function rename(id: string, auth: string, from: string, to: string) {
  return request(app)
    .post(`/api/v1/projects/${id}/mesh/patches/rename`)
    .set('Authorization', auth)
    .send({ from, to });
}

describe('POST /projects/:id/mesh/patches/rename', () => {
  it('renames the patch in the boundary file and in field boundaryFields', async () => {
    const { id, auth } = await makeProject('mesh-rename@dive-turbinen.test');
    await writePolyMesh(id);
    await writeCaseFile(id, '0/U', FIELD_U);

    const res = await rename(id, auth, 'inlet', 'intake');
    expect(res.status).toBe(200);
    expect(res.body.patches).toContain('intake');
    expect(res.body.patches).not.toContain('inlet');

    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))?.toString('utf8') ?? '';
    expect(boundary).toContain('intake');
    expect(boundary).toMatch(/intake\s*\{/);
    expect(boundary).not.toMatch(/inlet\s*\{/);

    const field = (await readCaseFile(id, '0/U'))?.toString('utf8') ?? '';
    expect(field).toMatch(/intake\s*\{/);
    expect(field).not.toMatch(/inlet\s*\{/);
    // The other patch and the field's non-patch content are untouched.
    expect(field).toMatch(/walls\s*\{/);
    expect(field).toContain('internalField uniform (0 0 0)');
  });

  it('returns 409 PATCH_EXISTS when the new name collides with another patch', async () => {
    const { id, auth } = await makeProject('mesh-rename-collide@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await rename(id, auth, 'inlet', 'walls');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PATCH_EXISTS');
  });

  it('returns 404 when the source patch does not exist', async () => {
    const { id, auth } = await makeProject('mesh-rename-missing@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await rename(id, auth, 'ghost', 'intake');
    expect(res.status).toBe(404);
  });

  it('rejects an invalid new patch name (422)', async () => {
    const { id, auth } = await makeProject('mesh-rename-invalid@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await rename(id, auth, 'inlet', '2 bad name');
    expect(res.status).toBe(422);
  });

  it('returns 409 NO_MESH when there is no boundary file', async () => {
    const { id, auth } = await makeProject('mesh-rename-nomesh@dive-turbinen.test');
    const res = await rename(id, auth, 'inlet', 'intake');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_MESH');
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('mesh-rename-owner@dive-turbinen.test');
    await writePolyMesh(id);
    const stranger = await createTestUser({ email: 'mesh-rename-stranger@dive-turbinen.test' });
    const res = await rename(id, authHeader(stranger), 'inlet', 'intake');
    expect(res.status).toBe(404);
  });
});

/** The boundary autoPatch -overwrite would write: original patches replaced by auto-generated ones. */
const AUTO_BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    auto0 { type patch; nFaces 12; startFace 100; }
    auto1 { type patch; nFaces 8; startFace 112; }
    auto2 { type wall; nFaces 20; startFace 120; }
)
`;

/**
 * A fake runner for autoPatch: simulates `autoPatch <angle> -overwrite` by
 * rewriting constant/polyMesh/boundary (the -case dir is in argv) to the
 * auto-generated patches the real tool would produce, then reporting OK.
 */
const autoPatchRunner: CommandRunner = async (spec) => {
  runCount += 1;
  if (spec.command === 'autoPatch') {
    const caseDir = spec.args[spec.args.indexOf('-case') + 1];
    await fs.writeFile(path.join(caseDir, 'constant', 'polyMesh', 'boundary'), AUTO_BOUNDARY);
    return ok(spec, 'Feature angle 45\nWriting patched mesh\nEnd\n');
  }
  return ok(spec, '');
};

function autoPatch(id: string, auth: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/projects/${id}/mesh/auto-patch`)
    .set('Authorization', auth)
    .send(body);
}

describe('POST /projects/:id/mesh/auto-patch', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('mesh-autopatch-auth@dive-turbinen.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/mesh/auto-patch`)
      .send({ featureAngle: 45 });
    expect(res.status).toBe(401);
  });

  it('runs autoPatch and returns the resulting patches (angle defaults to 45)', async () => {
    setCommandRunner(autoPatchRunner);
    const { id, auth } = await makeProject('mesh-autopatch-ok@dive-turbinen.test');
    await writePolyMesh(id);

    const res = await autoPatch(id, auth, {}); // featureAngle omitted -> defaults to 45
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.command).toContain('autoPatch');
    expect(res.body.result.command).toContain('45');
    expect(res.body.result.command).toContain('-overwrite');
    expect(res.body.result.patches).toEqual(['auto0', 'auto1', 'auto2']);

    // -overwrite actually rewrote the mesh boundary in place.
    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))?.toString('utf8') ?? '';
    expect(boundary).toMatch(/auto0\s*\{/);
    expect(boundary).not.toMatch(/inlet\s*\{/);
  });

  it('passes a custom feature angle through to the command', async () => {
    setCommandRunner(autoPatchRunner);
    const { id, auth } = await makeProject('mesh-autopatch-angle@dive-turbinen.test');
    await writePolyMesh(id);

    const res = await autoPatch(id, auth, { featureAngle: 30 });
    expect(res.status).toBe(200);
    expect(res.body.result.command).toContain('autoPatch 30 -overwrite');
  });

  it('reports a tool failure as success:false with the captured logs (HTTP 200)', async () => {
    setCommandRunner(failRunner);
    const { id, auth } = await makeProject('mesh-autopatch-fail@dive-turbinen.test');
    await writePolyMesh(id);

    const res = await autoPatch(id, auth, { featureAngle: 45 });
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(false);
    expect(res.body.result.exitCode).toBe(1);
    expect(res.body.result.stderr).toContain('could not read the case');
  });

  it('returns 409 NO_MESH when the project has no polyMesh', async () => {
    const { id, auth } = await makeProject('mesh-autopatch-nomesh@dive-turbinen.test');
    const res = await autoPatch(id, auth, { featureAngle: 45 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_MESH');
    expect(runCount).toBe(0); // gated before any command runs
  });

  it('rejects a feature angle outside [0, 180] (422)', async () => {
    const { id, auth } = await makeProject('mesh-autopatch-bad@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await autoPatch(id, auth, { featureAngle: 999 });
    expect(res.status).toBe(422);
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('mesh-autopatch-owner@dive-turbinen.test');
    await writePolyMesh(id);
    const stranger = await createTestUser({ email: 'mesh-autopatch-stranger@dive-turbinen.test' });
    const res = await autoPatch(id, authHeader(stranger), { featureAngle: 45 });
    expect(res.status).toBe(404);
  });
});
