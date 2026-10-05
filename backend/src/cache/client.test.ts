import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createCacheWithClient } from './client.js';

describe('cache readiness gates', () => {
  it('rejects S2S cache work without connecting or dispatching when Redis is not ready', async () => {
    let connectCalls = 0;
    let evalCalls = 0;
    let isReady = false;
    const cache = createCacheWithClient({
      isOpen: true,
      get isReady() { return isReady; },
      connect: async () => { connectCalls += 1; },
      ping: async () => 'PONG',
      quit: async () => undefined,
      destroy: () => undefined,
      eval: async () => { evalCalls += 1; return [1, 1]; },
    }, { connectOnDemand: false });

    await expect(cache.reserveWithExpiry('s2s:test', 1, 60)).rejects.toThrow('Redis is not ready');
    expect(connectCalls).toBe(0);
    expect(evalCalls).toBe(0);

    isReady = true;
    await expect(cache.reserveWithExpiry('s2s:test', 1, 60)).resolves.toEqual({ allowed: true, used: 1 });
    expect(connectCalls).toBe(0);
    expect(evalCalls).toBe(1);
  });

  it('accepts a binary PONG reply from a ready Redis client', async () => {
    const cache = createCacheWithClient({
      isOpen: true,
      isReady: true,
      connect: async () => undefined,
      ping: async () => Buffer.from('PONG'),
      quit: async () => undefined,
      destroy: () => undefined,
    }, { connectOnDemand: false });

    await expect(cache.ping()).resolves.toBeUndefined();
  });

  it('normalizes a Redis numeric-string INCR reply to a number', async () => {
    const cache = createCacheWithClient({
      isOpen: true,
      isReady: true,
      connect: async () => undefined,
      ping: async () => 'PONG',
      quit: async () => undefined,
      destroy: () => undefined,
      incr: async () => '2' as `${number}`,
      expire: async () => true,
    }, { connectOnDemand: false });

    await expect(cache.incrementWithExpiry('counter', 60)).resolves.toBe(2);
  });

  it('shares an in-flight on-demand Redis connection across concurrent checks', async () => {
    let open = false;
    let ready = false;
    let connectCalls = 0;
    let markConnectStarted!: () => void;
    let finishConnect!: () => void;
    const connectStarted = new Promise<void>((resolve) => { markConnectStarted = resolve; });
    const connectGate = new Promise<void>((resolve) => { finishConnect = resolve; });
    const cache = createCacheWithClient({
      get isOpen() { return open; },
      get isReady() { return ready; },
      connect: async () => {
        connectCalls += 1;
        open = true;
        markConnectStarted();
        await connectGate;
        ready = true;
      },
      ping: async () => 'PONG',
      eval: async () => [1, 1],
      quit: async () => undefined,
      destroy: () => undefined,
    });
    const first = cache.reserveWithExpiry('s2s:rate:ip:first', 10, 60);
    await connectStarted;
    const second = cache.reserveWithExpiry('s2s:rate:ip:second', 10, 60);
    finishConnect();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(connectCalls).toBe(1);
  });

  it('retries a terminal startup connection failure on a later request', async () => {
    let isOpen = false;
    let isReady = false;
    let connectCalls = 0;
    const cache = createCacheWithClient({
      get isOpen() { return isOpen; },
      get isReady() { return isReady; },
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) throw new Error('Redis unavailable');
        isOpen = true;
        isReady = true;
      },
      ping: async () => 'PONG',
      quit: async () => undefined,
      destroy: () => { isOpen = false; isReady = false; },
    }, { connectOnDemand: false, connectOnCreate: true, reconnectOnDemand: true, reconnectCooldownMs: 20 });

    await expect(cache.ping()).rejects.toThrow('Redis unavailable');
    await expect(cache.ping()).rejects.toThrow('Redis is not ready');
    expect(connectCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(Promise.all([cache.ping(), cache.ping()])).resolves.toEqual([undefined, undefined]);
    expect(connectCalls).toBe(2);
  });

  it('does not start a deferred initial connection after shutdown', async () => {
    let isOpen = false;
    let connectCalls = 0;
    const cache = createCacheWithClient({
      get isOpen() { return isOpen; },
      isReady: false,
      connect: async () => { connectCalls += 1; isOpen = true; },
      ping: async () => 'PONG',
      quit: async () => undefined,
      destroy: () => undefined,
    }, { connectOnCreate: true });

    await cache.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connectCalls).toBe(0);
  });

  it('destroys an unavailable Redis client instead of awaiting QUIT during shutdown', async () => {
    let destroyCalls = 0;
    let quitCalls = 0;
    const cache = createCacheWithClient({
      isOpen: true,
      isReady: false,
      connect: async () => undefined,
      ping: async () => 'PONG',
      quit: async () => { quitCalls += 1; return new Promise(() => undefined); },
      destroy: () => { destroyCalls += 1; },
    }, { connectOnDemand: false });

    const closed = await Promise.race([
      cache.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(closed).toBe(true);
    expect(quitCalls).toBe(0);
    expect(destroyCalls).toBe(1);
  });

  it('destroys a ready Redis client with an outstanding rate-limit command without QUIT', async () => {
    let rejectCommand!: (error: Error) => void;
    let destroyCalls = 0;
    let quitCalls = 0;
    const cache = createCacheWithClient({
      isOpen: true,
      isReady: true,
      connect: async () => undefined,
      ping: async () => 'PONG',
      quit: async () => { quitCalls += 1; return new Promise(() => undefined); },
      eval: async () => new Promise((_resolve, reject) => { rejectCommand = reject; }),
      destroy: () => { destroyCalls += 1; rejectCommand(new Error('client destroyed')); },
    });
    const reservation = cache.reserveWithExpiry('s2s:rate:ip:test', 30, 60);
    const reservationFailure = expect(reservation).rejects.toThrow('client destroyed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await cache.close();

    expect(destroyCalls).toBe(1);
    expect(quitCalls).toBe(0);
    await reservationFailure;
  });
});
