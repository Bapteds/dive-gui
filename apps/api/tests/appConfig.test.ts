import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers';

/**
 * Public feature-flag endpoint the web client reads at load. The project terminal is
 * OFF by default (TERMINAL_ENABLED unset in the test env), so the client hides the
 * Terminal button and the shell endpoint is never exposed unless an operator opts in.
 */
describe('GET /api/v1/config', () => {
  it('exposes feature flags without auth; terminal disabled by default', async () => {
    const res = await request(app).get('/api/v1/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ terminalEnabled: false });
  });
});
