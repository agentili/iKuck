import { randomUUID } from 'node:crypto';
import { connect as connectTcp, createServer, type Server, type Socket } from 'node:net';
import { createClient } from 'redis';
import { afterAll, describe, expect, it } from 'vitest';
import { createCache, createCacheWithClient } from '../cache/client.js';
import { createRedisS2sRateLimiter } from '../s2s/rateLimit.js';

const redisUrl = process.env.INTEGRATION_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
integration('S2S Redis rate limiter integration', () => {
  const cache = createCache(redisUrl!);
  afterAll(async () => cache.close());
  it('enforces shared credential and IP limits', async () => {
    const limiter = createRedisS2sRateLimiter(cache);
    const credential = `credential-${randomUUID()}`;
    const credentialIp = `credential-ip-${randomUUID()}`;
    for (let count = 0; count < 10; count += 1) expect(await limiter.allow(credential, credentialIp)).toBe(true);
    expect(await limiter.allow(credential, credentialIp)).toBe(false);
    const ip = `ip-${randomUUID()}`;
    for (let count = 0; count < 30; count += 1) expect(await limiter.allow(`other-${randomUUID()}`, ip)).toBe(true);
    expect(await limiter.allow(`other-${randomUUID()}`, ip)).toBe(false);
  });

  it('recovers from a terminal Redis startup outage through one shared bounded retry', async () => {
    const upstreamUrl = new URL(redisUrl!);
    const upstreamPort = Number(upstreamUrl.port || (upstreamUrl.protocol === 'rediss:' ? 6380 : 6379));
    const portLease = createServer();
    const proxyPort = await new Promise<number>((resolve, reject) => {
      portLease.once('error', reject);
      portLease.listen(0, '127.0.0.1', () => {
        const address = portLease.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Could not reserve a loopback port'));
          return;
        }
        portLease.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    const clientUrl = new URL(redisUrl!);
    clientUrl.hostname = '127.0.0.1';
    clientUrl.port = String(proxyPort);
    const recoveringCache = createCache(clientUrl.toString(), {
      disableOfflineQueue: true,
      connectOnDemand: false,
      connectOnCreate: true,
      reconnectOnDemand: true,
    });
    let proxy: Server | undefined;

    try {
      await expect(recoveringCache.ping()).rejects.toThrow();
      proxy = createServer((downstream) => {
        const upstream = connectTcp(upstreamPort, upstreamUrl.hostname);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
        downstream.on('error', () => upstream.destroy());
        upstream.on('error', () => downstream.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        proxy!.once('error', reject);
        proxy!.listen(proxyPort, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 1050));
      await expect(recoveringCache.ping()).resolves.toBeUndefined();
    } finally {
      await recoveringCache.close();
      if (proxy?.listening) await new Promise<void>((resolve, reject) => proxy!.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('recovers after an established Redis connection is lost and the service returns', async () => {
    const upstreamUrl = new URL(redisUrl!);
    const upstreamPort = Number(upstreamUrl.port || (upstreamUrl.protocol === 'rediss:' ? 6380 : 6379));
    const sockets = new Set<{ downstream: Socket; upstream: Socket }>();
    const createProxy = () => createServer((downstream) => {
      const upstream = connectTcp(upstreamPort, upstreamUrl.hostname);
      const pair = { downstream, upstream };
      sockets.add(pair);
      const remove = () => { if (downstream.destroyed && upstream.destroyed) sockets.delete(pair); };
      downstream.on('close', remove);
      upstream.on('close', remove);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      downstream.on('error', () => upstream.destroy());
      upstream.on('error', () => downstream.destroy());
    });
    let proxy = createProxy();
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('Could not bind Redis recovery proxy');
    const proxyPort = address.port;
    const clientUrl = new URL(redisUrl!);
    clientUrl.hostname = '127.0.0.1';
    clientUrl.port = String(address.port);
    const client = createClient({
      url: clientUrl.toString(),
      disableOfflineQueue: true,
      socket: { connectTimeout: 1000, reconnectStrategy: (retries) => retries < 2 ? 100 * (retries + 1) : false },
    });
    client.on('error', () => undefined);
    const recoveringCache = createCacheWithClient(client, {
      connectOnDemand: false,
      connectOnCreate: true,
      reconnectOnDemand: true,
    });
    try {
      await recoveringCache.ping();
      let signalReconnecting!: () => void;
      const reconnecting = new Promise<void>((resolve) => { signalReconnecting = resolve; });
      client.once('reconnecting', signalReconnecting);
      for (const { downstream, upstream } of sockets) { downstream.destroy(); upstream.destroy(); }
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
      await reconnecting;
      const reconnectDeadline = Date.now() + 6000;
      while (client.isOpen && Date.now() < reconnectDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect({ open: client.isOpen, ready: client.isReady }).toEqual({ open: false, ready: false });

      proxy = createProxy();
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(proxyPort, '127.0.0.1', resolve);
      });
      await recoveringCache.ping();
      expect(client.isReady).toBe(true);
    } finally {
      await recoveringCache.close();
      for (const { downstream, upstream } of sockets) { downstream.destroy(); upstream.destroy(); }
      if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);

  it('destroys a dedicated node-redis client without calling QUIT', async () => {
    const client = createClient({ url: redisUrl!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    let quitCalls = 0;
    const quit = client.quit.bind(client);
    client.quit = async () => { quitCalls += 1; return quit(); };
    const dedicatedCache = createCacheWithClient(client, { connectOnDemand: false });

    try {
      await dedicatedCache.ping();
      await dedicatedCache.close();
      expect(quitCalls).toBe(0);
      expect(client.isOpen).toBe(false);
    } finally {
      if (client.isOpen) client.destroy();
    }
  });
});
