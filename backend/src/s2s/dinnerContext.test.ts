import { describe, expect, it } from 'vitest';
import { createS2sDinnerContextService } from './dinnerContext.js';

const authorization = `Bearer key_0123456789abcdef.${'a'.repeat(43)}`;
const serviceFor = (code: string) => createS2sDinnerContextService({
  enabled: true,
  source: { readAuthorizedSnapshot: async () => { throw Object.assign(new Error(code), { code }); } },
  rateLimiter: { allow: async () => true },
});

describe('S2S service error mapping', () => {
  it('distinguishes a valid credential whose sponsor lost access (403)', async () => {
    await expect(serviceFor('service_access_denied').read(authorization, false, false, false, false)).resolves.toEqual({
      status: 403,
      body: { code: 'service_access_denied' },
    });
  });

  it('aborts source work when the request deadline expires', async () => {
    let sourceAborted = false;
    const service = createS2sDinnerContextService({
      enabled: true,
      source: { readAuthorizedSnapshot: async (_token, options?: { signal?: AbortSignal }) => new Promise<null>((_, reject) => {
        options?.signal?.addEventListener('abort', () => { sourceAborted = true; reject(new Error('aborted')); }, { once: true });
      }) },
      rateLimiter: { allow: async () => true },
      requestTimeoutMs: 5,
    });
    await expect(service.read(authorization, false, false, false, false)).resolves.toMatchObject({ status: 503 });
    expect(sourceAborted).toBe(true);
  });

  it('charges the IP limiter before rejecting missing and malformed credentials', async () => {
    const checkedKeys: Array<string | null> = [];
    const service = createS2sDinnerContextService({
      enabled: true,
      source: { readAuthorizedSnapshot: async () => null },
      rateLimiter: { allow: async (key) => { checkedKeys.push(key); return checkedKeys.length < 2; } },
    });
    await expect(service.read(undefined, false, false, false, false, '198.51.100.20')).resolves.toMatchObject({ status: 401 });
    await expect(service.read('Bearer malformed', false, false, false, false, '198.51.100.20')).resolves.toMatchObject({ status: 429 });
    expect(checkedKeys).toEqual([null, null]);
  });

  it('does not charge the verified credential quota until the presented secret authenticates', async () => {
    const wrongToken = `key_0123456789abcdef.${'b'.repeat(43)}`;
    const correctToken = authorization.slice('Bearer '.length);
    const checked: Array<{ key: string | null; bucket?: string }> = [];
    const service = createS2sDinnerContextService({
      enabled: true,
      source: { readAuthorizedSnapshot: async (token) => token === correctToken ? {
        grant: { keyId: 'key_0123456789abcdef', digest: '', enabled: true, expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: 'dinner-context:read' },
        pantryLots: [],
        dietProfile: null,
      } : null },
      rateLimiter: { allow: async (key, _ip, options) => {
        checked.push({ key, bucket: options?.bucket });
        return options?.bucket !== 'credential';
      } },
    });

    await expect(service.read(`Bearer ${wrongToken}`, false, false, false, false)).resolves.toMatchObject({ status: 401 });
    await expect(service.read(authorization, false, false, false, false)).resolves.toMatchObject({ status: 429 });
    expect(checked.filter(({ bucket }) => bucket === 'presented').map(({ key }) => key)).toEqual([wrongToken, correctToken]);
    expect(checked.filter(({ bucket }) => bucket === 'credential').map(({ key }) => key)).toEqual(['key_0123456789abcdef']);
  });

  it('aborts the request budget when the client disconnects', async () => {
    const service = serviceFor('service_auth_required');
    const requestKey = {};
    const preflight = await service.beginRequest('198.51.100.20', requestKey);
    expect('budget' in preflight).toBe(true);
    if (!('budget' in preflight)) return;

    service.abortRequest(requestKey);

    expect(preflight.budget.signal.aborted).toBe(true);
    expect(service.getRequestBudget(requestKey)).toBe(preflight.budget);
    service.finishRequest(requestKey);
    expect(service.getRequestBudget(requestKey)).toBeUndefined();
  });

  it('includes rate-limit latency in the end-to-end request deadline', async () => {
    let sourceReads = 0;
    const service = createS2sDinnerContextService({
      enabled: true,
      source: { readAuthorizedSnapshot: async () => { sourceReads += 1; return null; } },
      rateLimiter: { allow: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return true; } },
      requestTimeoutMs: 5,
    });
    await expect(service.read(authorization, false, false, false, false)).resolves.toMatchObject({ status: 503 });
    expect(sourceReads).toBe(0);
  });

  it('passes only the remaining overall deadline to the snapshot reader', async () => {
    let sourceTimeout: number | undefined;
    const service = createS2sDinnerContextService({
      enabled: true,
      source: { readAuthorizedSnapshot: async (_token, options) => { sourceTimeout = options?.timeoutMs; return null; } },
      rateLimiter: { allow: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return true; } },
      requestTimeoutMs: 1000,
    });
    await expect(service.read(authorization, false, false, false, false)).resolves.toMatchObject({ status: 401 });
    expect(sourceTimeout).toBeDefined();
    expect(sourceTimeout).toBeLessThan(1000);
  });

  it.each([
    ['snapshot_limit_exceeded', 409],
    ['pantry_representation_unsupported', 409],
  ])('preserves safe conflict %s as HTTP %s', async (code, status) => {
    await expect(serviceFor(code).read(authorization, false, false, false, false)).resolves.toEqual({
      status,
      body: { code },
    });
  });
});
