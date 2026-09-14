import { describe, expect, it, vi } from 'vitest';
import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout.js';

const okResponse = (): Response => new Response('{}', { status: 200 });

describe('fetchWithTimeout', () => {
  it('returns a normal response and cleans up the timer', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(okResponse());

      await expect(fetchWithTimeout(fetch, 'https://example.test', {}, 1000)).resolves.toBeInstanceOf(Response);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts and rejects with a stable timeout error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
    }));

    await expect(fetchWithTimeout(fetch, 'https://example.test', {}, 1)).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('propagates the caller abort and does not relabel it as a timeout', async () => {
    const controller = new AbortController();
    const callerError = new Error('caller cancelled');
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(callerError), { once: true });
    }));

    const request = fetchWithTimeout(fetch, 'https://example.test', { signal: controller.signal }, 1000);
    controller.abort(callerError);

    await expect(request).rejects.toBe(callerError);
  });

  it('removes the caller abort listener after a successful response', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(okResponse());

    await fetchWithTimeout(fetch, 'https://example.test', { signal: controller.signal }, 1000);
    controller.abort();

    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});
