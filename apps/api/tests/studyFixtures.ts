// Shared fixtures of the optimisation-study suites (studies.test.ts,
// studyRunner.test.ts). No CadQuery, mesher, OpenFOAM or Optuna runs: the
// command runner fake plays buildChamber.py (GLB + manifest + trisurface.zip),
// optimiseSuggest.py (`OK: {"params": …}`) and postProcess (diveVortexMetrics
// line); the stream runner fake plays cartesianMesh (constant/polyMesh), checkMesh
// ("Mesh OK." or failed checks) and simpleFoam (WS-G monitor lines + a time dir).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import request from 'supertest';
import type { ChamberInput, MeshingConfig } from '@dive/shared';
import { app, authHeader, createTestUser, logicalCommand } from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';
import type { CommandResult, CommandRunner, CommandSpec } from '../src/lib/commandRunner';
import type { StreamExit, StreamHandle, StreamSpec } from '../src/lib/streamRunner';
import {
  createSession,
  sessionPolyMeshDir,
  writeConfig,
  writeStl,
} from '../src/lib/meshingStorage';

/** The base design of the fixtures (mid-range inputs; width 4450, HLE 600 mm). */
export const BASE_INPUT: ChamberInput = { x1: 1450, x2: 7.85, x3: 8 };

// --- A one-cell cube mesh with the chamber patches ---------------------------

const POINTS = `FoamFile { version 2.0; format ascii; class vectorField; object points; }
8
(
(0 0 0)
(1 0 0)
(1 1 0)
(0 1 0)
(0 0 1)
(1 0 1)
(1 1 1)
(0 1 1)
)
`;
const FACES = `FoamFile { version 2.0; format ascii; class faceList; object faces; }
6
(
4(0 4 7 3)
4(1 2 6 5)
4(0 3 2 1)
4(0 1 5 4)
4(3 7 6 2)
4(4 5 6 7)
)
`;
const OWNER = `FoamFile { version 2.0; format ascii; class labelList; object owner; }
6
(
0
0
0
0
0
0
)
`;
const NEIGHBOUR = `FoamFile { version 2.0; format ascii; class labelList; object neighbour; }
0
(
)
`;
const BOUNDARY = `FoamFile { version 2.0; format ascii; class polyBoundaryMesh; object boundary; }
3
(
    inlet { type patch; nFaces 1; startFace 0; }
    outlet { type patch; nFaces 1; startFace 1; }
    walls { type wall; nFaces 4; startFace 2; }
)
`;

export const POLY_MESH: Record<string, string> = {
  points: POINTS,
  faces: FACES,
  owner: OWNER,
  neighbour: NEIGHBOUR,
  boundary: BOUNDARY,
};

export async function writePolyMesh(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(POLY_MESH)) {
    await fs.writeFile(path.join(dir, name), content);
  }
}

/** A one-triangle ASCII STL solid. */
export function stlSolid(name: string, z = 0): string {
  return [
    `solid ${name}`,
    '  facet normal 0 0 1',
    '    outer loop',
    `      vertex 0 0 ${z}`,
    `      vertex 1 0 ${z}`,
    `      vertex 1 1 ${z}`,
    '    endloop',
    '  endfacet',
    `endsolid ${name}`,
    '',
  ].join('\n');
}

const CFMESH_CONFIG = {
  engine: 'cfmesh',
  maxCellSize: 0.2,
  extractFeatures: false,
  featureAngle: 45,
  addLayers: { enabled: false, nLayers: 3 },
  cores: 1,
} as unknown as MeshingConfig;

/** A meshed cfMesh session with the chamber surfaces (the reference session). */
export async function makeSourceSession(name = 'Chamber reference'): Promise<string> {
  const meta = await createSession(name, 'cfmesh');
  for (const patch of ['inlet', 'outlet', 'walls']) {
    await writeStl(meta.id, `${patch}.stl`, Buffer.from(stlSolid(patch)));
  }
  await writeConfig(meta.id, CFMESH_CONFIG);
  await writePolyMesh(sessionPolyMeshDir(meta.id));
  return meta.id;
}

