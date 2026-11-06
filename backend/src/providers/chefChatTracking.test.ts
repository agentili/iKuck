import { describe, expect, it, vi } from 'vitest';
import { createChefChatProvider } from './chefChat.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request = { message: 'Ciao', history: [] };
const config = { providers: { openAiApiKey: 'test' } };
const valid = () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ciao' }] }] }));

describe('tracked chat transport', () => {
  it('keeps settlement pending after timeout until a late fetch and its body finish', async () => {
    const fetchResult = deferred<Response>();
    const body = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(fetchResult.promise);
    const provider = createChefChatProvider(config, { fetch, timeoutMs: 10 });
    const operation = provider.startChat(request);
    let settled = false;
    void operation.settled.then(() => { settled = true; });
    await expect(operation.response).rejects.toMatchObject({ code: 'provider_timeout' });
    expect(settled).toBe(false);
    fetchResult.resolve(new Response(new ReadableStream({ async pull(controller) { await body.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    body.resolve();
    await operation.settled;
    expect(settled).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('tracks late fetch %s independently across parallel requests', async (outcome) => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const provider = createChefChatProvider(config, { fetch, timeoutMs: 10 });
    const a = provider.startChat(request);
    const b = provider.startChat(request);
    let aDone = false;
    void a.settled.then(() => { aDone = true; });
    const aResponse = expect(a.response).rejects.toMatchObject({ code: 'provider_timeout' });
    second.resolve(valid());
    await expect(b.response).resolves.toBe('Ciao');
    await b.settled;
    await aResponse;
    expect(aDone).toBe(false);
    if (outcome === 'resolve') first.resolve(valid());
    else first.reject(new Error('late private failure'));
    await a.settled;
    expect(aDone).toBe(true);
  });

  it('holds settlement after caller cancellation until body rejection', async () => {
    const pending = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ async pull() { await pending.promise; } })));
    const controller = new AbortController();
    const operation = createChefChatProvider(config, { fetch }).startChat({ ...request, signal: controller.signal });
    let done = false;
    void operation.settled.then(() => { done = true; });
    controller.abort();
    await expect(operation.response).rejects.toMatchObject({ code: 'provider_error' });
    expect(done).toBe(false);
    pending.reject(new Error('late body failure'));
    await operation.settled;
    expect(done).toBe(true);
  });

  it('does not dispatch an already-cancelled request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const signal = AbortSignal.abort();
    const operation = createChefChatProvider(config, { fetch }).startChat({ ...request, signal });
    await expect(operation.response).rejects.toMatchObject({ code: 'provider_error' });
    await operation.settled;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('waits for unsuccessful response body cancellation', async () => {
    const cancellation = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: () => cancellation.promise }), { status: 500 }));
    const operation = createChefChatProvider(config, { fetch, timeoutMs: 10 }).startChat(request);
    let done = false;
    void operation.settled.then(() => { done = true; });
    await expect(operation.response).rejects.toMatchObject({ code: 'provider_timeout' });
    expect(done).toBe(false);
    cancellation.resolve();
    await operation.settled;
    expect(done).toBe(true);
  });
});
