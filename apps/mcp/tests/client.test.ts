import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiveClient } from '../src/client';
import type { Config } from '../src/config';

function cfg(over: Partial<Config> = {}): Config {
  return {
    apiUrl: 'http://api/api/v1',
    email: 'e@x',
    password: 'pw',
    timeoutMs: 1000,
    slowTimeoutMs: 2000,
    retries: 2,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A successful login response (fresh token each call unless overridden). */
function loginOk(token = 'tok-1'): Response {
  return jsonResponse({ accessToken: token, user: { id: 'u', email: 'e', role: 'USER' } });
}

/** The Headers passed to the Nth fetch call. */
function headersOf(mock: ReturnType<typeof vi.fn>, call: number): Headers {
  return mock.mock.calls[call][1].headers as Headers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiveClient auth', () => {
  it('logs in on first use and attaches the bearer token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk('tok-1'))
      .mockResolvedValueOnce(jsonResponse({ projects: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new DiveClient(cfg()).get('/projects');

    expect(res).toEqual({ projects: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/login');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(headersOf(fetchMock, 1).get('authorization')).toBe('Bearer tok-1');
  });

  it('re-logs in once on a 401 and retries with the new token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk('tok-1'))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'X', message: 'expired' } }, 401))
      .mockResolvedValueOnce(loginOk('tok-2'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new DiveClient(cfg()).get('/projects');

    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(headersOf(fetchMock, 3).get('authorization')).toBe('Bearer tok-2');
  });

  it('logs in only once for concurrent first requests (single-flight)', async () => {
    let logins = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/auth/login')) {
        logins += 1;
        return loginOk();
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DiveClient(cfg());
    await Promise.all([client.get('/a'), client.get('/b')]);
    expect(logins).toBe(1);
  });
});

describe('DiveClient errors + retries', () => {
  it('throws an ApiError carrying status, code and the failing endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'NOT_FOUND', message: 'no project' } }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DiveClient(cfg()).get('/projects/x')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      endpoint: 'GET /projects/x',
    });
  });

  it('retries a transient 503 on GET, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'X', message: 'busy' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new DiveClient(cfg({ retries: 2 })).get('/x');
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a POST on 503 (non-idempotent)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'X', message: 'busy' } }, 503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DiveClient(cfg()).post('/runs', {})).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + one POST, no retry
  });

  it('retries a network failure on GET and finally throws NETWORK_ERROR', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(loginOk()).mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DiveClient(cfg({ retries: 1 })).get('/x')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // login + 2 GET attempts (1 retry)
  });

  it('maps an aborted request to a TIMEOUT ApiError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockResolvedValueOnce(loginOk()).mockRejectedValue(abort);
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DiveClient(cfg({ retries: 0 })).get('/x')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

describe('DiveClient bodies', () => {
  it('putText sends a text/plain body and encodes the query', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await new DiveClient(cfg()).putText('/files/content', 'hello', { path: 'a/b' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('path=a%2Fb');
    expect(init.method).toBe('PUT');
    expect((init.headers as Headers).get('content-type')).toContain('text/plain');
    expect(init.body).toBe('hello');
  });

  it('getBytes returns the raw bytes and the content-type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'model/gltf-binary' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { bytes, contentType } = await new DiveClient(cfg()).getBytes('/mesh/geometry');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(contentType).toBe('model/gltf-binary');
  });
});
