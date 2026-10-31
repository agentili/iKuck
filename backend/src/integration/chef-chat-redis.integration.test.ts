import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';
import { createChefChatRedisMirror } from '../ai/chefChatRedis.js';

const redisUrl = process.env.INTEGRATION_REDIS_URL;
const suite = redisUrl ? describe : describe.skip;

suite('chef chat Redis mirror', () => {
  it('does not mutate the daily set when the minute key has the wrong type', async () => {
    const client = createClient({ url: redisUrl!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = randomUUID();
    const day = `ikuck:chef-chat:{${user}}:day`;
    const minute = `ikuck:chef-chat:{${user}}:minute`;
    try {
      await client.zAdd(day, [{ score: 1, value: 'old' }]);
      await client.set(minute, 'wrong-type');
      const mirror = createChefChatRedisMirror(client);
      await expect(mirror.reserve(user, randomUUID())).rejects.toThrow();
      expect(await client.zCard(day)).toBe(1);
      await expect(mirror.release(user, 'old')).rejects.toThrow();
      expect(await client.zCard(day)).toBe(1);
    } finally {
      await client.del([day, minute]);
      client.destroy();
    }
  });

  it('denies at the daily boundary even when the minute set is empty', async () => {
    const client = createClient({ url: redisUrl!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = randomUUID();
    const keys = [`ikuck:chef-chat:{${user}}:day`, `ikuck:chef-chat:{${user}}:minute`];
    try {
      const clock = await client.sendCommand(['TIME']) as string[];
      await client.zAdd(keys[0]!, Array.from({ length: 30 }, () => ({ score: Number(clock[0]), value: randomUUID() })));
      const result = await createChefChatRedisMirror(client).reserve(user, randomUUID());
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(await client.zCard(keys[1]!)).toBe(0);
    } finally {
      await client.del(keys);
      client.destroy();
    }
  });

  it('supports idempotent reservation and release of a specific operation', async () => {
    const client = createClient({ url: redisUrl!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = randomUUID();
    const id = randomUUID();
    const keys = [`ikuck:chef-chat:{${user}}:day`, `ikuck:chef-chat:{${user}}:minute`];
    try {
      const mirror = createChefChatRedisMirror(client);
      expect(await mirror.reserve(user, id)).toEqual({ allowed: true });
      expect(await mirror.reserve(user, id)).toEqual({ allowed: true });
      expect(await client.zCard(keys[0]!)).toBe(1);
      await mirror.release(user, id);
      await mirror.release(user, id);
      expect(await client.zCard(keys[0]!)).toBe(0);
      expect(await client.zCard(keys[1]!)).toBe(0);
    } finally {
      await client.del(keys);
      client.destroy();
    }
  });

  it('atomically records a rolling window and expires both derived keys', async () => {
    const client = createClient({ url: redisUrl!, disableOfflineQueue: true });
    client.on('error', () => undefined);
    await client.connect();
    const user = randomUUID();
    const mirror = createChefChatRedisMirror(client);
    try {
      const admissions = await Promise.all(Array.from({ length: 12 }, () => mirror.reserve(user, randomUUID())));
      expect(admissions.filter((item) => item.allowed)).toHaveLength(5);
      const keys = await client.keys(`ikuck:chef-chat:{${user}}:*`);
      expect(keys).toHaveLength(2);
      for (const key of keys) expect(await client.ttl(key)).toBeGreaterThan(0);
    } finally {
      const keys = await client.keys(`ikuck:chef-chat:{${user}}:*`);
      if (keys.length) await client.del(keys);
      client.destroy();
    }
  });
});
