// Runtime configuration for the DIVE MCP server.
// Loads apps/mcp/.env (resolved relative to this file so it works regardless of
// the process CWD Claude Code launches us from) and validates the required vars.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// src/ -> package root (apps/mcp) -> .env
loadDotenv({ path: resolve(here, '..', '.env') });

/** Read a required env var or fail with an actionable message. */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `${name} is not set. Copy apps/mcp/.env.example to apps/mcp/.env and fill it in.`,
    );
  }
  return value.trim();
}

/**
 * Read an optional integer env var, falling back to `fallback` when unset/blank.
 * `min` bounds the accepted value (default 1 — a positive integer). A present but
 * out-of-range or non-numeric value is a hard error, so a typo never silently
 * degrades to the default.
 */
function optionalInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}.`);
  }
  return value;
}

/** Validated configuration, resolved once at module load. */
export interface Config {
  /** API base URL including the /api/v1 prefix, no trailing slash. */
  apiUrl: string;
  email: string;
  password: string;
  /** Per-request timeout for ordinary calls (ms). */
  timeoutMs: number;
  /** Timeout for known-slow calls — mesh merge, conversion, export, meshing (ms). */
  slowTimeoutMs: number;
  /** How many times to retry a transient failure on an idempotent (GET) call. */
  retries: number;
}

/** Build the config from the environment (throws if anything mandatory is missing). */
export function loadConfig(): Config {
  const apiUrl = required('DIVE_API_URL').replace(/\/+$/, '');
  const timeoutMs = optionalInt('DIVE_MCP_TIMEOUT_MS', 60_000);
  // Slow operations get their own, longer budget; never let it fall below the
  // ordinary timeout even if a caller sets a smaller value.
  const slowTimeoutMs = Math.max(optionalInt('DIVE_MCP_SLOW_TIMEOUT_MS', 600_000), timeoutMs);
  // Retries are opt-outable (0 disables), so the minimum is 0 here.
  const retries = optionalInt('DIVE_MCP_RETRIES', 2, 0);
  return {
    apiUrl,
    email: required('DIVE_MCP_EMAIL'),
    password: required('DIVE_MCP_PASSWORD'),
    timeoutMs,
    slowTimeoutMs,
    retries,
  };
}
