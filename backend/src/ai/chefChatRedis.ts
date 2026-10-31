type RedisMirrorClient = {
  readonly isReady: boolean;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

const reserveScript = `
for i = 1, 2 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('invalid quota key type') end
end
local now = tonumber(redis.call('TIME')[1])
local dayStart = math.floor(now / 86400) * 86400
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', dayStart - 1)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 60)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return {1, 0} end
if redis.call('ZCARD', KEYS[1]) >= 30 then return {0, dayStart + 86400 - now} end
if redis.call('ZCARD', KEYS[2]) >= 5 then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + 60 - now)}
end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('ZADD', KEYS[2], now, ARGV[1])
redis.call('EXPIRE', KEYS[1], dayStart + 86460 - now)
redis.call('EXPIRE', KEYS[2], 60)
return {1, 0}
`;

const releaseScript = `
for i = 1, 2 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('invalid quota key type') end
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export function createChefChatRedisMirror(client: RedisMirrorClient) {
  function keys(userId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid quota user');
    return [`ikuck:chef-chat:{${userId}}:day`, `ikuck:chef-chat:{${userId}}:minute`];
  }
  async function execute(script: string, userId: string, operationId: string) {
    if (!client.isReady) throw new Error('Redis is not ready');
    return client.eval(script, { keys: keys(userId), arguments: [operationId] });
  }
  return {
    async reserve(userId: string, operationId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
      const result = await execute(reserveScript, userId, operationId);
      if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(result[0]) || !Number.isInteger(result[1]) || result[1] < 0) throw new Error('Invalid Redis response');
      return result[0] === 1 ? { allowed: true } : { allowed: false, retryAfterSeconds: Math.max(1, result[1]) };
    },
    async release(userId: string, operationId: string): Promise<void> {
      if (await execute(releaseScript, userId, operationId) !== 1) throw new Error('Invalid Redis response');
    },
  };
}
