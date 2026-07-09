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

/** Validated configuration, resolved once at module load. */
export interface Config {
  /** API base URL including the /api/v1 prefix, no trailing slash. */
  apiUrl: string;
  email: string;
  password: string;
  timeoutMs: number;
}

/** Build the config from the environment (throws if anything mandatory is missing). */
export function loadConfig(): Config {
  const apiUrl = required('DIVE_API_URL').replace(/\/+$/, '');
  const timeoutRaw = process.env.DIVE_MCP_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('DIVE_MCP_TIMEOUT_MS must be a positive integer (milliseconds).');
  }
  return {
    apiUrl,
    email: required('DIVE_MCP_EMAIL'),
    password: required('DIVE_MCP_PASSWORD'),
    timeoutMs,
  };
}
