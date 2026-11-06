import { randomBytes } from 'node:crypto';

export interface ChefChatFencedRedisClient {
  readonly isReady: boolean;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class ChefChatFenceError extends Error {
  readonly code = 'chef_chat_fenced';

  constructor() {
    super('Chef chat Redis fence is not active');
    this.name = 'ChefChatFenceError';
  }
}

const initializeScript = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'NX')
  current = redis.call('GET', KEYS[1])
end
if current == ARGV[1] then return 1 end
return 0
`;

const reserveScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1, 0} end
for i = 2, 3 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('invalid quota key type') end
end
local now = tonumber(redis.call('TIME')[1])
local dayStart = math.floor(now / 86400) * 86400
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', dayStart - 1)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - 60)
if redis.call('ZSCORE', KEYS[2], ARGV[2]) then return {1, 0} end
if redis.call('ZCARD', KEYS[2]) >= 30 then return {0, dayStart + 86400 - now} end
if redis.call('ZCARD', KEYS[3]) >= 5 then
  local oldest = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + 60 - now)}
end
redis.call('ZADD', KEYS[2], now, ARGV[2])
redis.call('ZADD', KEYS[3], now, ARGV[2])
redis.call('EXPIRE', KEYS[2], dayStart + 86460 - now)
redis.call('EXPIRE', KEYS[3], 60)
return {1, 0}
`;

const releaseScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
for i = 2, 3 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('invalid quota key type') end
end
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
`;

const deleteScript = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'none' and kind ~= 'string' then return redis.error_reply('invalid fence key type') end
local current = redis.call('GET', KEYS[1])
if current and current ~= 'deleted' and current ~= ARGV[1] then return {-1, 0, 0} end
for i = 2, 3 do
  local keyKind = redis.call('TYPE', KEYS[i]).ok
  if keyKind ~= 'none' and keyKind ~= 'zset' then return redis.error_reply('invalid quota key type') end
end
redis.call('SET', KEYS[1], 'deleted')
redis.call('DEL', KEYS[2], KEYS[3])
return {redis.call('GET', KEYS[1]) == 'deleted' and 1 or 0, redis.call('EXISTS', KEYS[2]) == 0 and 1 or 0, redis.call('EXISTS', KEYS[3]) == 0 and 1 or 0}
`;

const parseEpoch = (epoch: number): string => {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid chef chat epoch');
  return `active:${epoch}`;
};

const assertNamespace = (namespace: string): void => {
  if (!/^[a-f0-9]{64}$/.test(namespace)) throw new Error('Invalid chef chat namespace');
};

const assertOperationId = (operationId: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error('Invalid chef chat operation ID');
  }
};

export function createChefChatFencedRedisMirror(client: ChefChatFencedRedisClient) {
  const keys = (namespace: string) => {
    assertNamespace(namespace);
    return [
      `ikuck:chef-chat:{${namespace}}:fence`,
      `ikuck:chef-chat:{${namespace}}:day`,
      `ikuck:chef-chat:{${namespace}}:minute`,
    ];
  };
  const execute = async (script: string, keySet: string[], args: string[]): Promise<unknown> => {
    if (!client.isReady) throw new Error('Redis is not ready');
    return client.eval(script, { keys: keySet, arguments: args });
  };
  return {
    async initialize(namespace: string, epoch: number): Promise<boolean> {
      const keySet = keys(namespace);
      const result = await execute(initializeScript, [keySet[0]!], [parseEpoch(epoch)]);
      if (result !== 0 && result !== 1 && result !== 0n && result !== 1n) throw new Error('Invalid Redis fence response');
      return Number(result) === 1;
    },
    async reserve(namespace: string, epoch: number, operationId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
      assertOperationId(operationId);
      const result = await execute(reserveScript, keys(namespace), [parseEpoch(epoch), operationId]);
      if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid Redis quota response');
      const code = Number(result[0]);
      const retryAfter = Number(result[1]);
      if (![-1, 0, 1].includes(code) || !Number.isInteger(retryAfter) || retryAfter < 0) throw new Error('Invalid Redis quota response');
      if (code === -1) throw new ChefChatFenceError();
      return code === 1 ? { allowed: true } : { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
    },
    async release(namespace: string, epoch: number, operationId: string): Promise<void> {
      assertOperationId(operationId);
      const result = await execute(releaseScript, keys(namespace), [parseEpoch(epoch), operationId]);
      if (Number(result) === -1) throw new ChefChatFenceError();
      if (Number(result) !== 1) throw new Error('Invalid Redis release response');
    },
    async deleteNamespace(namespace: string, activeEpoch: number): Promise<{ tombstone: true; dayAbsent: true; minuteAbsent: true }> {
      const result = await execute(deleteScript, keys(namespace), [`active:${activeEpoch}`]);
      if (!Array.isArray(result) || result.length !== 3) throw new Error('Invalid Redis deletion response');
      if (Number(result[0]) === -1) throw new ChefChatFenceError();
      if (result.some((value) => Number(value) !== 1)) throw new Error('Redis deletion was not confirmed');
      return { tombstone: true, dayAbsent: true, minuteAbsent: true };
    },
    async createNamespace(): Promise<string> {
      return randomBytes(32).toString('hex');
    },
  };
}
