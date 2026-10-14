import { describe, expect, it } from 'vitest';
import type { CookEvent, PantryLot } from '@ikuck/shared/contracts';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const appOrigin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin: appOrigin, 'x-csrf-token': 'csrf-token' };
const now = '2026-10-07T10:00:00.000Z';
const scope = 'house:house-1' as const;
const command: DinnerConsumptionCommand = {
  operationId: 'operation-route-1',
  entryId: 'dinner-route-1',
  scope,
  servings: 2,
  ingredients: [{ ingredientId: 'pasta', name: 'Pasta', amount: '100 g', optional: false, used: true }],
};
const entry: DinnerEntry = {
  id: command.entryId,
  date: '2026-10-07',
  text: 'Pasta',
  servings: command.servings,
  note: null,
  recipes: [],
  authorId: null,
  createdAt: now,
  updatedAt: now,
};
const cookEvent: CookEvent = {
  id: command.entryId,
  recipeId: 'pasta-recipe',
  recipeTitle: 'Pasta',
  servings: command.servings,
  cookedAt: now,
  note: null,
  createdAt: now,
  updatedAt: now,
};
const lot: PantryLot = {
  id: 'pasta-route-lot',
  ingredientId: 'pasta',
  label: 'Pasta',
  known: true,
  quantity: 500,
  unit: 'g',
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
};

const createHarness = () => {
  let currentUserId = 'member-1';
  const members = new Map([['member-1', 'house-1'], ['member-2', 'house-1']]);
  const repository = createMemorySyncRepository({
    clock: () => new Date(now),
    scopeResolver: async (userId) => {
      const houseId = members.get(userId);
      return houseId === undefined ? null : { kind: 'house', id: houseId };
    },
  });
  const authService = {
    authenticate: async () => ({
      id: `session-${currentUserId}`,
      userId: currentUserId,
      email: `${currentUserId}@example.com`,
      emailVerifiedAt: new Date(now),
      csrfTokenHash: hashOpaqueToken('csrf-token'),
      expiresAt: new Date('2026-10-30T12:00:00.000Z'),
    }),
  } as unknown as AuthService;
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin, secureCookies: false },
    dinnerConsumption: { repository, authService, appOrigin },
  });
  return { app, repository, switchUser: (userId: string) => { currentUserId = userId; }, removeMember: (userId: string) => members.delete(userId) };
};

const seedLot = async (repository: ReturnType<typeof createMemorySyncRepository>) => repository.applyMutation('member-1', {
  mutationId: 'seed-route-lot',
  deviceId: 'device-1',
  entityType: 'pantry_lot',
  entityId: lot.id,
  operation: 'upsert',
  payload: lot,
  clientUpdatedAt: now,
  syncScope: scope,
});

const confirm = async (
  app: ReturnType<typeof createApp>,
  payload: unknown,
  requestHeaders: Record<string, string> = headers,
) => await app.inject({
  method: 'POST',
  url: '/v1/dinner-consumption',
  headers: { 'content-type': 'application/json', ...requestHeaders },
  payload: JSON.stringify(payload),
});

describe('dinner consumption route', () => {
  it('requires same-origin verified-session CSRF and a strict body', async () => {
    const { app } = createHarness();
    const payload = { command, entry, cookEvent };

    const missingCsrf = await confirm(app, payload, { cookie: headers.cookie, origin: appOrigin });
    const foreignOrigin = await confirm(app, payload, { ...headers, origin: 'https://outside.example' });
    const extraField = await confirm(app, { ...payload, houseId: 'house-1' });
    const extraCommandField = await confirm(app, { ...payload, command: { ...command, ownerId: 'member-1' } });
    const extraCookEventField = await confirm(app, { ...payload, cookEvent: { ...cookEvent, unauthorizedScope: 'account:other-user' } });

    expect(missingCsrf.statusCode).toBe(403);
    expect(foreignOrigin.statusCode).toBe(403);
    expect(extraField.statusCode).toBe(400);
    expect(extraCommandField.statusCode).toBe(400);
    expect(extraCookEventField.statusCode).toBe(400);
    await app.close();
  });

  it('consumes under server-resolved household scope and deduplicates a member retry', async () => {
    const { app, repository, switchUser } = createHarness();
    await seedLot(repository);

    const first = await confirm(app, { command, entry, cookEvent });
    switchUser('member-2');
    const retry = await confirm(app, { command, entry, cookEvent });
    const storedLot = await repository.readEntity('member-2', 'pantry_lot', lot.id);
    const changes = await repository.readChanges('member-2', 0, 100, scope);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, entry: { id: entry.id, authorId: 'member-1' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ duplicate: true, receipt: { operationId: command.operationId, scope } });
    expect((storedLot?.payload as PantryLot).quantity).toBe(lot.quantity! - 2 * 100);
    expect(changes.filter((change) => change.entityType === 'dinner_entry' && change.entityId === entry.id)).toHaveLength(1);
    expect(changes.filter((change) => change.entityType === 'cook_event' && change.entityId === entry.id)).toHaveLength(1);
    await app.close();
  });

  it('rejects a stale or foreign household scope without changing stock', async () => {
    const { app, repository, removeMember } = createHarness();
    await seedLot(repository);
    removeMember('member-1');

    const response = await confirm(app, { command, entry, cookEvent });
    const storedLot = await repository.readEntity('member-2', 'pantry_lot', lot.id);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'house_membership_required' });
    expect((storedLot?.payload as PantryLot).quantity).toBe(lot.quantity);
    await app.close();
  });
});
