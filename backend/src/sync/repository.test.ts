import { describe, expect, it, vi } from 'vitest';
import { createMemorySyncRepository } from './repository.js';

const mutation = (clientUpdatedAt: string, mutationId: string, label: string) => ({
  mutationId,
  deviceId: 'device-1',
  entityType: 'pantry_item' as const,
  entityId: 'tomato',
  operation: 'upsert' as const,
  payload: { id: 'tomato', label, known: true },
  clientUpdatedAt,
});

describe('sync repository', () => {
  const pantryLot = (id: string, quantity: number | null, unit: 'g' | 'kg' | null, expiresAt: string | null) => ({
    id,
    ingredientId: 'pasta',
    label: 'Pasta',
    known: true,
    quantity,
    unit,
    expiresAt,
    createdAt: '2026-09-12T12:00:00.000Z',
    updatedAt: '2026-09-12T12:00:00.000Z',
  });

  it('keeps the newer mutation and ignores an older mutation for the same entity', async () => {
    const repository = createMemorySyncRepository();
    await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-new', 'Pomodoro'));
    const result = await repository.applyMutation('user-1', mutation('2026-09-12T11:00:00.000Z', 'mutation-old', 'Vecchio'));

    expect(result.applied).toBe(false);
    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      payload: { label: 'Pomodoro' },
    });
  });

  it('applies the same mutation only once and returns a server sequence', async () => {
    const repository = createMemorySyncRepository();
    const first = await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-1', 'Pomodoro'));
    const second = await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'mutation-1', 'Pomodoro'));

    expect(first.applied).toBe(true);
    expect(first.change?.serverSequence).toBe(1);
    expect(second.applied).toBe(false);
  });

  it('clamps a client timestamp ten minutes in the future and emits a private-data-free warning', async () => {
    const warn = vi.fn();
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({
      clock: () => serverNow,
      logger: { warn },
      maxClientClockSkewMs: 5 * 60 * 1000,
    });

    await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'future-mutation', 'Private label'),
      deviceId: 'device-future',
    });

    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      clientUpdatedAt: serverNow,
      payload: { label: 'Private label' },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Sync client timestamp exceeded the configured clock skew tolerance');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private label');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('device-future');
  });

  it('resolves equally skewed devices deterministically by device id', async () => {
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({ clock: () => serverNow, logger: { warn: () => undefined } });

    await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'device-b-mutation', 'Device B'),
      deviceId: 'device-b',
    });
    const second = await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:10:00.000Z', 'device-a-mutation', 'Device A'),
      deviceId: 'device-a',
    });

    expect(second.applied).toBe(false);
    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      payload: { label: 'Device B' },
      clientUpdatedAt: serverNow,
    });
  });

  it('keeps personal shopping and cooking data in the user scope after joining a house', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'user-1' || userId === 'user-2' ? { kind: 'house', id: 'house-1' } : null,
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'personal-shopping', 'Personal pasta'),
      entityType: 'shopping_list_item',
      entityId: 'shopping-1',
      payload: {
        id: 'shopping-1', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
        purchased: false, sourceRecipeId: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
      },
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:01:00.000Z', 'personal-cook', 'Personal cooking'),
      entityType: 'cook_event',
      entityId: 'event-1',
      payload: {
        id: 'event-1', recipeId: 'recipe-1', recipeTitle: 'Pasta', servings: 2,
        cookedAt: '2026-09-12T12:00:00.000Z', note: null, createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z',
      },
    });

    await expect(repository.readEntity('user-2', 'shopping_list_item', 'shopping-1')).resolves.toBeNull();
    await expect(repository.readEntity('user-2', 'cook_event', 'event-1')).resolves.toBeNull();
    await expect(repository.readEntity('user-1', 'shopping_list_item', 'shopping-1')).resolves.toMatchObject({ payload: { label: 'Pasta' } });
    await expect(repository.readEntity('user-1', 'cook_event', 'event-1')).resolves.toMatchObject({ payload: { recipeTitle: 'Pasta' } });
  });

  it('rejects a house scope for a personal entity at the repository boundary', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });

    await expect(repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'personal-house-scope', 'Personal profile'),
      entityType: 'diet_profile',
      entityId: 'profile',
      payload: { diet: 'omnivore', excludedAllergens: [], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: '2026-09-12T12:00:00.000Z' },
      syncScope: 'house:house-1',
    })).rejects.toMatchObject({ code: 'sync_scope_invalid' });
    await expect(repository.readEntity('user-1', 'diet_profile', 'profile')).resolves.toBeNull();
  });

  it('does not double-import the same device lot when account data is later merged from guest scope', async () => {
    let member = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' },
    });
    const lot = pantryLot('pasta-lot', 500, 'g', '2026-10-01');
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'account-lot', 'Pasta'),
      deviceId: 'device-1',
      entityType: 'pantry_lot',
      entityId: lot.id,
      payload: lot,
    });

    member = true;
    await repository.mergeUserPantryToHouse('user-1', 'house-1');
    const guestRetry = await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'device-1',
      lots: [lot],
      stapleIds: [],
    });

    expect(guestRetry).toMatchObject({ addedLots: 0, mergedLots: 0, mergedGroups: 0 });
    await expect(repository.readEntity('user-1', 'pantry_lot', lot.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 500, unit: 'g' }),
    });
  });

  it('deduplicates duplicate lot IDs within one guest snapshot', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async () => ({ kind: 'house', id: 'house-1' }),
    });
    const first = pantryLot('duplicate-lot', 100, 'g', '2026-10-01');
    const duplicate = { ...first, quantity: 200, updatedAt: '2026-09-12T12:01:00.000Z' };

    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'device-1',
      lots: [first, duplicate],
      stapleIds: [],
    });

    await expect(repository.readEntity('user-1', 'pantry_lot', duplicate.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 200, unit: 'g' }),
    });
    const rows = await repository.readAll('user-1');
    expect(rows.filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert')).toHaveLength(1);
  });

  it('orders revisions by instant when timestamps use different offsets', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async () => ({ kind: 'house', id: 'house-1' }),
    });
    const olderText = { ...pantryLot('offset-lot', 100, 'g', '2026-10-01'), updatedAt: '2026-09-12T10:00:00+02:00' };
    const newerInstant = { ...olderText, quantity: 200, updatedAt: '2026-09-12T09:30:00Z' };

    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'offset-device', lots: [olderText, newerInstant], stapleIds: [],
    });

    await expect(repository.readEntity('user-1', 'pantry_lot', newerInstant.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 200, updatedAt: newerInstant.updatedAt }),
    });
  });

  it('replaces a guest revision after the first guest lot was re-keyed into an existing lot', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const existing = { ...pantryLot('collision-lot', 100, 'g', '2026-10-01'), updatedAt: '2026-09-12T12:00:00.000Z' };
    const firstGuest = { ...existing, quantity: 50, updatedAt: '2026-09-12T12:01:00.000Z' };
    const secondGuest = { ...existing, quantity: 60, updatedAt: '2026-09-12T12:02:00.000Z' };
    await repository.applyMutation('user-1', {
      ...mutation(existing.updatedAt, 'collision-account', 'Pasta'),
      entityType: 'pantry_lot',
      entityId: existing.id,
      payload: existing,
      syncScope: 'house:house-1',
    });
    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'collision-device', lots: [firstGuest], stapleIds: [],
    });
    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'collision-device', lots: [secondGuest], stapleIds: [],
    });

    await expect(repository.readEntity('user-1', 'pantry_lot', existing.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 160, unit: 'g' }),
    });
  });

  it('replaces an older guest revision when the same device later imports a newer account revision', async () => {
    let member = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' },
    });
    const guestLot = pantryLot('revision-lot', 100, 'g', '2026-10-01');
    const accountLot = { ...guestLot, quantity: 200, updatedAt: '2026-09-12T12:01:00.000Z' };

    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'device-1', lots: [guestLot], stapleIds: [],
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:01:00.000Z', 'account-revision', 'Revision'),
      deviceId: 'device-1',
      entityType: 'pantry_lot',
      entityId: accountLot.id,
      payload: accountLot,
    });
    member = true;
    await repository.mergeUserPantryToHouse('user-1', 'house-1');

    await expect(repository.readEntity('user-1', 'pantry_lot', accountLot.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 200, unit: 'g' }),
    });
    const rows = await repository.readAll('user-1');
    expect(rows.filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert')).toHaveLength(1);
  });

  it('does not add an older guest snapshot after the same account revision was merged first', async () => {
    let member = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : null,
    });
    const accountLot = pantryLot('same-source-lot', 200, 'g', '2026-09-12');
    const staleGuestLot = { ...accountLot, quantity: 100, updatedAt: '2026-09-11T12:00:00.000Z' };

    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'account-source', 'Account'),
      deviceId: 'device-1',
      syncScope: 'account:user-1',
      entityType: 'pantry_lot',
      entityId: accountLot.id,
      payload: accountLot,
    });
    member = true;
    await repository.mergeUserPantryToHouse('user-1', 'house-1');
    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'device-1', lots: [staleGuestLot], stapleIds: [],
    });

    await expect(repository.readEntity('user-1', 'pantry_lot', accountLot.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 200, unit: 'g' }),
    });
    const rows = await repository.readAll('user-1');
    expect(rows.filter((row) => row.entityType === 'pantry_lot' && row.operation === 'upsert')).toHaveLength(1);
  });

  it('shares house-scoped mutations between members while keeping personal data isolated', async () => {
    const members = new Set(['user-1', 'user-2']);
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => members.has(userId) ? { kind: 'house', id: 'house-1' } : null,
    });
    await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'house-mutation', 'Dispensa condivisa'));
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'personal-mutation', 'Profilo personale'),
      entityType: 'diet_profile',
      entityId: 'profile',
      payload: {
        diet: 'vegan',
        excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
        updatedAt: '2026-09-12T12:00:00.000Z',
      },
    });

    await expect(repository.readEntity('user-2', 'pantry_item', 'tomato')).resolves.toMatchObject({ payload: { label: 'Dispensa condivisa' } });
    await expect(repository.readEntity('user-2', 'diet_profile', 'profile')).resolves.toBeNull();
    await expect(repository.readEntity('user-1', 'diet_profile', 'profile')).resolves.toMatchObject({ payload: { diet: 'vegan' } });
  });

  it('imports only shared personal data into the current house and removes the source rows', async () => {
    let member = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => member ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' },
    });
    await repository.applyMutation('user-1', mutation('2026-09-12T12:00:00.000Z', 'personal-pantry', 'Personal pantry'));
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'personal-diet', 'Personal diet'),
      entityType: 'diet_profile',
      entityId: 'profile',
      payload: {
        diet: 'vegan',
        excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
        updatedAt: '2026-09-12T12:00:00.000Z',
      },
    });

    member = true;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({ payload: { label: 'Personal pantry' } });
    await expect(repository.readEntity('user-1', 'diet_profile', 'profile')).resolves.toMatchObject({ payload: { diet: 'vegan' } });
    await expect(repository.readAll('user-1')).resolves.toHaveLength(2);
  });

  it('merges a member pantry into the house, sums compatible lots, unions staples and is idempotent', async () => {
    let userIsMember = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'user-1' && !userIsMember
        ? { kind: 'user', id: 'user-1' }
        : { kind: 'house', id: 'house-1' },
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'member-lot-a', 'Pasta'),
      entityType: 'pantry_lot',
      entityId: 'member-lot-a',
      payload: pantryLot('member-lot-a', 1, 'kg', '2026-10-01'),
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:01:00.000Z', 'member-lot-b', 'Pasta'),
      entityType: 'pantry_lot',
      entityId: 'member-lot-b',
      payload: pantryLot('member-lot-b', 500, 'g', '2026-10-01'),
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:02:00.000Z', 'member-staple', 'Sale'),
      entityType: 'staple_preference',
      entityId: 'salt',
      payload: { enabled: true },
    });

    userIsMember = true;
    const first = await repository.mergeUserPantryToHouse('user-1', 'house-1');
    const second = await repository.mergeUserPantryToHouse('user-1', 'house-1');

    expect(first).toMatchObject({ mergedGroups: 1, mergedLots: 1, importedStaples: 1 });
    expect(second).toMatchObject({ addedLots: 0, mergedLots: 0, importedStaples: 0 });
    await expect(repository.readEntity('user-1', 'pantry_lot', 'member-lot-a')).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 1500, unit: 'g' }),
    });
    await expect(repository.readEntity('user-1', 'pantry_lot', 'member-lot-b')).resolves.toBeNull();
    await expect(repository.readEntity('user-1', 'staple_preference', 'salt')).resolves.toMatchObject({
      payload: { enabled: true },
    });
  });

  it('emits a preserving pantry-item tombstone after replacing legacy pantry data with a lot', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'legacy-item', 'Pasta'),
      entityType: 'pantry_item',
      entityId: 'pasta',
      payload: { id: 'pasta', label: 'Pasta', known: true },
    });
    await repository.mergeGuestPantryToHouse('user-1', 'house-1', {
      deviceId: 'device-1',
      lots: [pantryLot('canonical-lot', 300, 'g', '2026-10-01')],
      stapleIds: [],
    });

    const changes = await repository.readChanges('user-1', 0, 100);
    expect(changes).toContainEqual(expect.objectContaining({
      entityType: 'pantry_item',
      entityId: 'pasta',
      operation: 'delete',
      mutationId: 'house-pantry-merge:delete:pantry_item:pasta',
    }));
    expect(changes).toContainEqual(expect.objectContaining({
      entityType: 'pantry_lot',
      entityId: 'canonical-lot',
      operation: 'upsert',
    }));
  });

  it('emits tombstones for house lots absorbed by a semantic merge and does not repeat them on retry', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'house-lot-a', 'Pasta'),
      entityType: 'pantry_lot',
      entityId: 'lot-a',
      payload: pantryLot('lot-a', 100, 'g', '2026-10-01'),
    });
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:01:00.000Z', 'house-lot-b', 'Pasta'),
      entityType: 'pantry_lot',
      entityId: 'lot-b',
      payload: pantryLot('lot-b', 200, 'g', '2026-10-01'),
    });

    await repository.mergeGuestPantryToHouse('user-1', 'house-1', { deviceId: 'device-1', lots: [], stapleIds: [] });
    const changes = await repository.readChanges('user-1', 0, 100);
    expect(changes).toContainEqual(expect.objectContaining({ entityType: 'pantry_lot', entityId: 'lot-b', operation: 'delete', payload: null }));
    expect(changes).toContainEqual(expect.objectContaining({ entityType: 'pantry_lot', entityId: 'lot-a', operation: 'upsert', payload: expect.objectContaining({ quantity: 300, unit: 'g' }) }));
    const cursor = Math.max(...changes.map((change) => change.serverSequence));

    await repository.mergeGuestPantryToHouse('user-1', 'house-1', { deviceId: 'device-1', lots: [], stapleIds: [] });
    await expect(repository.readChanges('user-1', cursor, 100)).resolves.toEqual([]);
  });
  it('merges a guest device pantry only once even when the request is retried', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const guestLot = pantryLot('guest-lot', 500, 'g', null);
    const input = { deviceId: 'device-1', lots: [guestLot], stapleIds: ['salt'] };

    const first = await repository.mergeGuestPantryToHouse('user-1', 'house-1', input);
    const second = await repository.mergeGuestPantryToHouse('user-1', 'house-1', input);

    expect(first).toMatchObject({ addedLots: 1, importedStaples: 1 });
    expect(second).toMatchObject({ addedLots: 0, mergedLots: 0, importedStaples: 0 });
    await expect(repository.readEntity('user-1', 'pantry_lot', 'guest-lot')).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 500, unit: 'g' }),
    });
  });

  it('stores pantry mutations in the personal scope before a user joins a house', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => null });

    await expect(repository.applyMutation('removed-user', mutation('2026-09-12T12:00:00.000Z', 'personal-mutation', 'Personal pantry')))
      .resolves.toMatchObject({ applied: true });
    await expect(repository.readEntity('removed-user', 'pantry_item', 'tomato')).resolves.toMatchObject({
      payload: { id: 'tomato', label: 'Personal pantry', known: true },
    });
  });

  it('honors a larger configured tolerance', async () => {
    const serverNow = new Date('2026-09-13T12:00:00.000Z');
    const repository = createMemorySyncRepository({
      clock: () => serverNow,
      maxClientClockSkewMs: 15 * 60 * 1000,
    });

    await repository.applyMutation('user-1', mutation('2026-09-13T12:10:00.000Z', 'allowed-future', 'Allowed future'));

    await expect(repository.readEntity('user-1', 'pantry_item', 'tomato')).resolves.toMatchObject({
      clientUpdatedAt: new Date('2026-09-13T12:10:00.000Z'),
    });
  });
});
