// Vitest configuration for the MCP server.
// The DIVE_* vars are injected here so config.ts is fully valid without a real
// apps/mcp/.env (config.ts loads .env via dotenv, which does NOT override values
// already present in process.env — so these test values always win).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DIVE_API_URL: 'http://test.local/api/v1',
      DIVE_MCP_EMAIL: 'mcp-test@dive.local',
      DIVE_MCP_PASSWORD: 'test-password',
      DIVE_MCP_TIMEOUT_MS: '5000',
      DIVE_MCP_SLOW_TIMEOUT_MS: '9000',
      DIVE_MCP_RETRIES: '2',
    },
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
  },
});