export interface StudyProject {
  projectId: string;
  userId: string;
  auth: string;
  sessionId: string;
  saveId: string;
}

/**
 * A project whose case has the cube mesh and scaffolded simpleFoam files, a
 * reference meshing session and a chamber save of `input`.
 */
export async function makeStudyProject(
  opts: { email?: string; input?: ChamberInput; saveName?: string } = {},
): Promise<StudyProject> {
  const user = await createTestUser({ email: opts.email ?? 'study@dive-turbinen.test' });
  const project = await prisma.project.create({
    data: { title: 'Chamber study', ownerId: user.id },
  });
  const auth = authHeader(user);
  for (const [name, content] of Object.entries(POLY_MESH)) {
    await writeCaseFile(project.id, `constant/polyMesh/${name}`, content);
  }
  await request(app)
    .post(`/api/v1/projects/${project.id}/runnable/scaffold`)
    .set('Authorization', auth)
    .expect(201);
  const sessionId = await makeSourceSession();
  const save = await prisma.chamberSave.create({
    data: {
      name: opts.saveName ?? `Base design ${Math.random().toString(36).slice(2, 7)}`,
      ownerId: user.id,
      snapshot: JSON.stringify(opts.input ?? BASE_INPUT),
    },
  });
  return { projectId: project.id, userId: user.id, auth, sessionId, saveId: save.id };
}

// --- Fakes -----------------------------------------------------------------------

function ok(spec: CommandSpec, stdout = 'OK'): CommandResult {
  return {
    command: spec.command,
    args: spec.args,
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
  };
}

function caseOf(args: string[], fallback: string): string {
  const i = args.indexOf('-case');
  return i >= 0 ? args[i + 1] : fallback;
}

/** How one simulated solve ends. */
export type SolveOutcome = 'converged' | 'budget' | 'diverged' | 'hang';

export interface StudyFakeOptions {
  /** KO refusal message for a design (read from the build's input.json), or null. */
  refuse?: (input: ChamberInput) => string | null;
  /** Suggestions returned in order by optimiseSuggest.py (then a walk over the grid). */
  suggestions?: Record<string, number>[];
  /** Mesher failure of the n-th meshing run (0-based). */
  meshFails?: (n: number) => boolean;
  /** checkMesh failed checks on the n-th meshing run (0-based). */
  checkMeshFails?: (n: number) => boolean;
  /** Outcome of the n-th solve (0-based). Default converged. */
  solve?: (n: number) => SolveOutcome;
  /** Δp₀ (Pa) of the n-th solve. Default 19620 (2 m at rho 1000). */
  dp0?: (n: number) => number;
  /** Vortex metrics of the n-th post-process. */
  vortex?: (n: number) => { maskedQVolume: number; omegaRms: number };
  /** suggest KO message (the optimiser is unavailable). */
  suggestFails?: string;
}

export interface StudyFakeState {
  builds: ChamberInput[];
  suggestRequests: {
    space: { key: string; low: number; high: number; step: number }[];
    history: {
      params: Record<string, number>;
      values: number[] | null;
      state: string;
      feasible?: boolean;
    }[];
    sampler: string;
    mode: string;
    seed: number | null;
  }[];
  meshRuns: number;
  solves: number;
  postProcess: number;
}

