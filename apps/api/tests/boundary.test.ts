// Tests for the "boundary conditions" overlay: the pure component BC renderers
// (locking the CFD contract from documents/*_BCs*.txt) and the apply endpoint.
// The CSV -> boundaryData step's command runner is swapped for a fake, so the
// draft-tube path runs without Python.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { setCommandRunner, type CommandRunner } from '../src/lib/commandRunner';
import { readCaseFile, writeCaseFile } from '../src/lib/caseStorage';
import {
  componentInletBc,
  componentOutletBc,
  fieldBcBody,
  parseBoundaryPatchesWithTypes,
} from '../src/lib/openfoamCase';

// ---------------------------------------------------------------------------
// Pure renderers: assert the exact BC bodies of the DIVE turbine templates.
// ---------------------------------------------------------------------------
describe('componentInletBc / componentOutletBc', () => {
  it('turbine pressure inlet: totalPressure with p0 = g*H and gamma', () => {
    const p = componentInletBc('p', {
      objectType: 'turbine',
      mode: 'pressure',
      values: { head: 50 },
      model: 'kOmegaSST',
    });
    expect(p).toContain('totalPressure');
    expect(p).toContain('490.5'); // 9.81 * 50
    expect(p).toContain('gamma');
    const u = componentInletBc('U', {
      objectType: 'turbine',
      mode: 'pressure',
      values: { head: 50 },
      model: 'kOmegaSST',
    });
    expect(u).toContain('pressureInletOutletVelocity');
  });

  it('pipe pressure inlet: totalPressure WITHOUT gamma; both ends pressureInletOutletVelocity', () => {
    const p = componentInletBc('p', {
      objectType: 'pipe',
      mode: 'pressure',
      values: { head: 10 },
      model: 'kOmegaSST',
    });
    expect(p).toContain('totalPressure');
    expect(p).not.toContain('gamma');
    const outU = componentOutletBc('U', { objectType: 'pipe', mode: 'pressure', model: 'kOmegaSST' });
    expect(outU).toContain('pressureInletOutletVelocity');
  });

  it('chamber flow-rate inlet: flowRateInletVelocity with extrapolateProfile false', () => {
    const u = componentInletBc('U', {
      objectType: 'chamber',
      mode: 'flowRate',
      values: { flowRate: 14 },
      model: 'kOmegaSST',
    });
    expect(u).toContain('flowRateInletVelocity');
    expect(u).toContain('constant 14');
    expect(u).toContain('extrapolateProfile');
    const p = componentInletBc('p', {
      objectType: 'chamber',
      mode: 'flowRate',
      values: { flowRate: 14 },
      model: 'kOmegaSST',
    });
    expect(p).toContain('zeroGradient');
  });

  it('pipe flow-rate inlet: flowRateInletVelocity WITHOUT extrapolateProfile', () => {
    const u = componentInletBc('U', {
      objectType: 'pipe',
      mode: 'flowRate',
      values: { flowRate: 14 },
      model: 'kOmegaSST',
    });
    expect(u).toContain('flowRateInletVelocity');
    expect(u).not.toContain('extrapolateProfile');
  });

  it('turbulence intensity default is higher for a draft tube (0.08) than others (0.05)', () => {
    const turbK = componentInletBc('k', {
      objectType: 'turbine',
      mode: 'pressure',
      values: { head: 5 },
      model: 'kOmegaSST',
    });
    expect(turbK).toContain('turbulentIntensityKineticEnergyInlet');
    expect(turbK).toContain('0.05');
    const draftK = componentInletBc('k', {
      objectType: 'draftTube',
      mode: 'csvProfile',
      values: {},
      model: 'kOmegaSST',
      csvFields: ['U'], // no k column -> intensity fallback, draft-tube default 0.08
    });
    expect(draftK).toContain('turbulentIntensityKineticEnergyInlet');
    expect(draftK).toContain('0.08');
  });

  it('draft tube inlet: mapped U; k mapped only when the CSV carries it', () => {
    const u = componentInletBc('U', {
      objectType: 'draftTube',
      mode: 'csvProfile',
      values: {},
      model: 'kOmegaSST',
    });
    expect(u).toContain('timeVaryingMappedFixedValue');
    const kMapped = componentInletBc('k', {
      objectType: 'draftTube',
      mode: 'csvProfile',
      values: {},
      model: 'kOmegaSST',
      csvFields: ['U', 'k'],
    });
    expect(kMapped).toContain('timeVaryingMappedFixedValue');
    const kFallback = componentInletBc('k', {
      objectType: 'draftTube',
      mode: 'csvProfile',
      values: {},
      model: 'kOmegaSST',
      csvFields: ['U'],
    });
    expect(kFallback).toContain('turbulentIntensityKineticEnergyInlet');
  });

  it('outlet pressure anchor: fixedValue 0 in general, fixedMeanValue for a draft tube', () => {
    const turbP = componentOutletBc('p', { objectType: 'turbine', mode: 'pressure', model: 'kOmegaSST' });
    expect(turbP).toContain('fixedValue');
    expect(turbP).not.toContain('fixedMeanValue');
    const draftP = componentOutletBc('p', { objectType: 'draftTube', mode: 'csvProfile', model: 'kOmegaSST' });
    expect(draftP).toContain('fixedMeanValue');
  });

  it('is turbulence-model aware: a k-epsilon inlet uses the dissipation-rate inlet', () => {
    const eps = componentInletBc('epsilon', {
      objectType: 'pipe',
      mode: 'flowRate',
      values: { flowRate: 5 },
      model: 'kEpsilon',
    });
    expect(eps).toContain('turbulentMixingLengthDissipationRateInlet');
  });

  it('a wall reuses the generic model-aware wall function', () => {
    expect(fieldBcBody('nut', 'wall', 'kOmegaSST')).toContain('WallFunction');
    expect(fieldBcBody('U', 'wall', 'kOmegaSST')).toContain('noSlip');
  });
});

