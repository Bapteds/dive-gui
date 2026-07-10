// DIVE Turbinen MCP server — boot entrypoint.
// Exposes the app's REST API (/api/v1) as MCP tools (and resources + prompts) so
// Claude can drive the same operations the React front performs: browse
// projects, read/write case files, run and monitor solvers, convert/merge
// meshes, apply boundary conditions and export to CFD-Post. Auth is a service
// account (see apps/mcp/.env), handled by DiveClient (login + auto re-login on
// 401). The server is assembled in factory.ts (createServer); this file only
// loads config, builds the client, and connects the stdio transport.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { DiveClient } from './client.js';
import { createServer } from './factory.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new DiveClient(config);
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe: stdout is the MCP transport channel.
  console.error(`[dive-mcp] connected — API base ${client.baseUrl}`);
}

main().catch((err) => {
  console.error('[dive-mcp] fatal:', err);
  process.exit(1);
});
