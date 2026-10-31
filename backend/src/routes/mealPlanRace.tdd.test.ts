import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const origin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin, 'x-csrf-token': 'csrf-token' };
const scope = 'account:user-plan-race';
const date = '2026-11-05';

const createHarness = () => {
  const authService = {
    authenticate: async () => ({
      id: 'session-plan-race', userId: 'user-plan-race', email: 'plan-race@example.com',
      emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
      csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }),
  } as unknown as AuthService;
  const repository = createMemorySyncRepository();
  const app = createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin: origin, secureCookies: false },
    sync: { repository, authService, appOrigin: origin },
  });
  const command = (payload: object) => app.inject({ method: 'POST', url: '/v1/meal-plan/commands', headers, payload });
  const read = () => app.inject({ method: 'POST', url: '/v1/meal-plan/read', headers, payload: { version: 2, scope, dates: [date] } });
  return { app, command, read };
};

// The automatic proposal captures its base before the user's manual choice,
// but is delivered only after that choice commits. No timing sleeps are needed.
describe('meal plan proposal ordering', () => {
  it('does not let a late automatic proposal overwrite a committed manual choice', async () => {
    const { app, command, read } = createHarness();
    const base = { version: 2, scope, date, clientUpdatedAt: '2026-01-01T00:00:00.000Z' };

    try {
      const initial = await read();
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({ version: 2, states: [{ date, state: null }] });
      const delayedProposal = { ...base, action: 'auto_create', operationId: 'auto-1', deviceId: 'device-auto', recipeId: 'automatic-recipe', baseRevision: null };
      const manual = await command({ ...base, action: 'manual_set', operationId: 'manual-1', deviceId: 'device-manual', recipeId: 'chosen-recipe' });
      expect(manual.statusCode).toBe(200);
      expect(manual.json()).toMatchObject({ version: 2, operationId: 'manual-1', outcome: 'applied', current: { date, kind: 'manual', recipeId: 'chosen-recipe', revision: expect.any(String), serverSequence: expect.any(Number) } });
      const late = await command(delayedProposal);
      expect(late.statusCode).toBe(200);
      expect(late.json()).toEqual({ version: 2, operationId: 'auto-1', outcome: 'conflict', current: manual.json().current });
      const final = await read();
      expect(final.statusCode).toBe(200);
      expect(final.json()).toEqual({ version: 2, states: [{ date, state: manual.json().current }] });
    } finally {
      await app.close();
    }
  });

  it('allows only one of two automatic proposals based on the same absent state', async () => {
    const { app, command, read } = createHarness();
    const base = { version: 2, scope, date, clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'auto_create', baseRevision: null };
    const proposals = [
      { ...base, operationId: 'auto-proposal-a', deviceId: 'device-a', recipeId: 'recipe-a' },
      { ...base, operationId: 'auto-proposal-b', deviceId: 'device-b', recipeId: 'recipe-b' },
    ];

    try {
      const responses = await Promise.all(proposals.map((proposal) => command(proposal)));
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const results = responses.map((response) => response.json());
      const applied = results.filter((result) => result.outcome === 'applied');
      const conflicted = results.filter((result) => result.outcome === 'conflict');
      expect(applied).toHaveLength(1);
      expect(conflicted).toHaveLength(1);
      expect(conflicted[0].current).toEqual(applied[0].current);
      const final = await read();
      expect(final.statusCode).toBe(200);
      expect(final.json()).toEqual({ version: 2, states: [{ date, state: applied[0].current }] });
    } finally {
      await app.close();
    }
  });

  it('keeps a manual choice when it races an automatic proposal from the absent state', async () => {
    const { app, command, read } = createHarness();
    const auto = {
      version: 2, scope, date, operationId: 'auto-before-manual', deviceId: 'device-auto',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'auto_create', recipeId: 'automatic-recipe', baseRevision: null,
    };
    const manual = {
      version: 2, scope, date, operationId: 'manual-racing-auto', deviceId: 'device-manual',
      clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'chosen-recipe',
    };

    try {
      const [autoResponse, manualResponse] = await Promise.all([command(auto), command(manual)]);
      expect(autoResponse.statusCode).toBe(200);
      expect(manualResponse.statusCode).toBe(200);
      expect(manualResponse.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'chosen-recipe' } });
      const final = await read();
      expect(final.json().states).toEqual([{ date, state: manualResponse.json().current }]);
    } finally {
      await app.close();
    }
  });

  it('keeps a manual deletion tombstone when it races an automatic proposal from absence', async () => {
    const { app, command, read } = createHarness();
    const auto = {
      version: 2, scope, date, operationId: 'auto-racing-delete', deviceId: 'device-auto',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'auto_create', recipeId: 'automatic-recipe', baseRevision: null,
    };
    const deletion = {
      version: 2, scope, date, operationId: 'delete-racing-auto', deviceId: 'device-manual',
      clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_delete',
    };

    try {
      const [autoResponse, deleteResponse] = await Promise.all([command(auto), command(deletion)]);
      expect(autoResponse.statusCode).toBe(200);
      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
      const final = await read();
      expect(final.json().states).toEqual([{ date, state: deleteResponse.json().current }]);
    } finally {
      await app.close();
    }
  });

  it('does not let a regeneration based on a tombstone overwrite a racing manual choice', async () => {
    const { app, command, read } = createHarness();
    try {
      const deleted = await command({
        version: 2, scope, date, operationId: 'delete-before-regeneration', deviceId: 'device-manual',
        clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_delete',
      });
      expect(deleted.json()).toMatchObject({ outcome: 'applied', current: { kind: 'deleted', recipeId: null } });
      const regeneration = {
        version: 2, scope, date, operationId: 'regeneration-racing-manual', deviceId: 'device-auto',
        clientUpdatedAt: '2026-01-03T00:00:00.000Z', action: 'explicit_regenerate',
        recipeId: 'regenerated-recipe', baseRevision: deleted.json().current.revision,
      };
      const manual = {
        version: 2, scope, date, operationId: 'manual-racing-regeneration', deviceId: 'device-manual',
        clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'manual-recipe',
      };

      const [regenerationResponse, manualResponse] = await Promise.all([command(regeneration), command(manual)]);
      expect(regenerationResponse.statusCode).toBe(200);
      expect(manualResponse.statusCode).toBe(200);
      expect(manualResponse.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'manual-recipe' } });
      const final = await read();
      expect(final.json().states).toEqual([{ date, state: manualResponse.json().current }]);
    } finally {
      await app.close();
    }
  });

  it('returns one original receipt when the same operation is submitted concurrently', async () => {
    const { app, command, read } = createHarness();
    const payload = {
      version: 2, scope, date, operationId: 'concurrent-replay', deviceId: 'device-manual',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_set', recipeId: 'replayed-choice',
    };

    try {
      const [first, retry] = await Promise.all([command(payload), command(payload)]);
      expect(first.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'replayed-choice' } });
      const final = await read();
      expect(final.json().states).toEqual([{ date, state: first.json().current }]);
    } finally {
      await app.close();
    }
  });

  it('keeps the newer manual choice when older and newer offline commands race', async () => {
    const { app, command, read } = createHarness();
    const older = {
      version: 2, scope, date, operationId: 'older-manual', deviceId: 'device-older',
      clientUpdatedAt: '2026-01-01T00:00:00.000Z', action: 'manual_set', recipeId: 'older-choice',
    };
    const newer = {
      version: 2, scope, date, operationId: 'newer-manual', deviceId: 'device-newer',
      clientUpdatedAt: '2026-01-02T00:00:00.000Z', action: 'manual_set', recipeId: 'newer-choice',
    };

    try {
      const [olderResponse, newerResponse] = await Promise.all([command(older), command(newer)]);
      expect(olderResponse.statusCode).toBe(200);
      expect(newerResponse.statusCode).toBe(200);
      expect(newerResponse.json()).toMatchObject({ outcome: 'applied', current: { kind: 'manual', recipeId: 'newer-choice' } });
      const final = await read();
      expect(final.json().states).toEqual([{ date, state: newerResponse.json().current }]);
    } finally {
      await app.close();
    }
  });
});
