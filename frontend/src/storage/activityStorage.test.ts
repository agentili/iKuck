import { beforeEach, describe, expect, it } from 'vitest';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { deleteLocalDatabase, writeKeyValue } from './indexedDb';
import {
  readCookEvents,
  readRecipePreferences,
  writeCookEvents,
  writeRecipePreferences,
} from './activityStorage';

const event: CookEvent = {
  id: 'event-1',
  recipeId: 'recipe-1',
  recipeTitle: 'Pasta',
  servings: 2,
  cookedAt: '2026-09-13T12:00:00.000Z',
  note: 'Aggiunto basilico',
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

const preference: RecipePreference = {
  recipeId: 'recipe-1',
  favorite: true,
  rating: 5,
  note: 'Da rifare',
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

describe('activity storage', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
  });

  it('returns empty collections when no local value exists', async () => {
    await expect(readCookEvents()).resolves.toEqual([]);
    await expect(readRecipePreferences()).resolves.toEqual([]);
  });

  it('round-trips events, preferences and private notes', async () => {
    await writeCookEvents([event]);
    await writeRecipePreferences([preference]);

    await expect(readCookEvents()).resolves.toEqual([event]);
    await expect(readRecipePreferences()).resolves.toEqual([preference]);
  });

  it('normalizes malformed values to empty collections', async () => {
    await writeKeyValue('activity', '{not-json');
    await writeKeyValue('recipe-preferences', JSON.stringify({ items: [{ recipeId: 'recipe-1', rating: 9 }] }));

    await expect(readCookEvents()).resolves.toEqual([]);
    await expect(readRecipePreferences()).resolves.toEqual([]);
  });
});
