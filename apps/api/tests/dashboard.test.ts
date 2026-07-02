// Dashboard aggregate: server metrics shape + visibility-scoped run data.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, authHeader, createTestUser, resetDatabase } from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /dashboard', () => {
  it('returns server metrics and the viewer runs, scoped to visible projects', async () => {
    const owner = await createTestUser({ email: 'dash-owner@x.test' });
    const stranger = await createTestUser({ email: 'dash-stranger@x.test' });
    const project = await prisma.project.create({ data: { title: 'Dash', ownerId: owner.id } });
    await prisma.run.create({
      data: {
        projectId: project.id,
        solver: 'simpleFoam',
        status: 'running',
        command: '',
        logPath: '',
        startedAt: new Date(),
      },
    });
    await prisma.run.create({
      data: { projectId: project.id, solver: 'simpleFoam', status: 'converged', command: '', logPath: '' },
    });

    const res = await request(app).get('/api/v1/dashboard').set('Authorization', authHeader(owner));
    expect(res.status).toBe(200);
    // Server metrics shape.
    expect(typeof res.body.metrics.cpuPercent).toBe('number');
    expect(res.body.metrics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(res.body.metrics.cpuPercent).toBeLessThanOrEqual(100);
    expect(res.body.metrics.cores).toBeGreaterThan(0);
    expect(res.body.metrics.memTotalBytes).toBeGreaterThan(0);
    // The running run is active, carries its project title; counts are grouped.
    expect(res.body.activeRuns).toHaveLength(1);
    expect(res.body.activeRuns[0]).toMatchObject({
      solver: 'simpleFoam',
      status: 'running',
      projectTitle: 'Dash',
    });
    expect(res.body.recentRuns).toHaveLength(2);
    expect(res.body.runCounts.running).toBe(1);
    expect(res.body.runCounts.converged).toBe(1);
    expect(res.body.runCounts.failed).toBe(0);
    // Recent projects carry per-project run tallies (1 converged + 1 running = 2).
    expect(res.body.recentProjects).toHaveLength(1);
    expect(res.body.recentProjects[0]).toMatchObject({
      title: 'Dash',
      runCount: 2,
      converged: 1,
      diverged: 0,
      other: 1,
    });

    // A stranger sees none of the owner's runs.
    const strangerRes = await request(app)
      .get('/api/v1/dashboard')
      .set('Authorization', authHeader(stranger));
    expect(strangerRes.body.activeRuns).toHaveLength(0);
    expect(strangerRes.body.recentRuns).toHaveLength(0);
    expect(strangerRes.body.runCounts.running).toBe(0);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/dashboard');
    expect(res.status).toBe(401);
  });
});
