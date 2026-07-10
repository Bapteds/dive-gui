// Tools for the standalone Meshing feature (snappyHexMesh / cfMesh sessions):
// create a session, upload STL surfaces, tune + run the mesher, inspect the
// result and download the produced case.
import { z } from 'zod';
import type { Api } from '../client.js';
import { type Registrar, saveDownload } from '../kit.js';
import { sessionParams } from './params.js';

export function registerMeshingTools(tool: Registrar, api: Api): void {
  const slow = { timeoutMs: api.slowTimeoutMs };

  tool('list_meshing_sessions', {
    title: 'List meshing sessions',
    description: 'List all snappyHexMesh / cfMesh sessions (shared across the team).',
  }, async () => api.get('/meshing'));

  tool('get_meshing_session', {
    title: 'Get meshing session',
    description: "Fetch one meshing session's detail (engine, STL surfaces, config, last result).",
    inputSchema: sessionParams,
  }, async ({ sessionId }) => api.get(`/meshing/${sessionId}`));

  tool('create_meshing_session', {
    title: 'Create meshing session',
    description: 'Create a meshing session with a fixed engine ("snappy" or "cfmesh").',
    inputSchema: {
      name: z.string().min(1).describe('Session name.'),
      engine: z.enum(['snappy', 'cfmesh']).optional().describe('Mesher engine (default "snappy").'),
    },
  }, async ({ name, engine }) => {
    const body: Record<string, unknown> = { name };
    if (engine) body.engine = engine;
    return api.post('/meshing', body);
  });

  tool('delete_meshing_session', {
    title: 'Delete meshing session',
    description: 'Delete a meshing session and its files. Irreversible.',
    inputSchema: sessionParams,
    destructive: true,
  }, async ({ sessionId }) => {
    await api.delete(`/meshing/${sessionId}`);
    return { deleted: sessionId };
  });

  tool('upload_stl', {
    title: 'Upload STL surface',
    description: 'Upload an STL surface into a meshing session from a local file path.',
    inputSchema: {
      ...sessionParams,
      filePath: z.string().min(1).describe('Absolute path to a .stl file on the machine running the MCP server.'),
    },
  }, async ({ sessionId, filePath }) =>
    api.postForm(`/meshing/${sessionId}/stl`, {}, [{ field: 'files', path: filePath }], undefined, slow));

  tool('delete_stl', {
    title: 'Delete STL surface',
    description: 'Remove one STL surface from a meshing session by name.',
    inputSchema: {
      ...sessionParams,
      name: z.string().min(1).describe('STL file name to delete.'),
    },
    destructive: true,
  }, async ({ sessionId, name }) => api.delete(`/meshing/${sessionId}/stl`, { name }));

  tool('save_meshing_config', {
    title: 'Save meshing config',
    description:
      'Persist the mesher config without running it. Pass the config as a JSON object (SnappyConfig or CfMeshConfig, discriminated by `engine`).',
    inputSchema: {
      ...sessionParams,
      config: z.record(z.string(), z.unknown()).describe('Mesher config object (must include `engine`).'),
    },
  }, async ({ sessionId, config }) => api.put(`/meshing/${sessionId}/config`, config));

  tool('run_meshing', {
    title: 'Run mesher',
    description:
      "Run the session's mesher (snappyHexMesh or cfMesh) with a config object. Returns the session + per-step result. Can be slow.",
    inputSchema: {
      ...sessionParams,
      config: z.record(z.string(), z.unknown()).describe('Mesher config object (must include `engine`).'),
    },
    destructive: true,
  }, async ({ sessionId, config }) => api.post(`/meshing/${sessionId}/run`, config, undefined, slow));

  tool('get_meshing_manifest', {
    title: 'Get meshing result manifest',
    description: "Fetch the result mesh's patch manifest (builds the render on demand; first call may be slow).",
    inputSchema: sessionParams,
  }, async ({ sessionId }) => api.get(`/meshing/${sessionId}/mesh/manifest`, undefined, slow));

  tool('download_meshing_session', {
    title: 'Download meshing session (.zip)',
    description: 'Download the session case as a .zip and save it to a local file path.',
    inputSchema: {
      ...sessionParams,
      savePath: z.string().min(1).describe('Local file path to write the .zip to.'),
    },
  }, async ({ sessionId, savePath }) =>
    saveDownload(savePath, await api.getBytes(`/meshing/${sessionId}/download`, undefined, slow)));
}
