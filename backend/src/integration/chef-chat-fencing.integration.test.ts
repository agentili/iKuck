import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { createChefChatFencedRedisMirror } from '../ai/chefChatFencedRedis.js';

const redisUrl = process.env.INTEGRATION_REDIS_URL;
const suite = redisUrl ? describe : describe.skip;

suite('chef chat Redis fencing', () => {
  const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:1', disableOfflineQueue: true });
  client.on('error', () => undefined);
  const mirror = createChefChatFencedRedisMirror(client);
  const namespace = randomBytes(32).toString('hex');
  const fenceKey = `ikuck:chef-chat:{${namespace}}:fence`;
  const dayKey = `ikuck:chef-chat:{${namespace}}:day`;
  const minuteKey = `ikuck:chef-chat:{${namespace}}:minute`;

  beforeAll(async () => { await client.connect(); });
  afterAll(async () => {
    if (client.isReady) await client.del([fenceKey, dayKey, minuteKey]);
    if (client.isOpen) client.destroy();
  });

  it('keeps a permanent tombstone and rejects late init, reserve and release', async () => {
    const firstOperation = randomUUID();
    const lateOperation = randomUUID();
    expect(await mirror.initialize(namespace, 1)).toBe(true);
    expect(await mirror.reserve(namespace, 1, firstOperation)).toMatchObject({ allowed: true });

    expect(await mirror.deleteNamespace(namespace, 1)).toEqual({
      tombstone: true,
      dayAbsent: true,
      minuteAbsent: true,
    });
    expect(await client.get(fenceKey)).toBe('deleted');
    expect(await client.ttl(fenceKey)).toBe(-1);

    expect(await mirror.initialize(namespace, 1)).toBe(false);
    await expect(mirror.reserve(namespace, 1, lateOperation)).rejects.toMatchObject({ code: 'chef_chat_fenced' });
    await expect(mirror.release(namespace, 1, firstOperation)).rejects.toMatchObject({ code: 'chef_chat_fenced' });
    expect(await mirror.deleteNamespace(namespace, 1)).toEqual({
      tombstone: true,
      dayAbsent: true,
      minuteAbsent: true,
    });
  });

  it('does not replace a higher or divergent fence epoch', async () => {
    const otherNamespace = randomBytes(32).toString('hex');
    const key = `ikuck:chef-chat:{${otherNamespace}}:fence`;
    try {
      expect(await mirror.initialize(otherNamespace, 2)).toBe(true);
      expect(await mirror.initialize(otherNamespace, 1)).toBe(false);
      expect(await client.get(key)).toBe('active:2');
    } finally {
      await client.del([
        key,
        `ikuck:chef-chat:{${otherNamespace}}:day`,
        `ikuck:chef-chat:{${otherNamespace}}:minute`,
      ]);
    }
  });
});
