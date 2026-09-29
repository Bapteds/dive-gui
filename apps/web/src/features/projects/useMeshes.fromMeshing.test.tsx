import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as projectsApi from '@/lib/api/projects';
import type { MeshFromMeshingResult, MeshSource } from '@/lib/api/types';
import { useImportMeshFromMeshing } from './useMeshes';

vi.mock('@/lib/api/projects', () => ({
  importMeshFromMeshing: vi.fn(),
  restoreMeshBackup: vi.fn(),
}));

const PROJECT = 'p1';
const key = (...rest: string[]) => ['projects', PROJECT, ...rest];

/** Seed every cache entry the hand-off must purge or refresh. */
function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const k of [
    key('mesh', 'manifest'),
    key('mesh', 'glb'),
    key('mesh', 'edges'),
    key('mesh', 'backup'),
    key('meshes'),
    key('assembly'),
    key('mergePlan'),
    key('files'),
    key('runnable'),
  ]) {
    client.setQueryData(k, { seeded: true });
  }
  return client;
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useImportMeshFromMeshing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('case target: drops the case render and invalidates the case-derived queries (H6)', async () => {
    const result: MeshFromMeshingResult = {
      target: 'case',
      entries: [{ path: 'constant/polyMesh/boundary', type: 'file', size: 10 }],
      notes: [],
      retyped: [],
      syncedFields: [],
    };
    vi.mocked(projectsApi.importMeshFromMeshing).mockResolvedValue(result);
    const client = seededClient();
    const { result: hook } = renderHook(() => useImportMeshFromMeshing(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await hook.current.mutateAsync({ projectId: PROJECT, sessionId: 's1', target: 'case' });
    });

    expect(projectsApi.importMeshFromMeshing).toHaveBeenCalledWith(PROJECT, {
      sessionId: 's1',
      target: 'case',
    });
    for (const removed of ['manifest', 'glb', 'edges']) {
      expect(client.getQueryState(key('mesh', removed))).toBeUndefined();
    }
    expect(client.getQueryData(key('files'))).toEqual(result.entries);
    for (const stale of [
      key('meshes'),
      key('assembly'),
      key('mergePlan'),
      key('runnable'),
      key('mesh', 'backup'),
    ]) {
      expect(client.getQueryState(stale)?.isInvalidated).toBe(true);
    }
  });

  it('library target: writes the refreshed library, leaves the case render alone', async () => {
    const meshes: MeshSource[] = [
      { id: 'chamber', name: 'Chamber', kind: 'meshing', patches: [], createdAt: '2026-09-29T00:00:00Z' },
    ];
    vi.mocked(projectsApi.importMeshFromMeshing).mockResolvedValue({
      target: 'library',
      mesh: meshes[0],
      meshes,
      notes: [],
    });
    const client = seededClient();
    const { result: hook } = renderHook(() => useImportMeshFromMeshing(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await hook.current.mutateAsync({
        projectId: PROJECT,
        sessionId: 's1',
        target: 'library',
        name: 'Chamber',
      });
    });

    expect(projectsApi.importMeshFromMeshing).toHaveBeenCalledWith(PROJECT, {
      sessionId: 's1',
      target: 'library',
      name: 'Chamber',
    });
    expect(client.getQueryData(key('meshes'))).toEqual(meshes);
    expect(client.getQueryData(key('mesh', 'manifest'))).toEqual({ seeded: true });
    expect(client.getQueryState(key('files'))?.isInvalidated).toBe(false);
  });
});
