import { describe, expect, it, vi } from 'vitest';
import type { SyncMutation } from '@ikuck/shared/contracts';
import { createMemorySyncRepository, resolveScopeForCurrentMembership, SyncMembershipRequiredError, SyncScopeInvalidError } from './repository.js';

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
  it('resolves shared writes from the current membership and rejects stale or personal-in-house scopes', () => {
    expect(resolveScopeForCurrentMembership('user-1', 'cook_event', 'house-1')).toEqual({ kind: 'house', id: 'house-1' });
    expect(resolveScopeForCurrentMembership('user-1', 'cook_event', null)).toEqual({ kind: 'user', id: 'user-1' });
    expect(() => resolveScopeForCurrentMembership('user-1', 'cook_event', 'house-1', 'account:user-1'))
      .toThrow(SyncScopeInvalidError);
    expect(() => resolveScopeForCurrentMembership('user-1', 'ai_consent', 'house-1', 'house:house-1'))
      .toThrow(SyncScopeInvalidError);
    expect(() => resolveScopeForCurrentMembership('user-1', 'cook_event', null, 'house:house-1'))
      .toThrow(SyncMembershipRequiredError);
  });

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

  it('allows every house member to edit and delete a dinner while preserving creator attribution', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const entry = (authorId: string | null, text: string) => ({ id: 'entry-1', date: '2026-09-13', text, servings: null, note: null, recipes: [], authorId, createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z' });
    await repository.applyMutation('author', { ...mutation('2026-09-13T12:00:00.000Z', 'create-entry', 'x'), entityType: 'dinner_entry', entityId: 'entry-1', payload: entry('spoof', 'Dinner') });
    await expect(repository.readEntity('author', 'dinner_entry', 'entry-1')).resolves.toMatchObject({ payload: { authorId: 'author' } });

    await expect(repository.applyMutation('member', {
      ...mutation('2026-09-13T12:01:00.000Z', 'member-edit', 'x'),
      entityType: 'dinner_entry', entityId: 'entry-1', payload: entry('member', 'Updated by member'),
    })).resolves.toMatchObject({ change: { payload: { authorId: 'author', text: 'Updated by member' } } });

    await expect(repository.applyMutation('member', {
      ...mutation('2026-09-13T12:02:00.000Z', 'member-delete', 'x'),
      entityType: 'dinner_entry', entityId: 'entry-1', operation: 'delete', payload: null,
    })).resolves.toMatchObject({ change: { operation: 'delete', payload: null } });

    await expect(repository.applyMutation('member', {
      ...mutation('2026-09-13T12:03:00.000Z', 'member-recreate', 'x'),
      entityType: 'dinner_entry', entityId: 'entry-1', payload: entry('member', 'Recreated'),
    })).resolves.toMatchObject({ change: { payload: { authorId: 'author', text: 'Recreated' } } });
  });

  it('does not expose a stale personal dinner copy through house reads before a migration retry', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => joined ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' },
    });
    const payload = { id: 'entry-stale', date: '2026-09-13', text: 'Stale personal dinner', servings: null, note: null, recipes: [], authorId: null, createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z' };
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-13T12:00:00.000Z', 'stale-personal-entry', 'x'),
      entityType: 'dinner_entry', entityId: payload.id, payload,
    });
    joined = true;

    await expect(repository.readEntity('user-1', 'dinner_entry', payload.id)).resolves.toBeNull();
  });

  it('automatically migrates pre-house dinner history into the house without a personal copy', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'member-2' || joined
        ? { kind: 'house', id: 'house-1' }
        : { kind: 'user', id: 'user-1' },
    });
    const payload = { id: 'entry-1', date: '2026-09-13', text: 'Pre-house dinner', servings: null, note: null, recipes: [], authorId: null, createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z' };
    await repository.applyMutation('user-1', { ...mutation('2026-09-13T12:00:00.000Z', 'personal-entry', 'x'), entityType: 'dinner_entry', entityId: 'entry-1', payload });
    joined = true;

    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readEntity('user-1', 'dinner_entry', 'entry-1')).resolves.toMatchObject({
      syncScope: 'house:house-1',
      payload: { text: 'Pre-house dinner', authorId: 'user-1' },
    });
    await expect(repository.readEntity('member-2', 'dinner_entry', 'entry-1')).resolves.toMatchObject({
      syncScope: 'house:house-1',
      payload: { text: 'Pre-house dinner', authorId: 'user-1' },
    });
    await expect(repository.readChanges('user-1', 0, 100, 'account:user-1')).resolves.not.toContainEqual(
      expect.objectContaining({ entityType: 'dinner_entry', entityId: 'entry-1' }),
    );
  });

  it('allows every House member to edit and delete another author’s saved recipe without changing its author', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async () => ({ kind: 'house', id: 'house-1' }),
    });
    const recipe = (title: string, authorId: string | null) => ({
      id: 'recipe-1', title, description: '', ingredients: [{ name: 'Ceci', amount: '240 g', ingredientId: 'chickpeas', optional: false, provenance: 'provided' as const }],
      steps: ['Scola i ceci.'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary' as const,
      authorId, createdAt: '2026-09-13T12:00:00.000Z', updatedAt: '2026-09-13T12:00:00.000Z',
    });
    const create = { ...mutation('2026-09-13T12:00:00.000Z', 'recipe-create', 'x'), entityType: 'saved_recipe' as const, entityId: 'recipe-1', payload: recipe('Ricetta', 'spoof') };
    await repository.applyMutation('author', create);
    const memberEdit = await repository.applyMutation('member', {
      ...create,
      mutationId: 'recipe-member-edit',
      payload: recipe('Ricetta corretta', 'member'),
      clientUpdatedAt: '2026-09-13T12:01:00.000Z',
    });
    expect(memberEdit.change?.payload).toMatchObject({ title: 'Ricetta corretta', authorId: 'author' });
    const memberDelete = await repository.applyMutation('member', {
      ...create,
      mutationId: 'recipe-member-delete',
      operation: 'delete',
      payload: null,
      clientUpdatedAt: '2026-09-13T12:02:00.000Z',
    });
    expect(memberDelete.change).toMatchObject({ operation: 'delete', payload: null });
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

  it('shares shopping and cooking data with every current house member', async () => {
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

    await expect(repository.readEntity('user-2', 'shopping_list_item', 'shopping-1')).resolves.toMatchObject({
      syncScope: 'house:house-1',
      payload: { label: 'Pasta' },
    });
    await expect(repository.readEntity('user-2', 'cook_event', 'event-1')).resolves.toMatchObject({
      syncScope: 'house:house-1',
      payload: { recipeTitle: 'Pasta' },
    });
    await expect(repository.readEntity('outsider', 'shopping_list_item', 'shopping-1')).resolves.toBeNull();
    await expect(repository.readEntity('outsider', 'cook_event', 'event-1')).resolves.toBeNull();
  });

  it('shares recipe preferences, the diet profile, and saved AI recipes while keeping AI consent personal', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'user-1' || userId === 'user-2' ? { kind: 'house', id: 'house-1' } : null,
    });
    const timestamp = '2026-09-12T12:00:00.000Z';
    const entities = [
      {
        entityType: 'recipe_preference' as const,
        entityId: 'recipe-1',
        payload: { recipeId: 'recipe-1', favorite: true, rating: 5, note: 'Da rifare', createdAt: timestamp, updatedAt: timestamp },
      },
      {
        entityType: 'diet_profile' as const,
        entityId: 'profile',
        payload: { diet: 'vegetarian' as const, excludedAllergens: ['milk' as const], nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 20 }, updatedAt: timestamp },
      },
      {
        entityType: 'generated_recipe' as const,
        entityId: 'generated-1',
        payload: {
          id: 'generated-1', title: 'Ceci veloci', description: 'Una cena veloce.', ingredients: [{ name: 'Ceci', amount: '240 g' }],
          steps: ['Scola i ceci.'], diets: ['vegan' as const], allergens: [], source: 'ai' as const, createdAt: timestamp, updatedAt: timestamp,
        },
      },
    ];

    for (const [index, entity] of entities.entries()) {
      await repository.applyMutation('user-1', {
        ...mutation(timestamp, `shared-${index}`, 'x'),
        ...entity,
      });
      await expect(repository.readEntity('user-2', entity.entityType, entity.entityId)).resolves.toMatchObject({
        syncScope: 'house:house-1',
        payload: entity.payload,
      });
    }

    await repository.applyMutation('user-1', {
      ...mutation(timestamp, 'personal-consent', 'x'),
      entityType: 'ai_consent',
      entityId: 'profile',
      payload: { enabled: true, updatedAt: timestamp },
    });
    await expect(repository.readEntity('user-1', 'ai_consent', 'profile')).resolves.toMatchObject({
      syncScope: 'account:user-1',
      payload: { enabled: true },
    });
    await expect(repository.readEntity('user-2', 'ai_consent', 'profile')).resolves.toBeNull();
  });

  it('rejects a stale account scope for a functional record after the account joins a house', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const timestamp = '2026-09-12T12:00:00.000Z';

    await expect(repository.applyMutation('user-1', {
      ...mutation(timestamp, 'stale-account-shopping', 'Pasta'),
      entityType: 'shopping_list_item',
      entityId: 'shopping-1',
      payload: {
        id: 'shopping-1', ingredientId: 'pasta', label: 'Pasta', quantity: 1, unit: 'pack', note: null,
        purchased: false, sourceRecipeId: null, createdAt: timestamp, updatedAt: timestamp,
      },
      syncScope: 'account:user-1',
    })).rejects.toMatchObject({ code: 'sync_scope_invalid', status: 400 });

    await expect(repository.readEntity('user-1', 'shopping_list_item', 'shopping-1')).resolves.toBeNull();
  });

  it('rejects a house scope for personal AI consent at the repository boundary', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });

    await expect(repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:00:00.000Z', 'personal-house-scope', 'Personal consent'),
      entityType: 'ai_consent',
      entityId: 'profile',
      payload: { enabled: true, updatedAt: '2026-09-12T12:00:00.000Z' },
      syncScope: 'house:house-1',
    })).rejects.toMatchObject({ code: 'sync_scope_invalid' });
    await expect(repository.readEntity('user-1', 'ai_consent', 'profile')).resolves.toBeNull();
  });

  it('merges pre-house diet and allergen restrictions conservatively into the single house profile', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'member-2' || joined
        ? { kind: 'house', id: 'house-1' }
        : { kind: 'user', id: 'user-1' },
    });
    const houseUpdatedAt = '2026-09-12T11:00:00.000Z';
    const personalUpdatedAt = '2026-09-12T12:00:00.000Z';
    await repository.applyMutation('member-2', {
      ...mutation(houseUpdatedAt, 'house-diet', 'x'),
      entityType: 'diet_profile',
      entityId: 'profile',
      payload: {
        diet: 'pescatarian', excludedAllergens: ['gluten'],
        nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 25 }, updatedAt: houseUpdatedAt,
      },
    });
    await repository.applyMutation('user-1', {
      ...mutation(personalUpdatedAt, 'personal-diet', 'x'),
      entityType: 'diet_profile',
      entityId: 'profile',
      payload: {
        diet: 'vegetarian', excludedAllergens: ['milk'],
        nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 20 }, updatedAt: personalUpdatedAt,
      },
    });
    joined = true;

    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      syncScope: 'house:house-1',
      payload: {
        diet: 'vegetarian',
        excludedAllergens: expect.arrayContaining(['gluten', 'milk']),
        nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 25 },
        updatedAt: personalUpdatedAt,
      },
    });
    await expect(repository.readChanges('user-1', 0, 100, 'account:user-1')).resolves.not.toContainEqual(
      expect.objectContaining({ entityType: 'diet_profile', entityId: 'profile' }),
    );
  });

  it('conservatively imports an unsent pre-house diet update instead of overwriting shared allergens', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const houseProfile = { diet: 'vegetarian' as const, excludedAllergens: ['gluten' as const], nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: '2026-09-12T11:00:00.000Z' };
    const pendingProfile = { ...houseProfile, excludedAllergens: ['milk' as const], updatedAt: '2026-09-12T12:00:00.000Z' };
    await repository.applyMutation('member-2', { ...mutation(houseProfile.updatedAt, 'house-diet', 'x'), entityType: 'diet_profile', entityId: 'profile', payload: houseProfile, syncScope: 'house:house-1' });
    const pending = { ...mutation(pendingProfile.updatedAt, 'unsent-account-diet', 'x'), entityType: 'diet_profile' as const, entityId: 'profile', payload: pendingProfile, syncScope: 'account:user-1' as const };
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: { excludedAllergens: expect.arrayContaining(['gluten', 'milk']) },
    });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: { excludedAllergens: expect.arrayContaining(['gluten', 'milk']) },
    });
  });

  it('does not let a pending account diet deletion remove House allergens', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const houseProfile = {
      diet: 'vegan' as const,
      excludedAllergens: ['milk', 'gluten'] as const,
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      updatedAt: '2026-09-12T11:00:00.000Z',
    };
    await repository.applyMutation('member-2', {
      ...mutation(houseProfile.updatedAt, 'house-diet-before-delete', 'x'),
      entityType: 'diet_profile', entityId: 'profile', payload: houseProfile,
      syncScope: 'house:house-1',
    });
    const pendingDelete = {
      ...mutation('2026-09-12T12:00:00.000Z', 'pending-account-diet-delete', 'x'),
      entityType: 'diet_profile' as const, entityId: 'profile', operation: 'delete' as const, payload: null,
      syncScope: 'account:user-1' as const,
    };

    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pendingDelete]);

    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      deleted: false,
      payload: { diet: 'vegan', excludedAllergens: expect.arrayContaining(['gluten', 'milk']) },
    });
  });

  it('merges guest diet imports conservatively, retries idempotently, and accepts a revised import', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const timestamp = new Date().toISOString();
    const revisedTimestamp = new Date(Date.parse(timestamp) + 1000).toISOString();
    const houseProfile = {
      diet: 'vegan' as const,
      excludedAllergens: ['milk', 'gluten'] as const,
      nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 25 },
      updatedAt: timestamp,
    };
    await repository.applyMutation('member-2', {
      ...mutation(timestamp, 'existing-house-diet', 'x'), entityType: 'diet_profile', entityId: 'profile',
      payload: houseProfile, syncScope: 'house:house-1',
    });
    const guestImport: SyncMutation = {
      mutationId: 'guest-diet-revision-1', deviceId: 'guest-device', entityType: 'diet_profile', entityId: 'profile',
      operation: 'upsert', payload: {
        diet: 'omnivore', excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null }, updatedAt: timestamp,
      }, clientUpdatedAt: timestamp,
    };

    await expect(repository.mergeGuestDietProfileToHouse('member-2', 'house-1', guestImport)).resolves.toBe(true);
    await expect(repository.mergeGuestDietProfileToHouse('member-2', 'house-1', guestImport)).resolves.toBe(false);
    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: {
        diet: 'vegan', excludedAllergens: expect.arrayContaining(['milk', 'gluten']),
        nutrition: { maxCaloriesPerServing: 600, minProteinGramsPerServing: 25 },
      },
    });

    const revisedImport: SyncMutation = {
      ...guestImport,
      mutationId: 'guest-diet-revision-2',
      clientUpdatedAt: revisedTimestamp,
      payload: { ...guestImport.payload as object, excludedAllergens: ['peanuts'], updatedAt: revisedTimestamp },
    };
    await expect(repository.mergeGuestDietProfileToHouse('member-2', 'house-1', revisedImport)).resolves.toBe(true);
    await expect(repository.readEntity('member-2', 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: { diet: 'vegan', excludedAllergens: expect.arrayContaining(['milk', 'gluten', 'peanuts']) },
    });
  });

  it('semantically imports an unsent account lot even if its id matches another member’s lot', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    const houseLot = pantryLot('same-lot', 200, 'g', '2026-10-01');
    const pendingLot = { ...houseLot, quantity: 500, updatedAt: '2026-09-12T12:01:00.000Z' };
    await repository.applyMutation('member-2', { ...mutation(houseLot.updatedAt, 'house-lot', 'x'), entityType: 'pantry_lot', entityId: houseLot.id, payload: houseLot, syncScope: 'house:house-1' });
    const pending = { ...mutation(pendingLot.updatedAt, 'unsent-account-lot', 'x'), entityType: 'pantry_lot' as const, entityId: pendingLot.id, payload: pendingLot, syncScope: 'account:user-1' as const };
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toHaveLength(1);
    expect(lots[0]?.payload).toMatchObject({ quantity: 700, unit: 'g' });
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const retryLots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(retryLots).toHaveLength(1);
    expect(retryLots[0]?.payload).toMatchObject({ quantity: 700, unit: 'g' });
  });

  it('replaces only the original account lot contribution on a delayed revision after a prior migration', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({ scopeResolver: async (userId) => userId === 'member-2' || joined
      ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' } });
    const houseLot = pantryLot('house-lot', 300, 'g', '2026-10-01');
    const accountLot = pantryLot('account-lot', 200, 'g', '2026-10-01');
    await repository.applyMutation('member-2', { ...mutation(houseLot.updatedAt, 'house-origin', 'x'), entityType: 'pantry_lot', entityId: houseLot.id, payload: houseLot });
    await repository.applyMutation('user-1', { ...mutation(accountLot.updatedAt, 'account-origin', 'x'), entityType: 'pantry_lot', entityId: accountLot.id, payload: accountLot });
    joined = true;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');
    const pending = { ...mutation('2026-09-12T12:01:00.000Z', 'account-later', 'x'), entityType: 'pantry_lot' as const,
      entityId: accountLot.id, payload: { ...accountLot, quantity: 450, updatedAt: '2026-09-12T12:01:00.000Z' }, syncScope: 'account:user-1' as const };
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 750, unit: 'g' }) })]);
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const retry = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(retry).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 750, unit: 'g' }) })]);
  });

  it('removes only the original account lot contribution for a delayed deletion', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({ scopeResolver: async (userId) => userId === 'member-2' || joined
      ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' } });
    const houseLot = pantryLot('house-lot', 300, 'g', '2026-10-01');
    const accountLot = pantryLot('account-lot', 200, 'g', '2026-10-01');
    await repository.applyMutation('member-2', { ...mutation(houseLot.updatedAt, 'house-origin', 'x'), entityType: 'pantry_lot', entityId: houseLot.id, payload: houseLot });
    await repository.applyMutation('user-1', { ...mutation(accountLot.updatedAt, 'account-origin', 'x'), entityType: 'pantry_lot', entityId: accountLot.id, payload: accountLot });
    joined = true;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');
    const pending = { ...mutation('2026-09-12T12:01:00.000Z', 'account-delete', 'x'), entityType: 'pantry_lot' as const,
      entityId: accountLot.id, operation: 'delete' as const, payload: null, syncScope: 'account:user-1' as const };
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 300, unit: 'g' }) })]);
  });

  it('replaces and deletes an imported account lot contribution across writer devices', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({ scopeResolver: async (userId) => userId === 'member-2' || joined
      ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' } });
    const houseLot = pantryLot('house-lot', 300, 'g', '2026-10-01');
    const accountLot = pantryLot('account-lot', 200, 'g', '2026-10-01');
    await repository.applyMutation('member-2', {
      ...mutation(houseLot.updatedAt, 'house-origin', 'x'), deviceId: 'house-device',
      entityType: 'pantry_lot', entityId: houseLot.id, payload: houseLot,
    });
    await repository.applyMutation('user-1', {
      ...mutation(accountLot.updatedAt, 'account-origin', 'x'), deviceId: 'original-device',
      entityType: 'pantry_lot', entityId: accountLot.id, payload: accountLot,
    });
    joined = true;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    const revisedAt = '2026-09-12T12:01:00.000Z';
    const revision = {
      ...mutation(revisedAt, 'account-revision-device-2', 'x'), deviceId: 'revision-device',
      entityType: 'pantry_lot' as const, entityId: accountLot.id,
      payload: { ...accountLot, quantity: 450, updatedAt: revisedAt }, syncScope: 'account:user-1' as const,
    };
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [revision]);
    let lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 750, unit: 'g' }) })]);

    const deletedAt = '2026-09-12T12:02:00.000Z';
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [{
      ...mutation(deletedAt, 'account-delete-device-3', 'x'), deviceId: 'delete-device',
      entityType: 'pantry_lot', entityId: accountLot.id, operation: 'delete', payload: null,
      syncScope: 'account:user-1',
    }]);
    lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 300, unit: 'g' }) })]);
  });

  it('rolls back in-memory pending account staging when semantic pantry migration fails', async () => {
    let failDuringMerge = false;
    let migrationClockCalls = 0;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'user-1'
        ? { kind: 'user', id: 'user-1' } : { kind: 'house', id: 'house-1' },
      clock: () => {
        if (failDuringMerge && ++migrationClockCalls === 2) throw new Error('injected semantic merge failure');
        return new Date('2026-09-12T12:00:00.000Z');
      },
    });
    const houseLot = pantryLot('house-lot', 300, 'g', '2026-10-01');
    const accountLot = pantryLot('account-lot', 200, 'g', '2026-10-01');
    await repository.applyMutation('member-2', {
      ...mutation(houseLot.updatedAt, 'house-origin', 'x'), entityType: 'pantry_lot', entityId: houseLot.id,
      payload: houseLot, syncScope: 'house:house-1',
    });
    await repository.applyMutation('user-1', {
      ...mutation(accountLot.updatedAt, 'account-origin', 'x'), entityType: 'pantry_lot', entityId: accountLot.id,
      payload: accountLot, syncScope: 'account:user-1',
    });
    const pending = {
      ...mutation('2026-09-12T12:01:00.000Z', 'pending-account-revision', 'x'),
      deviceId: 'revision-device', entityType: 'pantry_lot' as const, entityId: accountLot.id,
      payload: { ...accountLot, quantity: 450, updatedAt: '2026-09-12T12:01:00.000Z' },
      syncScope: 'account:user-1' as const,
    };
    failDuringMerge = true;
    await expect(repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]))
      .rejects.toThrow('injected semantic merge failure');
    await expect(repository.readEntity('user-1', 'pantry_lot', accountLot.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 200 }),
    });
    await expect(repository.readEntity('member-2', 'pantry_lot', houseLot.id)).resolves.toMatchObject({
      payload: expect.objectContaining({ quantity: 300 }),
    });

    failDuringMerge = false;
    await repository.migrateUserSharedDataToHouse('user-1', 'house-1', [pending]);
    const lots = (await repository.readAll('member-2')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 750, unit: 'g' }) })]);
  });

  it('preserves same-device same-ID lots contributed by different house members', async () => {
    const joined = new Set<string>();
    const repository = createMemorySyncRepository({ scopeResolver: async (userId) => userId === 'house-admin' || joined.has(userId)
      ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: userId } });
    const houseLot = pantryLot('shared-lot', 200, 'g', '2026-10-01');
    const memberLot = pantryLot('shared-lot', 500, 'g', '2026-10-01');
    await repository.applyMutation('house-admin', {
      ...mutation(houseLot.updatedAt, 'house-shared-lot', 'x'), deviceId: 'same-device',
      entityType: 'pantry_lot', entityId: houseLot.id, payload: houseLot, syncScope: 'house:house-1',
    });
    for (const userId of ['member-1', 'member-2']) {
      await repository.applyMutation(userId, {
        ...mutation(memberLot.updatedAt, `account-${userId}`, 'x'), deviceId: 'same-device',
        entityType: 'pantry_lot', entityId: memberLot.id, payload: memberLot, syncScope: `account:${userId}`,
      });
    }
    joined.add('member-1');
    joined.add('member-2');
    await repository.migrateUserSharedDataToHouse('member-1', 'house-1');
    await repository.migrateUserSharedDataToHouse('member-2', 'house-1');

    const lots = (await repository.readAll('house-admin')).filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toEqual([expect.objectContaining({ payload: expect.objectContaining({ quantity: 1200, unit: 'g' }) })]);
  });

  it('uses the semantic pantry merge while migrating all pre-house data', async () => {
    let joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'member-2' || joined
        ? { kind: 'house', id: 'house-1' }
        : { kind: 'user', id: 'user-1' },
    });
    const existing = { ...pantryLot('house-lot', 200, 'g', '2026-10-01'), updatedAt: '2026-09-12T11:00:00.000Z' };
    const incoming = { ...pantryLot('personal-lot', 500, 'g', '2026-10-01'), updatedAt: '2026-09-12T12:00:00.000Z' };
    await repository.applyMutation('member-2', {
      ...mutation(existing.updatedAt, 'house-lot-mutation', 'Pasta'),
      entityType: 'pantry_lot', entityId: existing.id, payload: existing,
    });
    await repository.applyMutation('user-1', {
      ...mutation(incoming.updatedAt, 'personal-lot-mutation', 'Pasta'),
      entityType: 'pantry_lot', entityId: incoming.id, payload: incoming,
    });
    joined = true;

    await repository.migrateUserSharedDataToHouse('user-1', 'house-1');

    const lots = (await repository.readAll('member-2'))
      .filter((change) => change.entityType === 'pantry_lot' && change.operation === 'upsert');
    expect(lots).toHaveLength(1);
    expect(lots[0]?.payload).toMatchObject({ quantity: 700, unit: 'g' });
    await expect(repository.readChanges('user-1', 0, 100, 'account:user-1')).resolves.not.toContainEqual(
      expect.objectContaining({ entityType: 'pantry_lot' }),
    );
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

  it('shares house-scoped diet data between members while keeping AI consent isolated', async () => {
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
    await repository.applyMutation('user-1', {
      ...mutation('2026-09-12T12:01:00.000Z', 'personal-consent-mutation', 'Consenso personale'),
      entityType: 'ai_consent',
      entityId: 'profile',
      payload: { enabled: true, updatedAt: '2026-09-12T12:01:00.000Z' },
    });

    await expect(repository.readEntity('user-2', 'pantry_item', 'tomato')).resolves.toMatchObject({ payload: { label: 'Dispensa condivisa' } });
    await expect(repository.readEntity('user-2', 'diet_profile', 'profile')).resolves.toMatchObject({ payload: { diet: 'vegan' } });
    await expect(repository.readEntity('user-2', 'ai_consent', 'profile')).resolves.toBeNull();
    await expect(repository.readEntity('user-1', 'ai_consent', 'profile')).resolves.toMatchObject({ payload: { enabled: true } });
  });

  it('imports all functional personal data into the current house and removes the source rows', async () => {
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

    await expect(repository.readEntity('user-1', 'pantry_lot', 'legacy:tomato')).resolves.toMatchObject({ payload: { label: 'Personal pantry' } });
    await expect(repository.readEntity('user-1', 'diet_profile', 'profile')).resolves.toMatchObject({ payload: { diet: 'vegan' } });
    await expect(repository.readAll('user-1')).resolves.toHaveLength(2);
  });

  it('merges house diet restrictions into a deterministic conservative union', async () => {
    let user2Joined = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async (userId) => userId === 'user-1' || user2Joined
        ? { kind: 'house', id: 'house-1' }
        : { kind: 'user', id: userId },
    });
    const houseProfile = {
      diet: 'omnivore' as const,
      excludedAllergens: ['molluscs', 'milk'],
      nutrition: { maxCaloriesPerServing: 700, minProteinGramsPerServing: 20 },
      updatedAt: '2026-09-12T12:00:00.000Z',
    };
    const personalProfile = {
      diet: 'vegetarian' as const,
      excludedAllergens: ['peanuts', 'milk'],
      nutrition: { maxCaloriesPerServing: 500, minProteinGramsPerServing: 30 },
      updatedAt: '2026-09-12T12:01:00.000Z',
    };
    await repository.applyMutation('user-1', {
      ...mutation(houseProfile.updatedAt, 'house-diet', 'House diet'),
      entityType: 'diet_profile', entityId: 'profile', payload: houseProfile,
    });
    await repository.applyMutation('user-2', {
      ...mutation(personalProfile.updatedAt, 'personal-diet', 'Personal diet'),
      entityType: 'diet_profile', entityId: 'profile', payload: personalProfile,
    });

    user2Joined = true;
    await repository.migrateUserSharedDataToHouse('user-2', 'house-1');

    await expect(repository.readEntity('user-1', 'diet_profile', 'profile')).resolves.toMatchObject({
      payload: {
        diet: 'vegetarian',
        excludedAllergens: ['milk', 'molluscs', 'peanuts'],
        nutrition: { maxCaloriesPerServing: 500, minProteinGramsPerServing: 30 },
      },
    });
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