export function studyFakes(opts: StudyFakeOptions = {}): {
  commandRunner: CommandRunner;
  streamRunner: (spec: StreamSpec) => StreamHandle;
  state: StudyFakeState;
} {
  const state: StudyFakeState = {
    builds: [],
    suggestRequests: [],
    meshRuns: 0,
    solves: 0,
    postProcess: 0,
  };
  const queue = [...(opts.suggestions ?? [])];

  const commandRunner: CommandRunner = async (spec) => {
    const { command, args } = logicalCommand(spec);
    const script = args[0] ?? '';
    if (script.endsWith('buildChamber.py')) {
      const outDir = args[2];
      const input = JSON.parse(
        await fs.readFile(path.join(outDir, 'input.json'), 'utf8'),
      ) as ChamberInput;
      state.builds.push(input);
      const ko = opts.refuse?.(input);
      if (ko) return { ...ok(spec, ''), exitCode: 1, stderr: `KO: ${ko}\n` };
      const exportsDir = path.join(outDir, 'exports');
      await fs.mkdir(exportsDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify([]));
      await fs.writeFile(path.join(outDir, 'edges.bin'), Buffer.alloc(0));
      const zip = new AdmZip();
      for (const patch of ['inlet', 'outlet', 'walls']) {
        zip.addFile(`${patch}.stl`, Buffer.from(stlSolid(patch)));
      }
      zip.addFile('domain.stl', Buffer.from(stlSolid('domain')));
      await fs.writeFile(path.join(exportsDir, 'trisurface.zip'), zip.toBuffer());
      await fs.writeFile(path.join(outDir, 'chamber.glb'), Buffer.from('glTF-fake'));
      return ok(spec, 'OK: 3 patches');
    }
    if (script.endsWith('optimiseSuggest.py')) {
      const req = JSON.parse(
        await fs.readFile(args[1], 'utf8'),
      ) as StudyFakeState['suggestRequests'][number];
      state.suggestRequests.push(req);
      if (opts.suggestFails)
        return { ...ok(spec, ''), exitCode: 1, stderr: `KO: ${opts.suggestFails}\n` };
      let params = queue.shift();
      if (!params) {
        const n = state.suggestRequests.length;
        params = Object.fromEntries(
          req.space.map((s) => {
            const steps = Math.max(1, Math.round((s.high - s.low) / s.step));
            return [s.key, s.low + s.step * (n % (steps + 1))];
          }),
        );
      }
      return ok(spec, `OK: ${JSON.stringify({ params })}\n`);
    }
    if (command === 'postProcess') {
      const n = state.postProcess;
      state.postProcess += 1;
      const v = opts.vortex?.(n) ?? { maskedQVolume: 0.5, omegaRms: 12 };
      return ok(
        spec,
        `diveVortexMetrics: time=3 qVolume=${v.maskedQVolume * 2} maskedQVolume=${v.maskedQVolume} omegaRms=${v.omegaRms} coreVolume=0.3 coreCells=42\nEnd\n`,
      );
    }
    return ok(spec);
  };

  const streamRunner = (spec: StreamSpec): StreamHandle => {
    const { command, args } = logicalCommand(spec);
    let resolveExit!: (exit: StreamExit) => void;
    const onExit = new Promise<StreamExit>((r) => {
      resolveExit = r;
    });
    void (async () => {
      await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
      if (command === 'cartesianMesh' || command === 'snappyHexMesh') {
        const n = state.meshRuns;
        state.meshRuns += 1;
        (spec as StreamSpec & { __n?: number }).__n = n;
        if (opts.meshFails?.(n)) {
          await fs.appendFile(spec.logFile, 'FOAM FATAL ERROR: bad surface\n');
          resolveExit({ exitCode: 1, signal: null });
          return;
        }
        await writePolyMesh(path.join(caseOf(args, spec.cwd), 'constant', 'polyMesh'));
        await fs.appendFile(spec.logFile, '[cartesianMesh] ran\n');
        resolveExit({ exitCode: 0, signal: null });
        return;
      }
      if (command === 'checkMesh') {
        const n = state.meshRuns - 1;
        const failed = opts.checkMeshFails?.(n) ?? false;
        await fs.appendFile(
          spec.logFile,
          failed
            ? 'Mesh stats\n    cells:            1\n ***High aspect ratio cells found, Max aspect ratio: 1500, number of cells 12\n ***Zero or negative cell volume detected.\n\nFailed 2 mesh checks.\n\nEnd\n'
            : 'Mesh stats\n    cells:            1\n\nMesh OK.\n\nEnd\n',
        );
        resolveExit({ exitCode: failed ? 1 : 0, signal: null });
        return;
      }
      if (command === 'simpleFoam') {
        const n = state.solves;
        state.solves += 1;
        const outcome = opts.solve?.(n) ?? 'converged';
        const dp0 = opts.dp0?.(n) ?? 19620;
        const caseDir = caseOf(args, spec.cwd);
        const lines: string[] = [];
        for (let t = 1; t <= 3; t += 1) {
          lines.push(`Time = ${t}`, '');
          lines.push(
            outcome === 'diverged' && t === 3
              ? 'GAMG:  Solving for p, Initial residual = nan, Final residual = nan, No Iterations 1'
              : 'GAMG:  Solving for p, Initial residual = 0.01, Final residual = 1e-4, No Iterations 5',
          );
          lines.push('surfaceFieldValue inlet_p0_flux write:');
          lines.push(`    weightedAverage(inlet) of pTotal = ${dp0 + 1000}`, '');
          lines.push('surfaceFieldValue outlet_p0_flux write:');
          lines.push('    weightedAverage(outlet) of pTotal = 1000', '');
        }
        await fs.writeFile(spec.logFile, `${lines.join('\n')}\n`);
        if (outcome === 'hang') return; // until stopped
        if (outcome === 'converged') {
          await fs.appendFile(spec.logFile, 'SIMPLE solution converged in 3 iterations\n\nEnd\n');
        } else if (outcome === 'budget') {
          await fs.appendFile(spec.logFile, '\nEnd\n');
        }
        await fs.mkdir(path.join(caseDir, '3'), { recursive: true });
        await fs.writeFile(path.join(caseDir, '3', 'U'), 'result');
        resolveExit({ exitCode: 0, signal: null });
        return;
      }
      await fs.appendFile(spec.logFile, `[${command}] ran\n`);
      resolveExit({ exitCode: 0, signal: null });
    })();
    return { pid: 4242, onExit, stop: () => resolveExit({ exitCode: null, signal: 'SIGTERM' }) };
  };

  return { commandRunner, streamRunner, state };
}

