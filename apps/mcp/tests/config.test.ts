import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

// The DIVE_* env is injected by vitest.config.ts. Snapshot + restore it around
// each test so a mutation in one test never leaks into another.
const KEYS = [
  'DIVE_API_URL',
  'DIVE_MCP_EMAIL',
  'DIVE_MCP_PASSWORD',
  'DIVE_MCP_TIMEOUT_MS',
  'DIVE_MCP_SLOW_TIMEOUT_MS',
  'DIVE_MCP_RETRIES',
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig', () => {
  it('reads a valid config and strips trailing slashes from the API url', () => {
    process.env.DIVE_API_URL = 'http://x/api/v1///';
    const c = loadConfig();
    expect(c.apiUrl).toBe('http://x/api/v1');
    expect(c.email).toBe('mcp-test@dive.local');
    expect(c.timeoutMs).toBe(5000);
    expect(c.slowTimeoutMs).toBe(9000);
    expect(c.retries).toBe(2);
  });

  it('applies defaults when the optional vars are unset', () => {
    delete process.env.DIVE_MCP_TIMEOUT_MS;
    delete process.env.DIVE_MCP_SLOW_TIMEOUT_MS;
    delete process.env.DIVE_MCP_RETRIES;
    const c = loadConfig();
    expect(c.timeoutMs).toBe(60_000);
    expect(c.slowTimeoutMs).toBe(600_000);
    expect(c.retries).toBe(2);
  });

  it('never lets the slow timeout fall below the ordinary timeout', () => {
    process.env.DIVE_MCP_TIMEOUT_MS = '120000';
    process.env.DIVE_MCP_SLOW_TIMEOUT_MS = '1000';
    expect(loadConfig().slowTimeoutMs).toBe(120_000);
  });

  it('throws an actionable error when a required var is missing', () => {
    delete process.env.DIVE_API_URL;
    expect(() => loadConfig()).toThrow(/DIVE_API_URL/);
  });

  it('rejects a non-positive timeout', () => {
    process.env.DIVE_MCP_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow(/DIVE_MCP_TIMEOUT_MS/);
  });

  it('allows retries=0 (opt-out) but rejects a negative value', () => {
    process.env.DIVE_MCP_RETRIES = '0';
    expect(loadConfig().retries).toBe(0);
    process.env.DIVE_MCP_RETRIES = '-1';
    expect(() => loadConfig()).toThrow(/DIVE_MCP_RETRIES/);
  });
});
