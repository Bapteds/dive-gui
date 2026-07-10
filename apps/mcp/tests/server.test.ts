import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../src/factory';
import { ApiError, type Api } from '../src/client';

/** Build a fake Api; every verb resolves to `{ ok: true }` unless overridden. */
function makeApi(over: Partial<Api> = {}): Api {
  const okAsync = async () => ({ ok: true });
  return {
    baseUrl: 'http://test/api/v1',
    slowTimeoutMs: 1000,
    get: okAsync,
    post: okAsync,
    put: okAsync,
    patch: okAsync,
    delete: okAsync,
    putText: okAsync,
    postForm: okAsync,
    getBytes: async () => ({ bytes: Buffer.from('zip'), contentType: 'application/zip' }),
    ...over,
  } as Api;
}

/** Connect an MCP client to a server built over the fake Api, in-memory. */
async function connect(api: Api) {
  const server = createServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/** Text of a tool result's first content block. */
function textOf(res: { content: unknown }): string {
  return (res.content as { text: string }[])[0].text;
}

describe('tool registration', () => {
  it('registers a large, collision-free tool set including the workflow-gap tools', async () => {
    const { client } = await connect(makeApi());
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(80);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    for (const n of ['upload_cgns', 'import_mesh', 'convert_cgns', 'merge_meshes']) {
      expect(names).toContain(n);
    }
  });

  it('flags destructive vs read-only tools via annotations', async () => {
    const { client } = await connect(makeApi());
    const { tools } = await client.listTools();

    const del = tools.find((t) => t.name === 'delete_project');
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.annotations?.readOnlyHint).toBe(false);

    const read = tools.find((t) => t.name === 'get_run_log');
    expect(read?.annotations?.readOnlyHint).toBe(true);

    // A download writes to the local disk, so it must NOT be read-only.
    const dl = tools.find((t) => t.name === 'download_case');
    expect(dl?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('tool routing + results', () => {
  it('a read tool returns structured content and hits the right endpoint', async () => {
    const get = vi.fn(async () => ({ projects: [{ id: 'p1' }] }));
    const { client } = await connect(makeApi({ get }));

    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(res.structuredContent).toEqual({ projects: [{ id: 'p1' }] });
    expect(get).toHaveBeenCalledWith('/projects');
  });

  it('a write tool posts the expected body', async () => {
    const post = vi.fn(async () => ({ id: 'p9' }));
    const { client } = await connect(makeApi({ post }));

    await client.callTool({ name: 'create_project', arguments: { title: 'New' } });
    expect(post).toHaveBeenCalledWith('/projects', { title: 'New' });
  });

  it('import_mesh picks the multipart field from the file extension', async () => {
    const postForm = vi.fn(async () => ({ ok: true }));
    const { client } = await connect(makeApi({ postForm }));

    await client.callTool({
      name: 'import_mesh',
      arguments: { projectId: 'p', filePath: '/tmp/rotor.cgns' },
    });
    await client.callTool({
      name: 'import_mesh',
      arguments: { projectId: 'p', filePath: '/tmp/case.zip', name: 'Case' },
    });

    // A .cgns is a single mesh file; a .zip is a zipped polyMesh folder.
    expect(postForm.mock.calls[0][0]).toBe('/projects/p/meshes/import');
    expect(postForm.mock.calls[0][2]).toEqual([{ field: 'meshFile', path: '/tmp/rotor.cgns' }]);
    expect(postForm.mock.calls[1][1]).toEqual({ name: 'Case' });
    expect(postForm.mock.calls[1][2]).toEqual([{ field: 'archive', path: '/tmp/case.zip' }]);
  });

  it('slow tools pass the longer timeout budget', async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const { client } = await connect(makeApi({ post, slowTimeoutMs: 12345 }));

    await client.callTool({ name: 'run_export', arguments: { projectId: 'p' } });
    // post(path, json, query, opts) — opts.timeoutMs is the slow budget.
    const opts = post.mock.calls[0][3];
    expect(opts).toEqual({ timeoutMs: 12345 });
  });

  it('maps an API error to an isError result with context', async () => {
    const get = vi.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'no project', 'GET /projects/x');
    });
    const { client } = await connect(makeApi({ get }));

    const res = await client.callTool({ name: 'get_project', arguments: { projectId: 'x' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('404');
    expect(textOf(res)).toContain('NOT_FOUND');
    expect(textOf(res)).toContain('GET /projects/x');
  });
});

describe('resources + prompts', () => {
  it('exposes the static + per-project resources', async () => {
    const get = vi.fn(async (path: string) =>
      path === '/projects' ? { projects: [{ id: 'p1', title: 'A' }] } : { ok: true },
    );
    const { client } = await connect(makeApi({ get }));

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['dive://projects', 'dive://dashboard', 'dive://project/p1/files']),
    );

    const read = await client.readResource({ uri: 'dive://project/p1/files' });
    expect(read.contents[0].uri).toBe('dive://project/p1/files');
  });

  it('exposes the guided prompts and substitutes their arguments', async () => {
    const { client } = await connect(makeApi());

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'diagnose_run',
        'prepare_runnable_case',
        'convert_cgns_workflow',
        'set_up_assembly',
      ]),
    );

    const got = await client.getPrompt({
      name: 'diagnose_run',
      arguments: { projectId: 'p1', runId: 'r9' },
    });
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain('run r9');
    expect(text).toContain('project p1');
  });
});
