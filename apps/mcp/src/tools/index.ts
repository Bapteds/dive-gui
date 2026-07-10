// Aggregates every tool module and registers them on a server against one Api.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Api } from '../client.js';
import { makeTool } from '../kit.js';
import { registerProjectTools } from './projects.js';
import { registerMeshTools } from './mesh.js';
import { registerRunTools } from './runs.js';
import { registerTemplateTools } from './templates.js';
import { registerMeshingTools } from './meshing.js';
import { registerAdminTools } from './admin.js';

/** Register the full tool surface (projects, mesh, runs, templates, meshing, admin). */
export function registerTools(server: McpServer, api: Api): void {
  const tool = makeTool(server);
  registerProjectTools(tool, api);
  registerMeshTools(tool, api);
  registerRunTools(tool, api);
  registerTemplateTools(tool, api);
  registerMeshingTools(tool, api);
  registerAdminTools(tool, api);
}
