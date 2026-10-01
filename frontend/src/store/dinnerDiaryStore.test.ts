import { beforeEach, describe, expect, it, vi } from 'vitest';
const { snapshotListeners } = vi.hoisted(() => ({ snapshotListeners: [] as Array<(snapshot: { scope: 'guest' | `account:${string}` | `house:${string}`; entries: any[]; recipes: any[] }) => void> }));
vi.mock('../sync/syncQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync/syncQueue')>();
  return { ...actual, registerDinnerDiarySnapshotListener: (listener: (snapshot: any) => void) => { snapshotListeners.push(listener); return () => undefined; } };
});
import * as storage from '../storage/dinnerDiaryStorage';
import { deleteLocalDatabase } from '../storage/indexedDb';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';
import { useDinnerDiaryStore, hydrateDinnerDiaryStore, waitForPendingDinnerDiaryWrites } from './dinnerDiaryStore';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { readQueuedMutations } from '../sync/syncQueue';
import type { DinnerEntry, DiaryRecipeDraft, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { clearDataScope } from '../sync/syncQueue';

describe('dinner diary store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase(); window.localStorage.clear();
    setPersonalDataScope('guest'); setActiveDataScope('guest');
    useAuthStore.setState({ user: null });
    useHouseStore.setState({ state: null });
    useDinnerDiaryStore.setState({ hasHydrated: false, entries: [], recipes: [], drafts: [], error: null });
  });
  it('creates validated active-scope entries with their original text', async () => {
    const id = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: '  Pasta  ', servings: 2, note: null });
    expect(id).toBeTruthy();
    expect(useDinnerDiaryStore.getState().entries[0]).toMatchObject({ scope: 'guest', value: { id, text: '  Pasta  ', date: '2026-09-30' } });
    await hydrateDinnerDiaryStore();
  });
  it('explicitly clears nullable fields while preserving omitted fields', async () => {
    const id = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Pasta', servings: 2, note: 'Dinner' });
    expect(id).toBeTruthy();
    const original = useDinnerDiaryStore.getState().entries[0].value;
    expect(useDinnerDiaryStore.getState().updateEntry('guest', id!, { note: null })).toBe(true);
    expect(useDinnerDiaryStore.getState().entries[0].value).toMatchObject({ servings: 2, note: null });
    expect(useDinnerDiaryStore.getState().updateEntry('guest', id!, { servings: null })).toBe(true);
    expect(useDinnerDiaryStore.getState().entries[0].value).toMatchObject({ servings: null, note: null });
    expect(useDinnerDiaryStore.getState().entries[0].value.authorId).toBe(original.authorId);
    await waitForPendingDinnerDiaryWrites();
  });

  it('hydrates exactly the active and personal namespaces, deduplicating equal scopes', async () => {
    const reads = vi.spyOn(storage, 'readDinnerEntries');
    setPersonalDataScope('account:user-1'); setActiveDataScope('house:home-1');
    reads.mockClear();
    await hydrateDinnerDiaryStore();
    expect(reads.mock.calls.map(([scope]) => scope).sort()).toEqual(['account:user-1', 'house:home-1']);
    setActiveDataScope('account:user-1');
    reads.mockClear();
    await hydrateDinnerDiaryStore();
    expect(reads.mock.calls.map(([scope]) => scope)).toEqual(['account:user-1']);
    reads.mockRestore();
  });

  it('does not apply a delayed hydration after the scope changes', async () => {
    const pending: Array<(value: never[]) => void> = [];
    const spy = vi.spyOn(storage, 'readDinnerEntries').mockImplementation((scope) => new Promise(resolve => {
      pending.push((value) => resolve(value as never));
      if (scope === 'guest') resolve([]);
    }));
    setActiveDataScope('account:old');
    const hydration = hydrateDinnerDiaryStore();
    setActiveDataScope('account:new');
    pending.splice(0).forEach(resolve => resolve([]));
    await hydration;
    expect(useDinnerDiaryStore.getState().entries.every(item => item.scope !== 'account:old')).toBe(true);
    spy.mockRestore();
  });

  it('accepts snapshots only for an allowed current scope and replaces that scope alone', () => {
    setPersonalDataScope('account:user-1'); setActiveDataScope('house:home-1');
    const entry = (id: string) => ({ id, date: '2026-01-01', text: id, servings: null, note: null, recipes: [], authorId: 'user-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    useDinnerDiaryStore.setState({ entries: [{ scope: 'house:home-1', value: entry('old-house') }, { scope: 'account:user-1', value: entry('personal') }], recipes: [], drafts: [] });
    const receive = snapshotListeners[0];
    receive({ scope: 'house:home-1', entries: [entry('new-house')], recipes: [] });
    expect(useDinnerDiaryStore.getState().entries.map(v => v.value.id).sort()).toEqual(['new-house', 'personal']);
    receive({ scope: 'guest', entries: [entry('stale')], recipes: [] });
    expect(useDinnerDiaryStore.getState().entries.some(v => v.value.id === 'stale')).toBe(false);
  });

  it('uses local calendar date components', async () => {
    expect(useDinnerDiaryStore.getState().localDate(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });

  it('serializes rapid writes within the same scope so an older snapshot cannot finish last', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const snapshots: string[][] = [];
    const writeSpy = vi.spyOn(storage, 'writeDinnerEntries').mockImplementation(async (entries) => {
      snapshots.push(entries.map((entry) => entry.id));
      if (snapshots.length === 1) await firstWrite;
    });

    const first = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Uno', servings: 2, note: null });
    const second = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Due', servings: 2, note: null });
    await Promise.resolve();
    const callsBeforeReleasingFirstWrite = snapshots.length;
    releaseFirst?.();
    await waitForPendingDinnerDiaryWrites();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(callsBeforeReleasingFirstWrite).toBe(1);
    expect(snapshots.at(-1)).toEqual([first, second]);
    writeSpy.mockRestore();
  });

  it('denies House mutations when the membership is no longer active', () => {
    const scope = 'house:home-1';
    const now = '2026-09-30T10:00:00.000Z';
    const entry = { id: 'entry-1', date: '2026-09-30', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: 'user-1', createdAt: now, updatedAt: now };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    useHouseStore.setState({ state: { house: { id: 'home-1', name: 'Casa', createdAt: now }, membership: null, members: [] } });
    setPersonalDataScope('account:user-1');
    setActiveDataScope(scope);
    useDinnerDiaryStore.setState({ entries: [{ scope, value: entry }] });

    expect(useDinnerDiaryStore.getState().updateEntry(scope, entry.id, { text: 'Nuova pasta' })).toBe(false);
    expect(useDinnerDiaryStore.getState().deleteEntry(scope, entry.id)).toBe(false);
  });

  it('queues account and House diary entries only in their selected namespaces', async () => {
    const now = '2026-09-30T10:00:00.000Z';
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    setPersonalDataScope('account:user-1');
    setActiveDataScope('account:user-1');
    const accountId = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Account', servings: null, note: null });
    expect(accountId).not.toBeNull();
    await waitForPendingDinnerDiaryWrites();

    useHouseStore.setState({ state: { house: { id: 'home-1', name: 'Casa', createdAt: now }, membership: { role: 'member', joinedAt: now }, members: [] } });
    setActiveDataScope('house:home-1');
    await hydrateDinnerDiaryStore();
    const houseId = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Casa', servings: null, note: null });
    expect(houseId).not.toBeNull();
    await waitForPendingDinnerDiaryWrites();

    await expect(readQueuedMutations('account:user-1')).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', entityId: accountId, operation: 'upsert' })]);
    await expect(readQueuedMutations('house:home-1')).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', entityId: houseId, operation: 'upsert' })]);
    expect(useDinnerDiaryStore.getState().entries.map((item) => item.scope).sort()).toEqual(['account:user-1', 'house:home-1']);
  });

  it('queues confirmed saved-recipe upserts and tombstones only to their House scope', async () => {
    const now = '2026-09-30T10:00:00.000Z';
    const scope = 'house:home-1';
    const recipe: SavedRecipe = { id: 'recipe-1', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }], steps: ['Cuocere'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: 'user-1', createdAt: now, updatedAt: now };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    useHouseStore.setState({ state: { house: { id: 'home-1', name: 'Casa', createdAt: now }, membership: { role: 'member', joinedAt: now }, members: [] } });
    setPersonalDataScope('account:user-1');
    setActiveDataScope(scope);
    await hydrateDinnerDiaryStore();

    expect(useDinnerDiaryStore.getState().saveRecipe(scope, recipe)).toBe(true);
    await waitForPendingDinnerDiaryWrites();
    await expect(readQueuedMutations(scope)).resolves.toEqual([expect.objectContaining({ entityType: 'saved_recipe', entityId: recipe.id, operation: 'upsert' })]);
    expect(useDinnerDiaryStore.getState().deleteRecipe(scope, recipe.id)).toBe(true);
    await waitForPendingDinnerDiaryWrites();
    await expect(readQueuedMutations(scope)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'saved_recipe', entityId: recipe.id, operation: 'upsert' }),
      expect.objectContaining({ entityType: 'saved_recipe', entityId: recipe.id, operation: 'delete' }),
    ]));
    await expect(readQueuedMutations('account:user-1')).resolves.toEqual([]);
  });

  it('refuses an obsolete account entry while the House is active and deletes the selected House entry', async () => {
    const now = '2026-09-30T10:00:00.000Z';
    const houseScope = 'house:home-1';
    const accountScope = 'account:user-1';
    const personalEntry = { id: 'personal-entry', date: '2026-09-30', text: 'Account', servings: 2, note: 'Old note', recipes: [], authorId: 'user-1', createdAt: now, updatedAt: now };
    const houseEntry = { ...personalEntry, id: 'house-entry', text: 'House', note: null };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    useHouseStore.setState({ state: { house: { id: 'home-1', name: 'Casa', createdAt: now }, membership: { role: 'member', joinedAt: now }, members: [] } });
    setPersonalDataScope(accountScope);
    setActiveDataScope(houseScope);
    await hydrateDinnerDiaryStore();
    useDinnerDiaryStore.setState({ entries: [{ scope: accountScope, value: personalEntry }, { scope: houseScope, value: houseEntry }] });

    expect(useDinnerDiaryStore.getState().updateEntry(accountScope, personalEntry.id, { note: null })).toBe(false);
    expect(useDinnerDiaryStore.getState().deleteEntry(houseScope, houseEntry.id)).toBe(true);
    await waitForPendingDinnerDiaryWrites();

    await expect(readQueuedMutations(accountScope)).resolves.toEqual([]);
    await expect(readQueuedMutations(houseScope)).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', entityId: houseEntry.id, operation: 'delete' })]);
  });

  it('persists an account mutation to its captured scope when the active scope changes immediately', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    setPersonalDataScope('account:user-1');
    setActiveDataScope('account:user-1');
    const id = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Personale', servings: null, note: null });

    setActiveDataScope('house:home-1');
    await waitForPendingDinnerDiaryWrites();

    expect(await storage.readDinnerEntries('account:user-1')).toEqual([expect.objectContaining({ id, text: 'Personale' })]);
  });

  it('lets any current House member edit and delete another author while refusing foreign scopes', async () => {
    const now = '2026-09-30T10:00:00.000Z';
    const houseScope = 'house:home-1';
    const entry = { id: 'entry-1', date: '2026-09-30', text: 'Pasta', servings: 2, note: null, recipes: [], authorId: 'user-2', createdAt: now, updatedAt: now };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    useHouseStore.setState({ state: { house: { id: 'home-1', name: 'Casa', createdAt: now }, membership: { role: 'member', joinedAt: now }, members: [] } });
    setPersonalDataScope('account:user-1');
    setActiveDataScope(houseScope);
    useDinnerDiaryStore.setState({ entries: [{ scope: 'account:someone-else', value: entry }, { scope: houseScope, value: entry }] });

    expect(useDinnerDiaryStore.getState().updateEntry('account:someone-else', entry.id, { text: 'No' })).toBe(false);
    expect(useDinnerDiaryStore.getState().updateEntry(houseScope, entry.id, { text: 'Member update' })).toBe(true);
    expect(useDinnerDiaryStore.getState().entries.find(item => item.scope === houseScope)?.value.authorId).toBe('user-2');
    expect(useDinnerDiaryStore.getState().deleteEntry(houseScope, entry.id)).toBe(true);
    setActiveDataScope('house:another-house');
    useDinnerDiaryStore.setState({ entries: [{ scope: houseScope, value: entry }] });
    expect(useDinnerDiaryStore.getState().deleteEntry(houseScope, entry.id)).toBe(false);
  });

  it('keeps saved recipes separate when an entry or recipe is deleted', async () => {
    const now = '2026-09-30T10:00:00.000Z';
    const recipe: SavedRecipe = { id: 'recipe-1', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }], steps: ['Cuocere'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: null, createdAt: now, updatedAt: now };
    const entry = { id: 'entry-1', date: '2026-09-30', text: 'Pasta', servings: 2, note: null, recipes: [{ recipeId: recipe.id, title: recipe.title, source: 'diary' as const }], authorId: null, createdAt: now, updatedAt: now };
    useDinnerDiaryStore.setState({ entries: [{ scope: 'guest', value: entry }], recipes: [{ scope: 'guest', value: recipe }] });

    expect(useDinnerDiaryStore.getState().deleteEntry('guest', entry.id)).toBe(true);
    expect(useDinnerDiaryStore.getState().recipes).toContainEqual({ scope: 'guest', value: recipe });
    expect(useDinnerDiaryStore.getState().deleteRecipe('guest', recipe.id)).toBe(true);
    expect(useDinnerDiaryStore.getState().entries).toEqual([]);
  });

  it('keeps revision-bound drafts local, rejects stale drafts, and clears them after editing', async () => {
    const draft = { draftId: 'draft-1', title: 'Pasta', description: '', ingredients: [{ name: 'Pasta', amount: '', ingredientId: null, optional: false, provenance: 'provided' as const }], steps: ['Cuoci la pasta'], servings: null, durationMinutes: null, diets: null, allergens: null, suggestedFields: [] };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    setPersonalDataScope('account:user-1');
    setActiveDataScope('account:user-1');
    await hydrateDinnerDiaryStore();
    const id = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Pasta', servings: null, note: null });
    await waitForPendingDinnerDiaryWrites();
    const entry = useDinnerDiaryStore.getState().entries.find((item) => item.value.id === id)!.value;

    expect(useDinnerDiaryStore.getState().saveDraftSet('account:user-1', { entryId: id!, entryUpdatedAt: '2026-09-29T10:00:00.000Z', drafts: [draft] })).toBe(false);
    expect(useDinnerDiaryStore.getState().saveDraftSet('account:user-1', { entryId: id!, entryUpdatedAt: entry.updatedAt, drafts: [draft] })).toBe(true);
    await waitForPendingDinnerDiaryWrites();
    await expect(storage.readDiaryDraftSets('account:user-1')).resolves.toEqual([{ entryId: id, entryUpdatedAt: entry.updatedAt, drafts: [draft] }]);
    await expect(readQueuedMutations('account:user-1')).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', operation: 'upsert' })]);

    expect(useDinnerDiaryStore.getState().updateEntry('account:user-1', id!, { text: 'Pasta aggiornata' })).toBe(true);
    await waitForPendingDinnerDiaryWrites();
    expect(useDinnerDiaryStore.getState().drafts).toEqual([]);
    await expect(storage.readDiaryDraftSets('account:user-1')).resolves.toEqual([]);
  });

  it('applies a server-confirmed recipe locally without enqueuing a duplicate sync mutation', async () => {
    const scope = 'account:user-1';
    const draft: DiaryRecipeDraft = {
      draftId: 'draft-confirmed', title: 'Pasta', description: '',
      ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }],
      steps: ['Cuoci la pasta.'], servings: null, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
    };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    setPersonalDataScope(scope); setActiveDataScope(scope);
    await hydrateDinnerDiaryStore();
    const entryId = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Pasta', servings: null, note: null });
    await waitForPendingDinnerDiaryWrites();
    const current = useDinnerDiaryStore.getState().entries.find((item) => item.value.id === entryId)!.value;
    const remainingDraft: DiaryRecipeDraft = { ...draft, draftId: 'draft-next', title: 'Insalata' };
    expect(useDinnerDiaryStore.getState().saveDraftSet(scope, { entryId: entryId!, entryUpdatedAt: current.updatedAt, drafts: [draft, remainingDraft] })).toBe(true);
    await waitForPendingDinnerDiaryWrites();

    const recipe: SavedRecipe = {
      id: 'confirmed-recipe', title: 'Pasta', description: '', ingredients: draft.ingredients, steps: draft.steps,
      servings: null, durationMinutes: null, diets: null, allergens: null, suggestedFields: [], source: 'diary',
      authorId: 'user-1', createdAt: current.createdAt, updatedAt: '2026-09-30T10:01:00.000Z',
    };
    const confirmedEntry: DinnerEntry = {
      ...current, recipes: [{ recipeId: recipe.id, title: recipe.title, source: 'diary' }], updatedAt: recipe.updatedAt,
    };
    expect(useDinnerDiaryStore.getState().acceptConfirmedRecipe(scope, confirmedEntry, recipe, draft.draftId)).toBe(true);
    await waitForPendingDinnerDiaryWrites();

    expect(useDinnerDiaryStore.getState().entries.find((item) => item.value.id === entryId)?.value.recipes).toEqual(confirmedEntry.recipes);
    expect(useDinnerDiaryStore.getState().recipes.find((item) => item.value.id === recipe.id)?.value).toEqual(recipe);
    expect(useDinnerDiaryStore.getState().drafts).toEqual([{ scope, value: { entryId, entryUpdatedAt: recipe.updatedAt, drafts: [remainingDraft] } }]);
    await expect(storage.readDiaryDraftSets(scope)).resolves.toEqual([{ entryId, entryUpdatedAt: recipe.updatedAt, drafts: [remainingDraft] }]);
    await expect(readQueuedMutations(scope)).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', entityId: entryId, operation: 'upsert' })]);
  });

  it('applies a server-linked recipe locally while keeping pending drafts revision-bound', async () => {
    const scope = 'account:user-1';
    const draft: DiaryRecipeDraft = {
      draftId: 'unconfirmed-draft', title: 'Pasta', description: '',
      ingredients: [{ name: 'Pasta', amount: '200 g', ingredientId: null, optional: false, provenance: 'provided' }],
      steps: ['Cuoci la pasta.'], servings: null, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
    };
    useAuthStore.setState({ user: { id: 'user-1' } as never });
    setPersonalDataScope(scope); setActiveDataScope(scope);
    await hydrateDinnerDiaryStore();
    const entryId = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Pasta', servings: null, note: null });
    await waitForPendingDinnerDiaryWrites();
    const original = useDinnerDiaryStore.getState().entries.find(item => item.value.id === entryId)!.value;
    expect(useDinnerDiaryStore.getState().saveDraftSet(scope, { entryId: entryId!, entryUpdatedAt: original.updatedAt, drafts: [draft] })).toBe(true);
    await waitForPendingDinnerDiaryWrites();
    const linkedEntry: DinnerEntry = {
      ...original, recipes: [{ recipeId: 'existing-recipe', title: 'Pasta al pomodoro', source: 'diary' }],
      updatedAt: '2026-09-30T10:01:00.000Z',
    };

    expect(useDinnerDiaryStore.getState().acceptLinkedEntry(scope, linkedEntry, 'existing-recipe', 'diary')).toBe(true);
    await waitForPendingDinnerDiaryWrites();

    expect(useDinnerDiaryStore.getState().entries.find(item => item.value.id === entryId)?.value).toEqual(linkedEntry);
    expect(useDinnerDiaryStore.getState().drafts).toEqual([{ scope, value: { entryId, entryUpdatedAt: linkedEntry.updatedAt, drafts: [draft] } }]);
    await expect(storage.readDiaryDraftSets(scope)).resolves.toEqual([{ entryId, entryUpdatedAt: linkedEntry.updatedAt, drafts: [draft] }]);
    await expect(readQueuedMutations(scope)).resolves.toEqual([expect.objectContaining({ entityType: 'dinner_entry', entityId: entryId, operation: 'upsert' })]);
  });

  it('clears revoked House drafts without deleting personal drafts', async () => {
    const houseDraft = { entryId: 'house-entry', entryUpdatedAt: '2026-09-30T10:00:00.000Z', drafts: [] };
    const personalDraft = { entryId: 'personal-entry', entryUpdatedAt: '2026-09-30T10:00:00.000Z', drafts: [] };
    await storage.writeDiaryDraftSets([houseDraft], 'house:revoked');
    await storage.writeDiaryDraftSets([personalDraft], 'account:user-1');

    await clearDataScope('house:revoked');

    await expect(storage.readDiaryDraftSets('house:revoked')).resolves.toEqual([]);
    await expect(storage.readDiaryDraftSets('account:user-1')).resolves.toEqual([personalDraft]);
  });

  it('keeps in-memory entries on write failure and completes hydration with an error', async () => {
    const failure = new Error('IndexedDB unavailable');
    const writeSpy = vi.spyOn(storage, 'writeDinnerEntries').mockRejectedValueOnce(failure);
    const id = useDinnerDiaryStore.getState().createEntry({ date: '2026-09-30', text: 'Pasta', servings: null, note: null });
    await waitForPendingDinnerDiaryWrites();
    expect(useDinnerDiaryStore.getState().entries.some((item) => item.value.id === id)).toBe(true);
    expect(useDinnerDiaryStore.getState().error).toBe(failure);
    writeSpy.mockRestore();

    const readSpy = vi.spyOn(storage, 'readDinnerEntries').mockRejectedValue(failure);
    useDinnerDiaryStore.setState({ hasHydrated: false });
    await hydrateDinnerDiaryStore();
    expect(useDinnerDiaryStore.getState()).toMatchObject({ hasHydrated: true, error: failure });
    readSpy.mockRestore();
  });
});
