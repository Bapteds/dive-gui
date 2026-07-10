// MCP resources: read-only, addressable context a client can attach directly
// (without a tool call) — the project list, the dashboard, a project's case-file
// tree, and a solver run's log. Each is served as pretty-printed JSON.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { Api } from './client.js';

/** Wrap a JSON value as a single-resource read result at `uri`. */
function json(uri: URL, value: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) },
    ],
  };
}

/** A URI-template variable is a string or (for repeated vars) a string[]; take the first. */
function one(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

interface ProjectRow {
  id: string;
  title?: string;
  name?: string;
}

export function registerResources(server: McpServer, api: Api): void {
  server.registerResource(
    'projects',
    'dive://projects',
    {
      title: 'Projects',
      description: 'All projects visible to the service account.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, await api.get('/projects')),
  );

  server.registerResource(
    'dashboard',
    'dive://dashboard',
    {
      title: 'Dashboard',
      description: 'Aggregate stats (projects, runs, activity).',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, await api.get('/dashboard')),
  );

  // A project's case-file tree, one resource per project. The `list` callback
  // makes them enumerable/discoverable by resolving the project list to URIs.
  server.registerResource(
    'project-case-files',
    new ResourceTemplate('dive://project/{projectId}/files', {
      list: async () => {
        const body = await api.get<{ projects?: ProjectRow[] }>('/projects');
        const projects = body?.projects ?? [];
        return {
          resources: projects.map((p) => ({
            uri: `dive://project/${p.id}/files`,
            name: `Case files — ${p.title ?? p.name ?? p.id}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Project case files',
      description: "A project's OpenFOAM case file tree.",
      mimeType: 'application/json',
    },
    async (uri, variables: Variables) =>
      json(uri, await api.get(`/projects/${one(variables.projectId)}/files`)),
  );

  // A solver run's catch-up payload (record + residuals + log tail). Not listed
  // (it would mean walking every project's runs); addressable by URI directly.
  server.registerResource(
    'run-log',
    new ResourceTemplate('dive://project/{projectId}/run/{runId}/log', { list: undefined }),
    {
      title: 'Solver run log',
      description: 'A run record, its residual series, and the log tail.',
      mimeType: 'application/json',
    },
    async (uri, variables: Variables) =>
      json(
        uri,
        await api.get(`/projects/${one(variables.projectId)}/runs/${one(variables.runId)}/log`),
      ),
  );
}