/** The create body of a study on the fixture save, overridable. */
export function studyBody(
  f: StudyProject,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Width sweep',
    base: { kind: 'save', saveId: f.saveId },
    keys: ['width'],
    meshingSourceId: f.sessionId,
    ...extra,
  };
}

/** Base URL of a project's studies. */
export function studiesUrl(f: { projectId: string }): string {
  return `/api/v1/projects/${f.projectId}/studies`;
}

/** Poll GET /studies/:id until `done(detail)` or the deadline. */
export async function waitForStudy(
  f: StudyProject,
  studyId: string,
  done: (detail: {
    study: Record<string, unknown>;
    evaluations: Record<string, unknown>[];
  }) => boolean,
  timeoutMs = 20000,
): Promise<{
  study: Record<string, unknown>;
  evaluations: Record<string, unknown>[];
  best: number | null;
  paretoFront: number[];
}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app)
      .get(`${studiesUrl(f)}/${studyId}`)
      .set('Authorization', f.auth);
    if (res.status !== 200) throw new Error(`GET study answered ${res.status}`);
    if (done(res.body)) return res.body;
    if (Date.now() > deadline) {
      const last = (res.body.evaluations as { index: number; status: string }[]).at(-1);
      throw new Error(
        `study stuck at ${res.body.study.status} (evaluation ${last?.index}: ${last?.status})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A study that is no longer running. */
export const settled = (d: { study: Record<string, unknown> }) =>
  !['running', 'pausing'].includes(d.study.status as string);
