import { beforeEach, describe, expect, it } from 'vitest';
import type { DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { deleteLocalDatabase, writeKeyValue } from './indexedDb';
import { scopeStorageKey } from '../sync/scopeContext';
import { clearDinnerDiary, readDinnerEntries, readSavedRecipes, writeDinnerEntries, writeSavedRecipes } from './dinnerDiaryStorage';

const entry = (updatedAt = '2026-09-01T10:00:00.000Z'): DinnerEntry => ({ id: 'entry-1', date: '2026-09-01', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: null, createdAt: '2026-09-01T10:00:00.000Z', updatedAt });
const recipe: SavedRecipe = { id: 'recipe-1', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '100 g', ingredientId: null, optional: false, provenance: 'provided' }], steps: ['Cook'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: null, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' };

describe('dinner diary storage', () => {
  beforeEach(async () => { await deleteLocalDatabase(); window.localStorage.clear(); });

  it('round-trips entries and recipes separately', async () => {
    await writeDinnerEntries([entry()], 'guest');
    await writeSavedRecipes([recipe], 'guest');
    await expect(readDinnerEntries('guest')).resolves.toEqual([entry()]);
    await expect(readSavedRecipes('guest')).resolves.toEqual([recipe]);
  });

  it('drops invalid records and keeps the newest duplicate by updatedAt', async () => {
    await writeKeyValue(scopeStorageKey('guest', 'dinner-entries'), JSON.stringify({ items: [entry(), { ...entry('2026-09-02T10:00:00.000Z'), text: 'New' }, { id: 'bad' }] }));
    await writeKeyValue(scopeStorageKey('guest', 'saved-recipes'), JSON.stringify({ items: [{ ...recipe, updatedAt: '2026-09-01T10:00:00.000Z' }, { ...recipe, title: 'New', updatedAt: '2026-09-02T10:00:00.000Z' }, { id: 'bad' }] }));
    await expect(readDinnerEntries('guest')).resolves.toEqual([{ ...entry('2026-09-02T10:00:00.000Z'), text: 'New' }]);
    await expect(readSavedRecipes('guest')).resolves.toEqual([{ ...recipe, title: 'New', updatedAt: '2026-09-02T10:00:00.000Z' }]);
  });

  it('isolates scopes and clears only the requested scope', async () => {
    await writeDinnerEntries([entry()], 'account:a');
    await writeDinnerEntries([{ ...entry(), id: 'house-entry' }], 'house:h');
    await writeSavedRecipes([recipe], 'house:h');
    await clearDinnerDiary('account:a');
    await expect(readDinnerEntries('account:a')).resolves.toEqual([]);
    await expect(readDinnerEntries('house:h')).resolves.toHaveLength(1);
    await expect(readSavedRecipes('house:h')).resolves.toEqual([recipe]);
  });

  it('round-trips and clears local draft sets with the diary scope', async () => {
    const draftSet = { entryId: 'entry-1', entryUpdatedAt: '2026-09-01T10:00:00.000Z', drafts: [] };
    const { readDiaryDraftSets, writeDiaryDraftSets } = await import('./dinnerDiaryStorage');
    await writeDiaryDraftSets([draftSet], 'house:h');
    await expect(readDiaryDraftSets('house:h')).resolves.toEqual([draftSet]);
    await clearDinnerDiary('house:h');
    await expect(readDiaryDraftSets('house:h')).resolves.toEqual([]);
  });

  it('uses localStorage when IndexedDB is unavailable', async () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
    await writeDinnerEntries([entry()], 'guest');
    await expect(readDinnerEntries('guest')).resolves.toEqual([entry()]);
  });
});
