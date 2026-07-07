// Slice 0 — runnable simpleFoam case: the solver-file renderers (unit) and the
// runnable gate + "make runnable" scaffold endpoints (integration). No external
// toolchain is involved here: this is pure file generation + presence checks.
import { promises as fs } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { readCaseFile, writeCaseFile } from '../src/lib/caseStorage';
import {
  carryTurbulenceInlet,
  parseApplication,
  renderDecomposeParDict,
  renderSolverFile,
  setApplication,
  setFieldPatchBc,
} from '../src/lib/openfoamCase';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls { type wall; nFaces 20; startFace 110; }
)
`;

/** Write the five polyMesh files so the case has a mesh (the boundary parses). */
async function writeMesh(projectId: string): Promise<void> {
  for (const name of ['points', 'faces', 'owner', 'neighbour']) {
    await writeCaseFile(projectId, `constant/polyMesh/${name}`, `${name}-data`);
  }
  await writeCaseFile(projectId, 'constant/polyMesh/boundary', BOUNDARY);
}

/** Create a project owned by a freshly created user. */
async function makeProject(email: string): Promise<{ auth: string; id: string }> {
  const user = await createTestUser({ email });
  const project = await prisma.project.create({ data: { title: 'Case', ownerId: user.id } });
  return { auth: authHeader(user), id: project.id };
}

beforeEach(async () => {
  await resetDatabase();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm('./test-storage', { recursive: true, force: true });
});

describe('renderSolverFile / parseApplication (unit)', () => {
  it('renders a simpleFoam controlDict whose application parses back', () => {
    const c = renderSolverFile('simpleFoam', 'system/controlDict', []);
    expect(c).toContain('application     simpleFoam;');
    expect(parseApplication(c)).toBe('simpleFoam');
  });

  it('renders turbulenceProperties with the k-omega SST model', () => {
    expect(renderSolverFile('simpleFoam', 'constant/turbulenceProperties', [])).toContain(
      'kOmegaSST',
    );
  });

  it('renders fvSolution with residualControl and fvSchemes with a real div scheme', () => {
    expect(renderSolverFile('simpleFoam', 'system/fvSolution', [])).toContain('residualControl');
    expect(renderSolverFile('simpleFoam', 'system/fvSchemes', [])).toContain('div(phi,U)');
  });

  it('is turbulence-model-aware: k-epsilon gets div(phi,epsilon) + an epsilon solver, no omega', () => {
    const schemes = renderSolverFile('simpleFoam', 'system/fvSchemes', [], 'kEpsilon');
    expect(schemes).toContain('div(phi,epsilon)');
    expect(schemes).not.toContain('div(phi,omega)');
    const solution = renderSolverFile('simpleFoam', 'system/fvSolution', [], 'kEpsilon');
    expect(solution).toContain('(U|k|epsilon)');
    expect(solution).toMatch(/"\(k\|epsilon\)"\s+1e-4;/); // residualControl entry
  });

  it('is turbulence-model-aware: Spalart-Allmaras solves nuTilda (no k/epsilon/omega div)', () => {
    const schemes = renderSolverFile('simpleFoam', 'system/fvSchemes', [], 'SpalartAllmaras');
    expect(schemes).toContain('div(phi,nuTilda)');
    expect(schemes).not.toContain('div(phi,k)');
    expect(renderSolverFile('simpleFoam', 'system/fvSolution', [], 'SpalartAllmaras')).toContain(
      '(U|nuTilda)',
    );
  });

  it('laminar drops every turbulence div scheme and keyed solver', () => {
    const schemes = renderSolverFile('simpleFoam', 'system/fvSchemes', [], 'laminar');
    expect(schemes).not.toContain('div(phi,k)');
    expect(schemes).not.toContain('div(phi,omega)');
    const solution = renderSolverFile('simpleFoam', 'system/fvSolution', [], 'laminar');
    expect(solution).toContain('"(U)"');
    expect(solution).not.toMatch(/"\(k\|omega\)"/);
  });

  it('compressible rhoSimpleFoam keeps energy AND adds the model turbulence fields (k-epsilon)', () => {
    const schemes = renderSolverFile('rhoSimpleFoam', 'system/fvSchemes', [], 'kEpsilon');
    expect(schemes).toContain('div(phi,e)');
    expect(schemes).toContain('div(phi,epsilon)');
    expect(renderSolverFile('rhoSimpleFoam', 'system/fvSolution', [], 'kEpsilon')).toContain(
      '(U|e|k|epsilon)',
    );
  });

  it('renders a transient pimpleFoam trio: PIMPLE algorithm, Euler ddt, adjustable dt', () => {
    const control = renderSolverFile('pimpleFoam', 'system/controlDict', []);
    expect(control).toContain('application     pimpleFoam;');
    expect(parseApplication(control)).toBe('pimpleFoam');
    expect(control).toContain('adjustTimeStep  yes;');
    expect(control).toContain('maxCo           1;');

    const schemes = renderSolverFile('pimpleFoam', 'system/fvSchemes', []);
    expect(schemes).toContain('default         Euler;');
    expect(schemes).not.toContain('steadyState');
    expect(schemes).toContain('div(phi,U)');

    const solution = renderSolverFile('pimpleFoam', 'system/fvSolution', []);
    expect(solution).toContain('PIMPLE');
    expect(solution).toContain('pRefCell');
    expect(solution).not.toContain('residualControl');
  });

  it('shares the transport/turbulence/0-fields between simpleFoam and pimpleFoam', () => {
    // The incompressible-RANS files are identical across the two solvers.
    for (const file of ['constant/transportProperties', 'constant/turbulenceProperties', '0/k'] as const) {
      expect(renderSolverFile('pimpleFoam', file, ['inlet'])).toBe(
        renderSolverFile('simpleFoam', file, ['inlet']),
      );
    }
  });

  it('renders compressible rhoSimpleFoam files: thermo, T, absolute p, energy scheme, no pRef', () => {
    expect(renderSolverFile('rhoSimpleFoam', 'constant/thermophysicalProperties', [])).toContain(
      'perfectGas',
    );
    expect(renderSolverFile('rhoSimpleFoam', '0/T', ['inlet'])).toContain('[0 0 0 1 0 0 0]');
    // Compressible p is ABSOLUTE pressure in Pa, not the incompressible kinematic p.
    expect(renderSolverFile('rhoSimpleFoam', '0/p', [])).toContain('[1 -1 -2 0 0 0 0]');
    expect(parseApplication(renderSolverFile('rhoSimpleFoam', 'system/controlDict', []))).toBe(
      'rhoSimpleFoam',
    );
    expect(renderSolverFile('rhoSimpleFoam', 'system/fvSchemes', [])).toContain('div(phi,e)');
    const solution = renderSolverFile('rhoSimpleFoam', 'system/fvSolution', []);
    expect(solution).toContain('rho'); // compressible rho solver / relaxation
    expect(solution).not.toContain('pRefCell'); // absolute pressure needs no reference
  });

  it('renders transient rhoPimpleFoam with PIMPLE + Euler', () => {
    expect(renderSolverFile('rhoPimpleFoam', 'system/fvSolution', [])).toContain('PIMPLE');
    expect(renderSolverFile('rhoPimpleFoam', 'system/fvSchemes', [])).toContain('default         Euler;');
    expect(parseApplication(renderSolverFile('rhoPimpleFoam', 'system/controlDict', []))).toBe(
      'rhoPimpleFoam',
    );
  });

  it('references every mesh patch in a 0/ field boundaryField', () => {
    const k = renderSolverFile('simpleFoam', '0/k', ['inlet', 'walls']);
    expect(k).toContain('inlet');
    expect(k).toContain('walls');
  });

  it('parseApplication ignores comments and returns null when absent', () => {
    expect(parseApplication('// application foo;\nstartTime 0;')).toBeNull();
    expect(parseApplication('application   pimpleFoam ;')).toBe('pimpleFoam');
  });

  it('renders decomposeParDict: scotch needs no coeffs; simple/hierarchical get a balanced grid', () => {
    const scotch = renderDecomposeParDict(4);
    expect(scotch).toMatch(/numberOfSubdomains\s+4/);
    expect(scotch).toContain('method          scotch;');
    expect(scotch).not.toContain('Coeffs');

    // A dependency-free fallback must carry an n (x y z) block whose product is N.
    const hierarchical = renderDecomposeParDict(6, 'hierarchical');
    expect(hierarchical).toContain('method          hierarchical;');
    expect(hierarchical).toMatch(/n\s+\(1 2 3\)/); // balanced factorization of 6 (product 6)
    const simple = renderDecomposeParDict(8, 'simple');
    expect(simple).toContain('simpleCoeffs');
    expect(simple).toMatch(/n\s+\(2 2 2\)/); // balanced factorization of 8
  });

  it('setApplication rewrites an existing application line and inserts a missing one', () => {
    expect(parseApplication(setApplication('application     foamRun;\n', 'simpleFoam'))).toBe(
      'simpleFoam',
    );
    // Preserves the rest of the dict.
    const dict = 'application     foamRun;\n\nendTime         1000;\n';
    const updated = setApplication(dict, 'simpleFoam');
    expect(updated).toContain('application     simpleFoam;');
    expect(updated).toContain('endTime         1000;');
    // Missing application line gets one added.
    expect(parseApplication(setApplication('startTime 0;\n', 'simpleFoam'))).toBe('simpleFoam');
  });
});

describe('carryTurbulenceInlet (unit)', () => {
  it('translates an omega mixing-length inlet into the epsilon one, keeping mixingLength', () => {
    const omega = renderSolverFile('simpleFoam', '0/omega', ['inlet', 'walls'], 'kOmegaSST');
    const omegaConfigured = setFieldPatchBc(
      omega,
      'inlet',
      'type            turbulentMixingLengthFrequencyInlet;\n        mixingLength    0.03;\n        value           uniform 1;',
    );
    const epsilon = renderSolverFile('simpleFoam', '0/epsilon', ['inlet', 'walls'], 'kEpsilon');
    const carried = carryTurbulenceInlet(epsilon, 'epsilon', omegaConfigured, 'omega');
    expect(carried).toMatch(/inlet\s*\{\s*type\s+turbulentMixingLengthDissipationRateInlet;/);
    expect(carried).toMatch(/mixingLength\s+0\.03;/);
  });

  it('leaves a non-mixing-length sibling inlet alone (generic default kept)', () => {
    const omega = renderSolverFile('simpleFoam', '0/omega', ['inlet', 'walls'], 'kOmegaSST');
    const epsilon = renderSolverFile('simpleFoam', '0/epsilon', ['inlet', 'walls'], 'kEpsilon');
    // The scaffolded omega inlet is a plain zeroGradient, not a mixing-length inlet.
    expect(carryTurbulenceInlet(epsilon, 'epsilon', omega, 'omega')).toBe(epsilon);
  });
});

describe('runnable gate + scaffoldSolver (integration)', () => {
  it('reports not runnable for a polyMesh-only case, listing the missing files', async () => {
    const { auth, id } = await makeProject('runnable-1@x.test');
    await writeMesh(id);

    const res = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.runnable.hasMesh).toBe(true);
    expect(res.body.runnable.runnable).toBe(false);
    expect(res.body.runnable.missingFiles).toContain('constant/turbulenceProperties');
    expect(res.body.runnable.missingFiles).toContain('0/k');
    expect(res.body.runnable.solver).toBeNull();
  });

  it('scaffolds the simpleFoam files and the case becomes runnable (idempotent)', async () => {
    const { auth, id } = await makeProject('runnable-2@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth);
    expect(scaffold.status).toBe(201);
    expect(scaffold.body.created).toContain('constant/turbulenceProperties');
    expect(scaffold.body.created).toContain('0/nut');
    expect(scaffold.body.runnable.runnable).toBe(true);
    expect(scaffold.body.runnable.solver).toBe('simpleFoam');

    // A second scaffold is a no-op: nothing is overwritten.
    const again = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth);
    expect(again.body.created).toHaveLength(0);
    expect(again.body.runnable.runnable).toBe(true);
  });

  it('scaffolds a pimpleFoam (transient) case and it becomes runnable', async () => {
    const { auth, id } = await makeProject('runnable-pimple@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'pimpleFoam' });
    expect(scaffold.status).toBe(201);
    expect(scaffold.body.runnable.runnable).toBe(true);
    expect(scaffold.body.runnable.solver).toBe('pimpleFoam');

    const control = (await readCaseFile(id, 'system/controlDict'))?.toString('utf8') ?? '';
    const schemes = (await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '';
    const solution = (await readCaseFile(id, 'system/fvSolution'))?.toString('utf8') ?? '';
    expect(control).toMatch(/application\s+pimpleFoam/);
    expect(schemes).toContain('Euler');
    expect(solution).toContain('PIMPLE');
  });

  it('switching solver re-renders the system trio (simpleFoam -> pimpleFoam)', async () => {
    const { auth, id } = await makeProject('runnable-switch@x.test');
    await writeMesh(id);

    // Start steady, then switch to transient: the system/ trio must be rewritten
    // for the PIMPLE algorithm and an Euler time scheme, but the shared
    // turbulence/transport/0-fields are kept (not re-created).
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    const switched = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'pimpleFoam' });
    expect(switched.status).toBe(201);
    expect(switched.body.created).toEqual(
      expect.arrayContaining(['system/controlDict', 'system/fvSchemes', 'system/fvSolution']),
    );
    expect(switched.body.created).not.toContain('constant/turbulenceProperties');
    expect(switched.body.created).not.toContain('0/k');
    expect(switched.body.runnable.runnable).toBe(true);
    expect(switched.body.runnable.solver).toBe('pimpleFoam');

    const schemes = (await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '';
    expect(schemes).toContain('Euler');
    expect(schemes).not.toContain('steadyState');
  });

  it('scaffolds a compressible rhoSimpleFoam case and it becomes runnable', async () => {
    const { auth, id } = await makeProject('runnable-rho@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'rhoSimpleFoam' });
    expect(scaffold.status).toBe(201);
    expect(scaffold.body.runnable.runnable).toBe(true);
    expect(scaffold.body.runnable.solver).toBe('rhoSimpleFoam');
    expect(scaffold.body.created).toEqual(
      expect.arrayContaining(['constant/thermophysicalProperties', '0/T', '0/alphat']),
    );
    const p = (await readCaseFile(id, '0/p'))?.toString('utf8') ?? '';
    expect(p).toContain('[1 -1 -2 0 0 0 0]'); // absolute pressure (Pa)
  });

  it('switching incompressible -> compressible rewrites the trio and 0/p to absolute pressure', async () => {
    const { auth, id } = await makeProject('runnable-switch-rho@x.test');
    await writeMesh(id);

    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    const pBefore = (await readCaseFile(id, '0/p'))?.toString('utf8') ?? '';
    expect(pBefore).toContain('[0 2 -2 0 0 0 0]'); // kinematic (incompressible)

    const switched = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'rhoSimpleFoam' });
    expect(switched.status).toBe(201);
    expect(switched.body.created).toEqual(
      expect.arrayContaining([
        'system/controlDict',
        'system/fvSchemes',
        'system/fvSolution',
        '0/p',
      ]),
    );
    expect(switched.body.runnable.runnable).toBe(true);
    expect(switched.body.runnable.solver).toBe('rhoSimpleFoam');

    const pAfter = (await readCaseFile(id, '0/p'))?.toString('utf8') ?? '';
    expect(pAfter).toContain('[1 -1 -2 0 0 0 0]'); // absolute (compressible)
    const schemes = (await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '';
    expect(schemes).toContain('div(phi,e)');
  });

  it('applies the chosen turbulence model and writes ONLY its fields (kEpsilon, no omega)', async () => {
    const { auth, id } = await makeProject('runnable-turb@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'kEpsilon' });
    expect(scaffold.status).toBe(201);
    expect(scaffold.body.runnable.runnable).toBe(true);

    const turb = (await readCaseFile(id, 'constant/turbulenceProperties'))?.toString('utf8') ?? '';
    expect(turb).toMatch(/RASModel\s+kEpsilon/);
    // k-epsilon reads epsilon, NOT omega: the app writes epsilon (with its wall
    // function on the wall patch) and ships no stale omega.
    const eps = (await readCaseFile(id, '0/epsilon'))?.toString('utf8') ?? '';
    expect(eps).toContain('[0 2 -3 0 0 0 0]');
    expect(eps).toMatch(/walls\s*\{[\s\S]*?epsilonWallFunction/);
    expect(await readCaseFile(id, '0/omega')).toBeNull();
  });

  it('carries the mixing-length inlet across a k-omega <-> k-epsilon switch', async () => {
    const { auth, id } = await makeProject('runnable-turb-inlet@x.test');
    await writeMesh(id);
    // Default k-omega scaffold, then configure the inlet omega as the mixing-length
    // frequency inlet (what the boundary-conditions overlay writes).
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    const omega0 = (await readCaseFile(id, '0/omega'))!.toString('utf8');
    await writeCaseFile(
      id,
      '0/omega',
      setFieldPatchBc(
        omega0,
        'inlet',
        'type            turbulentMixingLengthFrequencyInlet;\n        mixingLength    0.02;\n        value           uniform 1;',
      ),
    );

    // Switch to k-epsilon: the new epsilon inlet must become the dissipation-rate
    // inlet, keeping the mixingLength.
    await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'kEpsilon' });
    const eps = (await readCaseFile(id, '0/epsilon'))!.toString('utf8');
    expect(eps).toMatch(/inlet\s*\{\s*type\s+turbulentMixingLengthDissipationRateInlet;/);
    expect(eps).toMatch(/mixingLength\s+0\.02;/);

    // And back to k-omega: the omega inlet becomes the frequency inlet again.
    await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'kOmegaSST' });
    const omega = (await readCaseFile(id, '0/omega'))!.toString('utf8');
    expect(omega).toMatch(/inlet\s*\{\s*type\s+turbulentMixingLengthFrequencyInlet;/);
    expect(omega).toMatch(/mixingLength\s+0\.02;/);
  });

  it('re-renders system/fvSchemes + fvSolution when the turbulence model changes (same solver)', async () => {
    const { auth, id } = await makeProject('runnable-turb-trio@x.test');
    await writeMesh(id);
    // Default k-omega scaffold: the trio is written for k/omega.
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    expect((await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '').toContain(
      'div(phi,omega)',
    );

    // Switch turbulence to k-epsilon on the SAME solver: the system trio must be
    // re-rendered (this is exactly what used to be skipped), so fvSchemes gets
    // div(phi,epsilon) and fvSolution solves epsilon — otherwise the run aborts.
    const switched = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'kEpsilon' });
    expect(switched.status).toBe(201);
    expect(switched.body.created).toEqual(
      expect.arrayContaining(['system/fvSchemes', 'system/fvSolution']),
    );
    expect(switched.body.runnable.runnable).toBe(true);

    const schemes = (await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '';
    const solution = (await readCaseFile(id, 'system/fvSolution'))?.toString('utf8') ?? '';
    expect(schemes).toContain('div(phi,epsilon)');
    expect(schemes).not.toContain('div(phi,omega)');
    expect(solution).toContain('(U|k|epsilon)');
  });

  it('scaffolds model-aware wall functions on wall patches (k-omega default)', async () => {
    const { auth, id } = await makeProject('runnable-wallfn@x.test');
    await writeMesh(id);
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);

    const nut = (await readCaseFile(id, '0/nut'))?.toString('utf8') ?? '';
    const k = (await readCaseFile(id, '0/k'))?.toString('utf8') ?? '';
    const omega = (await readCaseFile(id, '0/omega'))?.toString('utf8') ?? '';
    const u = (await readCaseFile(id, '0/U'))?.toString('utf8') ?? '';
    // walls (type wall) get the k-omega wall functions automatically; inlet (patch) stays generic.
    expect(nut).toMatch(/walls\s*\{[\s\S]*?nutkWallFunction/);
    expect(k).toMatch(/walls\s*\{[\s\S]*?kqRWallFunction/);
    expect(omega).toMatch(/walls\s*\{[\s\S]*?omegaWallFunction/);
    expect(u).toMatch(/walls\s*\{\s*type\s+noSlip;/);
    expect(nut).toMatch(/inlet\s*\{\s*type\s+zeroGradient;/);
  });

  it('removes the stale 0/omega when switching k-omega -> k-epsilon (still runnable)', async () => {
    const { auth, id } = await makeProject('runnable-switch-turb@x.test');
    await writeMesh(id);
    // Start k-omega (default): 0/omega is created.
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    expect(await readCaseFile(id, '0/omega')).toBeTruthy();

    // Switch to k-epsilon: 0/omega must be removed, 0/epsilon written, case still runnable.
    const switched = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'kEpsilon' });
    expect(switched.status).toBe(201);
    expect(switched.body.removed).toContain('0/omega');
    expect(await readCaseFile(id, '0/omega')).toBeNull();
    expect(await readCaseFile(id, '0/epsilon')).toBeTruthy();
    expect(switched.body.runnable.runnable).toBe(true);
  });

  it('refreshes a retained field wall function on a model switch (k-omega -> Spalart-Allmaras)', async () => {
    const { auth, id } = await makeProject('runnable-wallfn-refresh@x.test');
    await writeMesh(id);
    // k-omega: 0/nut wall gets nutkWallFunction.
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    expect((await readCaseFile(id, '0/nut'))?.toString('utf8') ?? '').toMatch(
      /walls\s*\{[\s\S]*?nutkWallFunction/,
    );

    // Spalart-Allmaras has no k, so nut's wall function must switch to
    // nutUSpaldingWallFunction even though 0/nut is retained (not re-created).
    const switched = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'SpalartAllmaras' });
    expect(switched.status).toBe(201);
    const nut = (await readCaseFile(id, '0/nut'))?.toString('utf8') ?? '';
    expect(nut).toMatch(/walls\s*\{[\s\S]*?nutUSpaldingWallFunction/);
    expect(nut).not.toContain('nutkWallFunction');
    // k/omega dropped, nuTilda written.
    expect(await readCaseFile(id, '0/omega')).toBeNull();
    expect(await readCaseFile(id, '0/nuTilda')).toBeTruthy();
  });

  it('writes a laminar turbulenceProperties (no RAS block) when laminar is chosen', async () => {
    const { auth, id } = await makeProject('runnable-laminar@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'laminar' });
    expect(scaffold.status).toBe(201);

    const turb = (await readCaseFile(id, 'constant/turbulenceProperties'))?.toString('utf8') ?? '';
    expect(turb).toMatch(/simulationType\s+laminar/);
    expect(turb).not.toMatch(/RASModel/);
  });

  it('applies a Reynolds-stress model and writes its 0/R field (turbulence -> 0/ fields)', async () => {
    const { auth, id } = await makeProject('runnable-rstress@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'simpleFoam', turbulence: 'LRR' });
    expect(scaffold.status).toBe(201);

    const turb = (await readCaseFile(id, 'constant/turbulenceProperties'))?.toString('utf8') ?? '';
    expect(turb).toMatch(/RASModel\s+LRR/);
    // The Reynolds-stress tensor field is written so the model actually runs.
    const rField = (await readCaseFile(id, '0/R'))?.toString('utf8') ?? '';
    expect(rField).toMatch(/volSymmTensorField/);
    expect(rField).toMatch(/uniform \(0 0 0 0 0 0\)/);
  });

  it('scaffolds a base-tier solver as a guided incompressible scaffold (interFoam)', async () => {
    const { auth, id } = await makeProject('runnable-base@x.test');
    await writeMesh(id);

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth)
      .send({ solver: 'interFoam' });
    expect(scaffold.status).toBe(201);

    // The full incompressible base is written and controlDict points at interFoam.
    const control = (await readCaseFile(id, 'system/controlDict'))?.toString('utf8') ?? '';
    expect(control).toMatch(/application\s+interFoam/);
    expect(await readCaseFile(id, 'constant/turbulenceProperties')).toBeTruthy();
    expect(await readCaseFile(id, '0/k')).toBeTruthy();
    // interFoam is now guided (base tier): runnable AND scaffoldable.
    expect(scaffold.body.runnable.runnable).toBe(true);
    expect(scaffold.body.runnable.scaffoldable).toBe(true);
    expect(scaffold.body.runnable.solver).toBe('interFoam');
  });

  it('a base-tier solver gates on its full incompressible file set (interFoam)', async () => {
    const { auth, id } = await makeProject('runnable-base-gate@x.test');
    await writeMesh(id);
    // controlDict targets interFoam, but the rest of the incompressible set is absent.
    await writeCaseFile(
      id,
      'system/controlDict',
      'FoamFile { object controlDict; }\napplication interFoam;\n',
    );

    const res = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(res.body.runnable.solver).toBe('interFoam');
    expect(res.body.runnable.scaffoldable).toBe(true);
    expect(res.body.runnable.runnable).toBe(false);
    expect(res.body.runnable.missingFiles).toContain('system/fvSchemes');
  });

  it('reports scaffoldable=true for a configurable solver', async () => {
    const { auth, id } = await makeProject('runnable-scaffoldable@x.test');
    await writeMesh(id);
    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth);
    expect(scaffold.body.runnable.scaffoldable).toBe(true);
  });

  it('retargets a generic controlDict (application foamRun) to simpleFoam', async () => {
    const { auth, id } = await makeProject('runnable-foamrun@x.test');
    await writeMesh(id);
    // Simulate a case that came through the conversion flow: a generic controlDict.
    await writeCaseFile(
      id,
      'system/controlDict',
      'FoamFile { object controlDict; }\napplication     foamRun;\nendTime         1;\n',
    );

    const scaffold = await request(app)
      .post(`/api/v1/projects/${id}/runnable/scaffold`)
      .set('Authorization', auth);
    expect(scaffold.status).toBe(201);
    // The existing controlDict is not in `created` (kept), but its application
    // is retargeted to simpleFoam so the run uses the right binary.
    expect(scaffold.body.runnable.runnable).toBe(true);
    expect(scaffold.body.runnable.solver).toBe('simpleFoam');
  });

  it('treats a fully-filled case whose controlDict targets foamRun as not runnable', async () => {
    const { auth, id } = await makeProject('runnable-foamrun-full@x.test');
    await writeMesh(id);
    // Scaffold a complete simpleFoam case, then point controlDict back at foamRun.
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    await writeCaseFile(
      id,
      'system/controlDict',
      'FoamFile { object controlDict; }\napplication     foamRun;\n',
    );

    const res = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(res.body.runnable.missingFiles).toHaveLength(0);
    expect(res.body.runnable.solver).toBe('foamRun');
    expect(res.body.runnable.runnable).toBe(false); // gate re-offers "Make runnable"
  });

  it('repairs a generic system/ trio (adds pRefCell, real div schemes, endTime)', async () => {
    const { auth, id } = await makeProject('runnable-repair@x.test');
    await writeMesh(id);
    // Generic placeholders like the conversion flow scaffolds: no pRefCell, no
    // residualControl, `div none`, application foamRun, endTime 1.
    await writeCaseFile(
      id,
      'system/controlDict',
      'FoamFile { object controlDict; }\napplication     foamRun;\nendTime         1;\n',
    );
    await writeCaseFile(
      id,
      'system/fvSolution',
      'FoamFile { object fvSolution; }\nSIMPLE { nNonOrthogonalCorrectors 0; }\n',
    );
    await writeCaseFile(
      id,
      'system/fvSchemes',
      'FoamFile { object fvSchemes; }\ndivSchemes { default none; }\n',
    );

    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);

    const fvSolution = (await readCaseFile(id, 'system/fvSolution'))?.toString('utf8') ?? '';
    const fvSchemes = (await readCaseFile(id, 'system/fvSchemes'))?.toString('utf8') ?? '';
    const controlDict = (await readCaseFile(id, 'system/controlDict'))?.toString('utf8') ?? '';

    expect(fvSolution).toMatch(/pRefCell/);
    expect(fvSolution).toMatch(/residualControl/);
    expect(fvSchemes).toMatch(/div\(phi,U\)/);
    expect(controlDict).toMatch(/application\s+simpleFoam/);
    expect(controlDict).not.toMatch(/endTime\s+1\s*;/);
  });

  it('treats a complete case with a generic fvSolution (no pRefCell) as not runnable', async () => {
    const { auth, id } = await makeProject('runnable-generic-fvsol@x.test');
    await writeMesh(id);
    await request(app).post(`/api/v1/projects/${id}/runnable/scaffold`).set('Authorization', auth);
    // Regress the fvSolution to a generic placeholder (simpleFoam app stays).
    await writeCaseFile(
      id,
      'system/fvSolution',
      'FoamFile { object fvSolution; }\nSIMPLE { nNonOrthogonalCorrectors 0; }\n',
    );

    const res = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(res.body.runnable.solver).toBe('simpleFoam');
    expect(res.body.runnable.runnable).toBe(false); // generic numerics -> gate re-offers repair
  });

  it('reports not runnable when the mesh is absent', async () => {
    const { auth, id } = await makeProject('runnable-3@x.test');
    const res = await request(app).get(`/api/v1/projects/${id}/runnable`).set('Authorization', auth);
    expect(res.body.runnable.hasMesh).toBe(false);
    expect(res.body.runnable.runnable).toBe(false);
  });

  it('returns 404 for a stranger (no existence leak)', async () => {
    const { id } = await makeProject('runnable-owner@x.test');
    const stranger = await createTestUser({ email: 'runnable-stranger@x.test' });
    const res = await request(app)
      .get(`/api/v1/projects/${id}/runnable`)
      .set('Authorization', authHeader(stranger));
    expect(res.status).toBe(404);
  });
});

const BOUNDARY_3 = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls { type wall; nFaces 20; startFace 110; }
    front { type empty; nFaces 5; startFace 130; }
)
`;

