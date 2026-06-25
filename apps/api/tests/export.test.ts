// Integration tests for the OpenFOAM -> CGNS export ("Export" tab). The real
// tools (ParaView pvbatch, OpenFOAM checkMesh, the VTK wheel) are not installed
// in CI, so the command runner is swapped for a fake that writes the artifacts
// the real tools would (a fake CGNS, a checkMesh report, the CgnsInspect JSON).
// This exercises the full orchestration: the solved-case gate, the 4-step
// pipeline, validation parsing, artifact download, and visibility scoping.
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandResult, type CommandRunner } from '../src/lib/commandRunner';
import { writeCaseFile } from '../src/lib/caseStorage';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
    walls { type wall; nFaces 20; startFace 120; }
)
`;

const CONTROL_DICT = `FoamFile { class dictionary; object controlDict; }
application     simpleFoam;
startTime       0;
endTime         100;
`;

const FIELD_U = `FoamFile { class volVectorField; object U; }
internalField uniform (0 0 0);
boundaryField { inlet { type fixedValue; value uniform (1 0 0); } }
`;

/** The JSON CgnsInspect.py would print for a healthy export. */
const CGNS_REPORT = {
  cellArrays: ['U', 'p'],
  pointArrays: [],
  nZones: 1,
  nCells: 100,
  nPoints: 80,
  emptyZones: 0,
  velocityMax: 12.3,
};

function ok(spec: { command: string; args: string[] }, stdout: string): CommandResult {
  return { command: spec.command, args: spec.args, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
}

/** A runner that simulates the whole export toolchain succeeding. */
const successRunner: CommandRunner = async (spec) => {
  if (spec.command === 'checkMesh') {
    return ok(spec, 'Mesh stats\npolyhedra: 0\nMesh OK.\n');
  }
  if (spec.args.some((a) => a.includes('FoamToCgns'))) {
    const out = spec.args.find((a) => a.endsWith('out.cgns'));
    if (out) await fs.writeFile(out, 'fake-cgns-bytes');
    return ok(spec, 'OK: CGNS written -> out.cgns');
  }
  if (spec.args.some((a) => a.includes('CgnsInspect'))) {
    return ok(spec, JSON.stringify(CGNS_REPORT));
  }
  return ok(spec, '');
};

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

/** Write a SOLVED case: mesh boundary, controlDict, and a time dir > 0 with fields. */
async function writeSolvedCase(projectId: string): Promise<void> {
  await writeCaseFile(projectId, 'constant/polyMesh/boundary', BOUNDARY);
  await writeCaseFile(projectId, 'system/controlDict', CONTROL_DICT);
  await writeCaseFile(projectId, '100/U', FIELD_U);
  await writeCaseFile(projectId, '100/p', 'FoamFile { object p; }\ninternalField uniform 0;\n');
}

const binaryParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setCommandRunner(successRunner);
});

afterEach(() => setCommandRunner(null));

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('POST /projects/:id/export', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('export-auth@dive-turbinen.test');
    const res = await request(app).post(`/api/v1/projects/${id}/export`);
    expect(res.status).toBe(401);
  });

  it('runs the full pipeline and reports each step + profile + validation', async () => {
    const { id, auth } = await makeProject('export-ok@dive-turbinen.test');
    await writeSolvedCase(id);

    const res = await request(app).post(`/api/v1/projects/${id}/export`).set('Authorization', auth);
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result.success).toBe(true);
    expect(result.steps.map((s: { id: string }) => s.id)).toEqual([
      'inspect',
      'convert',
      'validate',
      'cfdpost',
    ]);
    expect(result.steps.every((s: { status: string }) => s.status === 'success')).toBe(true);

    expect(result.profile.solver).toBe('simpleFoam');
    expect(result.profile.steady).toBe(true);
    expect(result.profile.incompressible).toBe(true);
    expect(result.profile.latestTime).toBe('100');
    expect(result.profile.fields).toEqual(['U', 'p']);
    expect(result.profile.patches).toEqual(['inlet', 'outlet', 'walls']);
    expect(result.profile.inletGuess).toBe('inlet');

    expect(result.validation.status).toBe('pass');
    expect(result.artifacts).toMatchObject({ cgns: true, session: true, memo: true, report: true });
  });

  it('fails the inspect step (and skips the rest) when the case is not solved', async () => {
    const { id, auth } = await makeProject('export-nosol@dive-turbinen.test');
    // Mesh + controlDict but NO time directory > 0 -> nothing to export.
    await writeCaseFile(id, 'constant/polyMesh/boundary', BOUNDARY);
    await writeCaseFile(id, 'system/controlDict', CONTROL_DICT);

    const res = await request(app).post(`/api/v1/projects/${id}/export`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(false);
    const steps = res.body.result.steps;
    expect(steps[0]).toMatchObject({ id: 'inspect', status: 'failed' });
    expect(steps[0].stderr).toMatch(/no solved results/i);
    expect(steps.slice(1).every((s: { status: string }) => s.status === 'skipped')).toBe(true);
    expect(res.body.result.artifacts.cgns).toBe(false);
  });

  it('fails convert (and skips validate/cfdpost) when pvbatch does not write the CGNS', async () => {
    setCommandRunner(async (spec) => {
      if (spec.command === 'checkMesh') return ok(spec, 'polyhedra: 0\n');
      if (spec.args.some((a) => a.includes('FoamToCgns'))) {
        // pvbatch exits non-zero and writes nothing.
        return { command: spec.command, args: spec.args, exitCode: 1, stdout: '', stderr: 'KO: segfault', durationMs: 1, timedOut: false };
      }
      return ok(spec, '');
    });
    const { id, auth } = await makeProject('export-convfail@dive-turbinen.test');
    await writeSolvedCase(id);

    const res = await request(app).post(`/api/v1/projects/${id}/export`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(false);
    const byId = Object.fromEntries(res.body.result.steps.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId).toMatchObject({ inspect: 'success', convert: 'failed', validate: 'skipped', cfdpost: 'skipped' });
    expect(res.body.result.artifacts.cgns).toBe(false);
  });

  it('returns 404 for a project the viewer cannot see', async () => {
    const { id } = await makeProject('export-owner@dive-turbinen.test');
    const stranger = await createTestUser({ email: 'export-stranger@dive-turbinen.test' });
    const res = await request(app)
      .post(`/api/v1/projects/${id}/export`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:id/export (+ download)', () => {
  it('returns null status before any export, then the profile/artifacts after', async () => {
    const { id, auth } = await makeProject('export-status@dive-turbinen.test');
    await writeSolvedCase(id);

    const before = await request(app).get(`/api/v1/projects/${id}/export`).set('Authorization', auth);
    expect(before.status).toBe(200);
    expect(before.body.status).toBeNull();

    await request(app).post(`/api/v1/projects/${id}/export`).set('Authorization', auth);

    const after = await request(app).get(`/api/v1/projects/${id}/export`).set('Authorization', auth);
    expect(after.status).toBe(200);
    expect(after.body.status.profile.solver).toBe('simpleFoam');
    expect(after.body.status.artifacts.cgns).toBe(true);
  });

  it('downloads the produced CGNS as an attachment', async () => {
    const { id, auth } = await makeProject('export-dl@dive-turbinen.test');
    await writeSolvedCase(id);
    await request(app).post(`/api/v1/projects/${id}/export`).set('Authorization', auth);

    const res = await request(app)
      .get(`/api/v1/projects/${id}/export/download/cgns`)
      .set('Authorization', auth)
      .buffer()
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('out.cgns');
    expect(res.body.toString()).toBe('fake-cgns-bytes');
  });

  it('returns 404 downloading an artifact that has not been produced', async () => {
    const { id, auth } = await makeProject('export-dl-missing@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/export/download/cgns`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown download artifact (422)', async () => {
    const { id, auth } = await makeProject('export-dl-bad@dive-turbinen.test');
    const res = await request(app)
      .get(`/api/v1/projects/${id}/export/download/banana`)
      .set('Authorization', auth);
    expect(res.status).toBe(422);
  });
});