// ---------------------------------------------------------------------------
// The apply endpoint (integration).
// ---------------------------------------------------------------------------
const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
4
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
    wall1 { type patch; nFaces 20; startFace 120; }
    wall2 { type patch; nFaces 20; startFace 140; }
)
`;

const MESH_FILES = [
  'constant/polyMesh/points',
  'constant/polyMesh/faces',
  'constant/polyMesh/owner',
  'constant/polyMesh/neighbour',
  'constant/polyMesh/boundary',
] as const;

/** CSV runner that writes boundaryData with U + k (no omega) and reports OK. */
const csvOkRunner: CommandRunner = async (spec) => {
  const caseDir = spec.args[2];
  const patch = spec.args[3];
  const dir = path.join(caseDir, 'constant', 'boundaryData', patch, '0');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'U'), '3\n((1 0 0)(1 0 0)(1 0 0))\n');
  await fs.writeFile(path.join(dir, 'k'), '3\n(0.1 0.1 0.1)\n');
  return { command: spec.command, args: spec.args, exitCode: 0, stdout: 'Wrote 3 points', stderr: '', durationMs: 1, timedOut: false };
};

/** CSV runner that fails (exit 1) and writes nothing. */
const csvFailRunner: CommandRunner = async (spec) => ({
  command: spec.command,
  args: spec.args,
  exitCode: 1,
  stdout: '',
  stderr: 'Missing required columns',
  durationMs: 1,
  timedOut: false,
});

async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

async function writePolyMesh(projectId: string): Promise<void> {
  for (const file of MESH_FILES) {
    await writeCaseFile(projectId, file, file.endsWith('boundary') ? BOUNDARY : `${file}-data`);
  }
}

function applyUrl(id: string): string {
  return `/api/v1/projects/${id}/boundary-conditions/apply`;
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
  setCommandRunner(csvOkRunner);
});

afterEach(() => {
  setCommandRunner(null);
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('POST /projects/:id/boundary-conditions/apply', () => {
  it('requires authentication', async () => {
    const { id } = await makeProject('bc-auth@dive-turbinen.test');
    const res = await request(app).post(applyUrl(id)).field('payload', JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it('returns 409 NO_MESH when the project has no polyMesh', async () => {
    const { id, auth } = await makeProject('bc-nomesh@dive-turbinen.test');
    const res = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field(
        'payload',
        JSON.stringify({ objectType: 'turbine', mode: 'pressure', inlet: 'inlet', outlet: 'outlet', walls: [], values: { head: 5 } }),
      );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_MESH');
  });

  it('applies a turbine pressure preset: total pressure inlet, single static anchor, walls', async () => {
    const { id, auth } = await makeProject('bc-turbine@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field(
        'payload',
        JSON.stringify({
          objectType: 'turbine',
          mode: 'pressure',
          inlet: 'inlet',
          outlet: 'outlet',
          walls: ['wall1', 'wall2'],
          values: { head: 50 },
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.applied.p0).toBeCloseTo(490.5, 3);
    expect(res.body.result.applied.walls).toEqual(['wall1', 'wall2']);

    const p = (await readCaseFile(id, '0/p'))!.toString('utf8');
    expect(p).toContain('totalPressure'); // inlet
    // Exactly one static-pressure anchor in the case: the outlet.
    expect((p.match(/fixedValue/g) ?? []).length).toBe(1);

    const u = (await readCaseFile(id, '0/U'))!.toString('utf8');
    expect(u).toContain('pressureInletOutletVelocity'); // inlet
    expect(u).toContain('noSlip'); // walls

    // The wall patches were retyped to `wall` in the mesh boundary file.
    const boundary = (await readCaseFile(id, 'constant/polyMesh/boundary'))!.toString('utf8');
    const types = parseBoundaryPatchesWithTypes(boundary);
    expect(types.find((t) => t.name === 'wall1')?.type).toBe('wall');
    expect(types.find((t) => t.name === 'wall2')?.type).toBe('wall');
  });

  it('rejects an unknown patch, an inlet == outlet, and a missing driving value', async () => {
    const { id, auth } = await makeProject('bc-invalid@dive-turbinen.test');
    await writePolyMesh(id);

    const unknown = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'turbine', mode: 'pressure', inlet: 'nope', outlet: 'outlet', walls: [], values: { head: 5 } }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('INVALID_BC_PLAN');

    const same = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'turbine', mode: 'pressure', inlet: 'inlet', outlet: 'inlet', walls: [], values: { head: 5 } }));
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('INVALID_BC_PLAN');

    const noHead = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'turbine', mode: 'pressure', inlet: 'inlet', outlet: 'outlet', walls: [], values: {} }));
    expect(noHead.status).toBe(422);
    expect(noHead.body.error.code).toBe('INVALID_BC_PLAN');
  });

  it('requires a CSV for a draft tube', async () => {
    const { id, auth } = await makeProject('bc-nocsv@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'draftTube', mode: 'csvProfile', inlet: 'inlet', outlet: 'outlet', walls: ['wall1', 'wall2'], values: {} }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BC_CSV_REQUIRED');
  });

  it('draft tube CSV: maps U + k, falls back for the absent omega, uses fixedMeanValue outlet', async () => {
    setCommandRunner(csvOkRunner);
    const { id, auth } = await makeProject('bc-draft@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'draftTube', mode: 'csvProfile', inlet: 'inlet', outlet: 'outlet', walls: ['wall1', 'wall2'], values: {} }))
      .attach('csv', Buffer.from('x,y,z,Ux,Uy,Uz,k\n0,0,0,1,0,0,0.1\n'), 'profile.csv');

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.csvSteps[0].status).toBe('success');

    const u = (await readCaseFile(id, '0/U'))!.toString('utf8');
    expect(u).toContain('timeVaryingMappedFixedValue');
    const k = (await readCaseFile(id, '0/k'))!.toString('utf8');
    expect(k).toContain('timeVaryingMappedFixedValue'); // CSV carried k -> mapped
    const omega = (await readCaseFile(id, '0/omega'))!.toString('utf8');
    expect(omega).toContain('turbulentMixingLengthFrequencyInlet'); // no omega column -> fallback
    const p = (await readCaseFile(id, '0/p'))!.toString('utf8');
    expect(p).toContain('fixedMeanValue'); // draft-tube outlet tolerates the swirl
    expect(res.body.result.notes.join(' ')).toMatch(/omega/);
  });

  it('draft tube CSV failure still applies the BCs and reports the failed step', async () => {
    setCommandRunner(csvFailRunner);
    const { id, auth } = await makeProject('bc-draft-fail@dive-turbinen.test');
    await writePolyMesh(id);
    const res = await request(app)
      .post(applyUrl(id))
      .set('Authorization', auth)
      .field('payload', JSON.stringify({ objectType: 'draftTube', mode: 'csvProfile', inlet: 'inlet', outlet: 'outlet', walls: ['wall1', 'wall2'], values: {} }))
      .attach('csv', Buffer.from('bogus\n'), 'profile.csv');

    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true); // the apply itself succeeded
    expect(res.body.result.csvSteps[0].status).toBe('failed');
    const u = (await readCaseFile(id, '0/U'))!.toString('utf8');
    expect(u).toContain('timeVaryingMappedFixedValue'); // BC written regardless of the toolchain
    expect(res.body.result.notes.join(' ')).toMatch(/did not complete/);
  });
});