const STALE_U = `FoamFile { class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    oldpatch
    {
        type            fixedValue;
        value           uniform (1 0 0);
    }
}
`;

describe('syncBoundaryFields (POST /files/sync-boundaries)', () => {
  it('rewrites field boundaryFields to match the mesh patches and their types', async () => {
    const { auth, id } = await makeProject('sync-bf@x.test');
    await writeCaseFile(id, 'constant/polyMesh/boundary', BOUNDARY_3);
    await writeCaseFile(id, '0/U', STALE_U);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/sync-boundaries`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.updated).toContain('0/U');

    const u = (await readCaseFile(id, '0/U'))?.toString('utf8') ?? '';
    expect(u).not.toContain('oldpatch');
    expect(u).toMatch(/inlet\s*\{\s*type\s+zeroGradient;/); // patch -> zeroGradient
    expect(u).toMatch(/walls\s*\{\s*type\s+noSlip;/); // wall + U -> noSlip
    expect(u).toMatch(/front\s*\{\s*type\s+empty;/); // empty -> empty
    // The header / dimensions / internalField are untouched.
    expect(u).toContain('internalField uniform (0 0 0)');
  });

  it('preserves a user-set inlet/outlet BC on a patch that still exists (merge, not rebuild)', async () => {
    const { auth, id } = await makeProject('sync-preserve@x.test');
    const boundary = `FoamFile { class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 10; startFace 100; }
    outlet { type patch; nFaces 10; startFace 110; }
    walls { type wall; nFaces 20; startFace 120; }
)
`;
    // A case that already carries the "boundary conditions" overlay's BCs.
    const p = `FoamFile { class volScalarField; object p; }
dimensions [0 2 -2 0 0 0 0];
internalField uniform 0;
boundaryField
{
    inlet
    {
        type            totalPressure;
        p0              uniform 39.24;
        gamma           1;
        value           uniform 39.24;
    }
    outlet
    {
        type            fixedValue;
        value           uniform 0;
    }
    walls
    {
        type            zeroGradient;
    }
}
`;
    await writeCaseFile(id, 'constant/polyMesh/boundary', boundary);
    await writeCaseFile(id, '0/p', p);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/sync-boundaries`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);

    const synced = (await readCaseFile(id, '0/p'))?.toString('utf8') ?? '';
    // The inlet keeps totalPressure (NOT reset to zeroGradient) and the outlet keeps
    // being the single static-pressure anchor.
    expect(synced).toContain('totalPressure');
    expect(synced).toContain('p0');
    expect(synced).toMatch(/outlet\s*\{\s*type\s+fixedValue;/);
    expect((synced.match(/fixedValue/g) ?? []).length).toBe(1);
  });

  it('returns 409 when there is no mesh boundary', async () => {
    const { auth, id } = await makeProject('sync-nomesh@x.test');
    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/sync-boundaries`)
      .set('Authorization', auth);
    expect(res.status).toBe(409);
  });

  it('seeds 0/ from 0.orig/ when 0/ is missing, and keeps 0.orig pristine', async () => {
    const { auth, id } = await makeProject('sync-orig@x.test');
    await writeCaseFile(id, 'constant/polyMesh/boundary', BOUNDARY_3);
    // The template provides a pristine 0.orig but no 0/.
    await writeCaseFile(id, '0.orig/U', STALE_U);

    const res = await request(app)
      .post(`/api/v1/projects/${id}/files/sync-boundaries`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);

    // 0/U was created from 0.orig/U and its boundaryField synced to the mesh.
    const zero = (await readCaseFile(id, '0/U'))?.toString('utf8') ?? '';
    expect(zero).toMatch(/inlet\s*\{\s*type\s+zeroGradient;/);
    expect(zero).toMatch(/front\s*\{\s*type\s+empty;/);
    expect(zero).not.toContain('oldpatch');

    // 0.orig/U is left untouched (still the template's original boundaryField).
    const orig = (await readCaseFile(id, '0.orig/U'))?.toString('utf8') ?? '';
    expect(orig).toContain('oldpatch');
  });
});
