// Builds a fully-wired MCP server against an Api implementation. Kept free of any
// transport / boot logic so tests can construct a server over an in-memory
// transport with a fake Api (mirrors the API app's createApp/server split).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Api } from './client.js';
import { registerTools } from './tools/index.js';

/** Server identity advertised to MCP clients. */
export const SERVER_INFO = { name: 'dive-mcp', version: '0.2.0' } as const;

/** Create an MCP server with every tool registered against `api`. */
export function createServer(api: Api): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, api);
  return server;
}
