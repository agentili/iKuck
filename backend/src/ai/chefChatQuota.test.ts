import { describe, expect, it } from 'vitest';
import { createChefChatQuota, decideQuota } from './chefChatQuota.js';

describe('chef chat quota', () => {
  it('applies daily, rolling-minute, user and global limits conservatively', () => {
    const empty = { active_user: 0, active_global: 0, daily: 0, minute: 0, minute_retry: 12, day_retry: 100 };
    expect(decideQuota(empty)).toEqual({ kind: 'allowed' });
    expect(decideQuota({ ...empty, daily: 30 })).toEqual({ kind: 'limited', retryAfterSeconds: 100 });
    expect(decideQuota({ ...empty, minute: 5 })).toEqual({ kind: 'limited', retryAfterSeconds: 12 });
    expect(decideQuota({ ...empty, active_user: 1 })).toEqual({ kind: 'limited' });
    expect(decideQuota({ ...empty, active_global: 8 })).toEqual({ kind: 'limited' });
  });
  it('fails closed when Redis is unavailable without reserving', async () => {
    let reservations = 0;
    const quota = createChefChatQuota({
      ping: async () => { throw new Error('offline'); },
    }, {
      reserve: async () => { reservations++; return { kind: 'allowed', operationId: 'op', token: 'token' }; },
    });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
    expect(reservations).toBe(0);
  });

  it('fails closed if PostgreSQL is unavailable', async () => {
    const quota = createChefChatQuota({ ping: async () => {}, reserve: async () => ({ allowed: true }) }, {
      reserve: async () => { throw new Error('database offline'); },
      cancel: async () => true,
    });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
  });

  it('fails closed if Redis replies to ping with an unexpected value', async () => {
    const quota = createChefChatQuota({ ping: async () => 'NOT_PONG', reserve: async () => ({ allowed: true }) }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
      cancel: async () => true,
    });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
  });

  it('rejects admission and safely cancels when the Redis mirror denies a reservation', async () => {
    let cancelled = 0;
    const quota = createChefChatQuota({
      ping: async () => {},
      reserve: async () => ({ allowed: false, retryAfterSeconds: 17 }),
    }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
      cancel: async () => { cancelled++; return true; },
    });
    expect(await quota.reserve('user')).toEqual({ kind: 'limited', retryAfterSeconds: 17 });
    expect(cancelled).toBe(1);
  });

  it('cancels a late Redis reservation after timeout and does not return a dispatch permit', async () => {
    let resolveMirror!: (result: { allowed: boolean }) => void;
    let cancellations = 0;
    let releases = 0;
    const quota = createChefChatQuota({
      ping: async () => {},
      reserve: () => new Promise((resolve) => { resolveMirror = resolve; }),
      release: async () => { releases++; },
    }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
      cancel: async () => { cancellations++; return true; },
    }, { timeoutMs: 10 });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
    resolveMirror({ allowed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancellations).toBe(1);
    expect(releases).toBe(1);
  });

  it('does not dispatch when the Redis quota mirror is not configured', async () => {
    let calls = 0;
    const quota = createChefChatQuota({ ping: async () => {} }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
      dispatch: async () => { calls++; return true; },
    });
    expect(await quota.dispatch('op', 'token')).toBe(false);
    expect(calls).toBe(0);
  });

  it('rechecks Redis immediately before a dispatch transition', async () => {
    let healthy = true;
    let dispatches = 0;
    const quota = createChefChatQuota({ ping: async () => { if (!healthy) throw new Error('offline'); }, reserve: async () => ({ allowed: true }) }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
      cancel: async () => true,
      dispatch: async () => { dispatches++; return true; },
    });
    expect((await quota.reserve('user')).kind).toBe('allowed');
    healthy = false;
    expect(await quota.dispatch('op', 'token')).toBe(false);
    expect(dispatches).toBe(0);
  });

  it('bounds a stalled database reservation and never dispatches a late result', async () => {
    let resolveReservation!: (value: { kind: 'allowed'; operationId: string; token: string }) => void;
    const quota = createChefChatQuota({ ping: async () => {}, reserve: async () => ({ allowed: true }) }, {
      reserve: () => new Promise((resolve) => { resolveReservation = resolve; }),
      cancel: async () => true,
    }, { timeoutMs: 10 });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
    expect(await quota.reserve('other')).toEqual({ kind: 'unavailable' });
    resolveReservation({ kind: 'allowed', operationId: 'op', token: 'token' });
  });

  it('times out Redis and refuses additional checks until the pending ping settles', async () => {
    let resolvePing!: () => void;
    let calls = 0;
    const quota = createChefChatQuota({ ping: () => { calls++; return new Promise<void>((resolve) => { resolvePing = resolve; }); } }, {
      reserve: async () => ({ kind: 'allowed', operationId: 'op', token: 'token' }),
    }, { timeoutMs: 10 });
    expect(await quota.reserve('user')).toEqual({ kind: 'unavailable' });
    expect(await quota.reserve('another')).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
    resolvePing();
  });
});
