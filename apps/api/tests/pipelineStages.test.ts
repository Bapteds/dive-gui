// Completion hooks of the shared pipeline stages (WS-I spec §5, reused by WS-H):
// awaitRunTerminal resolves when finalizeRun settles a run (and at once for a row
// that is already terminal); awaitMeshingTerminal resolves when a meshing run
// ends (and at once for an idle / finished session). Fake stream runners only.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, logicalCommand, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';
import { writeCaseFile } from '../src/lib/caseStorage';
import {
  setStreamRunner,
  type StreamExit,
  type StreamHandle,
  type StreamSpec,
} from '../src/lib/streamRunner';
import { createSession, writeConfig, writeMeshStatus, writeStl } from '../src/lib/meshingStorage';
import { awaitMeshingTerminal, awaitRunTerminal } from '../src/lib/pipelineStages';
import { startMeshingRun } from '../src/modules/meshing/meshing.service';
import type { MeshingConfig } from '@dive/shared';

const BOUNDARY = `FoamFile { class polyBoundaryMesh; object boundary; }
2
(
    inlet { type patch; nFaces 10; startFace 100; }
    walls { type wall; nFaces 20; startFace 110; }
)
`;

/** A solver fake that converges after `delayMs`. */
function delayedSolver(delayMs: number): (spec: StreamSpec) => StreamHandle {
  return (spec) => {
    const onExit = (async (): Promise<StreamExit> => {
      await fs.mkdir(path.dirname(spec.logFile), { recursive: true });
      await new Promise((r) => setTimeout(r, delayMs));
      await fs.writeFile(
        spec.logFile,
        'Time = 1\nSIMPLE solution converged in 1 iterations\nEnd\n',
      );
      return { exitCode: 0, signal: null };
    })();
    return { pid: 77, onExit, stop: () => undefined };
  };
}

/** A mesher fake: each step exits 0 after `delayMs`, the mesher writes a polyMesh. */
function delayedMesher(delayMs: number): (spec: StreamSpec) => StreamHandle {
  return (spec) => {
    const { command, args } = logicalCommand(spec);
    const onExit = (async (): Promise<StreamExit> => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (command === 'cartesianMesh') {
        const i = args.indexOf('-case');
        const dir = path.join(i >= 0 ? args[i + 1] : spec.cwd, 'constant', 'polyMesh');
        await fs.mkdir(dir, { recursive: true });
        for (const f of ['points', 'faces', 'owner', 'neighbour', 'boundary']) {
          await fs.writeFile(path.join(dir, f), f === 'boundary' ? BOUNDARY : f);
        }
      }
      return { exitCode: 0, signal: null };
    })();
    return { pid: 78, onExit, stop: () => undefined };
  };
}

const CFMESH_CONFIG = {
  engine: 'cfmesh',
  maxCellSize: 0.2,
  extractFeatures: true,
  featureAngle: 45,
  addLayers: { enabled: false, nLayers: 3 },
  cores: 1,
} as unknown as MeshingConfig;

const STL =
  'solid walls\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid walls\n';

beforeEach(async () => {
  await resetDatabase();
});
afterEach(() => setStreamRunner(null));

describe('awaitRunTerminal', () => {
  it('resolves when finalizeRun settles the run', async () => {
    const user = await createTestUser({ email: 'stages@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: user.id } });
    const auth = authHeader(user);
    for (const name of ['points', 'faces', 'owner', 'neighbour']) {
      await writeCaseFile(project.id, `constant/polyMesh/${name}`, name);
    }
    await writeCaseFile(project.id, 'constant/polyMesh/boundary', BOUNDARY);
    await request(app)
      .post(`/api/v1/projects/${project.id}/runnable/scaffold`)
      .set('Authorization', auth);

    setStreamRunner(delayedSolver(150));
    const started = await request(app)
      .post(`/api/v1/projects/${project.id}/runs`)
      .set('Authorization', auth)
      .send({});
    expect(started.status).toBe(201);
    const run = await awaitRunTerminal(started.body.run.id as string);
    expect(run.status).toBe('converged');
  });

  it('resolves at once for a row that is already terminal', async () => {
    const user = await createTestUser({ email: 'stages2@dive-turbinen.test' });
    const project = await prisma.project.create({ data: { title: 'P', ownerId: user.id } });
    const row = await prisma.run.create({
      data: {
        projectId: project.id,
        solver: 'simpleFoam',
        status: 'failed',
        command: '',
        logPath: '',
      },
    });
    const run = await awaitRunTerminal(row.id);
    expect(run.status).toBe('failed');
  });
});

describe('awaitMeshingTerminal', () => {
  it('resolves when the meshing run ends', async () => {
    const meta = await createSession('Await mesh', 'cfmesh');
    await writeStl(meta.id, 'walls.stl', Buffer.from(STL));
    await writeConfig(meta.id, CFMESH_CONFIG);
    setStreamRunner(delayedMesher(40));
    await startMeshingRun(meta.id, CFMESH_CONFIG);
    const status = await awaitMeshingTerminal(meta.id);
    expect(status).toBe('succeeded');
  });

  it('resolves at once for a finished or never-run session', async () => {
    const meta = await createSession('Idle mesh', 'cfmesh');
    expect(await awaitMeshingTerminal(meta.id)).toBe('idle');
    await writeMeshStatus(meta.id, {
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    expect(await awaitMeshingTerminal(meta.id)).toBe('failed');
  });
});
