import { create } from 'zustand';
import type { DiaryDraftSet, DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { isDiaryDraftSet, isDinnerEntry, isSavedRecipe } from '@ikuck/shared/dinnerDiary';
import { getActiveDataScope, getPersonalDataScope, subscribeActiveDataScope, subscribePersonalDataScope, type SyncScope } from '../sync/scopeContext';
import { isScopeWritable, ScopeRevokedError, trackScopedWrite } from '../sync/scopeWriteFence';
import { enqueueEntityMutation, registerDinnerDiarySnapshotListener } from '../sync/syncQueue';
import { readDinnerEntries, readDiaryDraftSets, readSavedRecipes, writeDinnerEntries, writeDiaryDraftSets, writeSavedRecipes } from '../storage/dinnerDiaryStorage';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';

export interface Scoped<T> { scope: SyncScope; value: T }
export interface DinnerDiaryState {
  hasHydrated: boolean; entries: Scoped<DinnerEntry>[]; recipes: Scoped<SavedRecipe>[]; drafts: Scoped<DiaryDraftSet>[]; error: unknown | null;
  createEntry: (input: { date: string; text: string; servings: number | null; note: string | null }) => string | null;
  updateEntry: (scope: SyncScope, id: string, changes: Partial<Pick<DinnerEntry, 'date' | 'text' | 'servings' | 'note'>>) => boolean;
  deleteEntry: (scope: SyncScope, id: string) => boolean;
  saveRecipe: (scope: SyncScope, recipe: SavedRecipe) => boolean;
  deleteRecipe: (scope: SyncScope, id: string) => boolean;
  saveDraftSet: (scope: SyncScope, set: DiaryDraftSet) => boolean;
  acceptConfirmedRecipe: (scope: SyncScope, entry: DinnerEntry, recipe: SavedRecipe, confirmedDraftId: string) => boolean;
  acceptLinkedEntry: (scope: SyncScope, entry: DinnerEntry, recipeId: string, source: 'catalog' | 'diary') => boolean;
  clearDraftSet: (scope: SyncScope, entryId: string) => boolean;
  localDate: (date?: Date) => string;
}
const randomId = (): string => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const isoNow = () => new Date().toISOString();
const validContent = (date: string, text: string, servings: number | null, note: string | null) => isDinnerEntry({ id: 'validate', date, text, servings, note, recipes: [], authorId: null, createdAt: isoNow(), updatedAt: isoNow() });
const canEdit = (scope: SyncScope): boolean => {
  if (!isScopeWritable(scope)) return false;
  if (scope === 'guest') return getActiveDataScope() === 'guest';
  const user = useAuthStore.getState().user;
  if (!user || getActiveDataScope() !== scope) return false;
  if (scope.startsWith('account:')) return scope === `account:${user.id}`;
  const house = useHouseStore.getState().state;
  return house?.membership !== null && house?.membership !== undefined
    && scope === `house:${house?.house?.id}`;
};
let generation = 0;
const pendingWrites = new Set<Promise<void>>();
const writeChains = new Map<SyncScope, Promise<void>>();
export const waitForPendingDinnerDiaryWrites = async (): Promise<void> => {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
};
const queueWrite = (scope: SyncScope, action: () => Promise<void>) => {
  const previous = writeChains.get(scope) ?? Promise.resolve();
  // Register before waiting on the store chain: a scope transition must also
  // drain the mutation that is enqueued only after persistence succeeds.
  const pending = trackScopedWrite(scope, async () => {
    await previous;
    if (!isScopeWritable(scope)) throw new ScopeRevokedError();
    await persistLater(scope, action);
  }).catch(error => { useDinnerDiaryStore.setState({ error }); });
  writeChains.set(scope, pending);
  pendingWrites.add(pending);
  void pending.finally(() => {
    pendingWrites.delete(pending);
    if (writeChains.get(scope) === pending) writeChains.delete(scope);
  });
};
const attach = <T>(scope: SyncScope, values: T[]): Scoped<T>[] => values.map(value => ({ scope, value }));
const persistLater = async (scope: SyncScope, action: () => Promise<void>) => { try { await action(); } catch (error) { useDinnerDiaryStore.setState({ error }); } };

export const useDinnerDiaryStore = create<DinnerDiaryState>((set, get) => ({
  hasHydrated: false, entries: [], recipes: [], drafts: [], error: null,
  localDate: (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
  createEntry: ({ date, text, servings, note }) => {
    const scope = getActiveDataScope(); if (!validContent(date, text, servings, note)) { set({ error: new Error('Invalid dinner entry') }); return null; }
    if (scope !== 'guest' && !canEdit(scope)) { set({ error: new Error('Not permitted') }); return null; }
    const now = isoNow(); const entry: DinnerEntry = { id: randomId(), date, text, servings, note, recipes: [], authorId: scope === 'guest' ? null : useAuthStore.getState().user?.id ?? null, createdAt: now, updatedAt: now };
    set(state => ({ entries: [...state.entries.filter(item => !(item.scope === scope && item.value.id === entry.id)), { scope, value: entry }], error: null }));
    const scopedEntries = get().entries.filter(item => item.scope === scope).map(item => item.value);
    queueWrite(scope, async () => { await writeDinnerEntries(scopedEntries, scope); if (scope !== 'guest') await enqueueEntityMutation(scope, 'dinner_entry', entry.id, 'upsert', entry); });
    return entry.id;
  },
  updateEntry: (scope, id, changes) => {
    const item = get().entries.find(value => value.scope === scope && value.value.id === id); if (!item || !canEdit(scope)) return false;
    const entry = { ...item.value, date: changes.date ?? item.value.date, text: changes.text ?? item.value.text, servings: changes.servings === undefined ? item.value.servings : changes.servings, note: changes.note === undefined ? item.value.note : changes.note, id, recipes: item.value.recipes, authorId: item.value.authorId, createdAt: item.value.createdAt, updatedAt: isoNow() };
    if (!validContent(entry.date, entry.text, entry.servings, entry.note)) return false;
    set(state => ({ entries: state.entries.map(value => value === item ? { scope, value: entry } : value), drafts: state.drafts.filter(value => !(value.scope === scope && value.value.entryId === id)), error: null }));
    const scopedEntries = get().entries.filter(v => v.scope === scope).map(v => v.value);
    const scopedDrafts = get().drafts.map(v => v.value);
    const draftScope = getPersonalDataScope();
    queueWrite(scope, async () => { await writeDinnerEntries(scopedEntries, scope); if (scope !== 'guest') await enqueueEntityMutation(scope, 'dinner_entry', id, 'upsert', entry); await writeDiaryDraftSets(scopedDrafts, draftScope); }); return true;
  },
  deleteEntry: (scope, id) => { const item = get().entries.find(v => v.scope === scope && v.value.id === id); if (!item || !canEdit(scope)) return false;
    set(state => ({ entries: state.entries.filter(v => v !== item), drafts: state.drafts.filter(v => !(v.scope === scope && v.value.entryId === id)) }));
    const scopedEntries = get().entries.filter(v => v.scope === scope).map(v => v.value);
    const scopedDrafts = get().drafts.map(v => v.value);
    const draftScope = getPersonalDataScope();
    queueWrite(scope, async () => { await writeDinnerEntries(scopedEntries, scope); await writeDiaryDraftSets(scopedDrafts, draftScope); if (scope !== 'guest') await enqueueEntityMutation(scope, 'dinner_entry', id, 'delete', null); }); return true;
  },
  saveRecipe: (scope, recipe) => { if (!isSavedRecipe(recipe) || !canEdit(scope)) return false; set(state => ({ recipes: [...state.recipes.filter(v => !(v.scope === scope && v.value.id === recipe.id)), { scope, value: recipe }] })); const scopedRecipes = get().recipes.filter(v => v.scope === scope).map(v => v.value); queueWrite(scope, async () => { await writeSavedRecipes(scopedRecipes, scope); if (scope !== 'guest') await enqueueEntityMutation(scope, 'saved_recipe', recipe.id, 'upsert', recipe); }); return true; },
  deleteRecipe: (scope, id) => { const item = get().recipes.find(v => v.scope === scope && v.value.id === id); if (!item || !canEdit(scope)) return false; set(state => ({ recipes: state.recipes.filter(v => v !== item) })); const scopedRecipes = get().recipes.filter(v => v.scope === scope).map(v => v.value); queueWrite(scope, async () => { await writeSavedRecipes(scopedRecipes, scope); if (scope !== 'guest') await enqueueEntityMutation(scope, 'saved_recipe', id, 'delete', null); }); return true; },
  saveDraftSet: (scope, value) => { const entry = get().entries.find(v => v.scope === scope && v.value.id === value.entryId); if (!entry || !canEdit(scope) || !isDiaryDraftSet(value) || value.entryUpdatedAt !== entry.value.updatedAt) return false; set(state => ({ drafts: [...state.drafts.filter(v => !(v.scope === scope && v.value.entryId === value.entryId)), { scope, value }] })); const draftScope = getPersonalDataScope(); const personalDrafts = get().drafts.map(v => v.value); queueWrite(draftScope, () => writeDiaryDraftSets(personalDrafts, draftScope)); return true; },
  acceptConfirmedRecipe: (scope, entry, recipe, confirmedDraftId) => {
    const current = get().entries.find(item => item.scope === scope && item.value.id === entry.id);
    const draftSet = get().drafts.find(item => item.scope === scope && item.value.entryId === entry.id);
    if (!current || !draftSet || draftSet.value.entryUpdatedAt !== current.value.updatedAt
      || !draftSet.value.drafts.some(draft => draft.draftId === confirmedDraftId)
      || !canEdit(scope) || !isDinnerEntry(entry) || !isSavedRecipe(recipe)
      || recipe.source !== 'diary' || entry.id !== current.value.id || entry.text !== current.value.text
      || entry.date !== current.value.date || entry.note !== current.value.note || entry.servings !== current.value.servings
      || !entry.recipes.some(link => link.recipeId === recipe.id && link.source === 'diary')) return false;
    const remainingDrafts = draftSet.value.drafts.filter(draft => draft.draftId !== confirmedDraftId);
    set(state => ({
      entries: state.entries.map(item => item === current ? { scope, value: entry } : item),
      recipes: [...state.recipes.filter(item => !(item.scope === scope && item.value.id === recipe.id)), { scope, value: recipe }],
      drafts: state.drafts.flatMap(item => {
        if (item !== draftSet) return [item];
        return remainingDrafts.length > 0
          ? [{ scope, value: { entryId: entry.id, entryUpdatedAt: entry.updatedAt, drafts: remainingDrafts } }]
          : [];
      }),
      error: null,
    }));
    const scopedEntries = get().entries.filter(item => item.scope === scope).map(item => item.value);
    const scopedRecipes = get().recipes.filter(item => item.scope === scope).map(item => item.value);
    const scopedDrafts = get().drafts.map(item => item.value);
    const draftScope = getPersonalDataScope();
    queueWrite(scope, async () => {
      await writeDinnerEntries(scopedEntries, scope);
      await writeSavedRecipes(scopedRecipes, scope);
      await writeDiaryDraftSets(scopedDrafts, draftScope);
    });
    return true;
  },
  acceptLinkedEntry: (scope, entry, recipeId, source) => {
    const current = get().entries.find(item => item.scope === scope && item.value.id === entry.id);
    if (!current || !canEdit(scope) || !isDinnerEntry(entry)
      || entry.id !== current.value.id || entry.text !== current.value.text || entry.date !== current.value.date
      || entry.note !== current.value.note || entry.servings !== current.value.servings
      || !current.value.recipes.every(oldLink => entry.recipes.some(link => link.recipeId === oldLink.recipeId && link.source === oldLink.source))
      || !entry.recipes.some(link => link.recipeId === recipeId && link.source === source)) return false;
    const existingDrafts = get().drafts.find(item => item.scope === scope && item.value.entryId === entry.id);
    const nextDrafts = existingDrafts?.value.entryUpdatedAt === current.value.updatedAt
      ? { ...existingDrafts.value, entryUpdatedAt: entry.updatedAt }
      : null;
    set(state => ({
      entries: state.entries.map(item => item === current ? { scope, value: entry } : item),
      drafts: state.drafts.flatMap(item => {
        if (!existingDrafts || item !== existingDrafts) return [item];
        return nextDrafts === null ? [] : [{ scope, value: nextDrafts }];
      }),
      error: null,
    }));
    const scopedEntries = get().entries.filter(item => item.scope === scope).map(item => item.value);
    const scopedDrafts = get().drafts.map(item => item.value);
    const draftScope = getPersonalDataScope();
    queueWrite(scope, async () => {
      await writeDinnerEntries(scopedEntries, scope);
      await writeDiaryDraftSets(scopedDrafts, draftScope);
    });
    return true;
  },
  clearDraftSet: (scope, id) => { const found = get().drafts.some(v => v.scope === scope && v.value.entryId === id); if (!found) return false; set(state => ({ drafts: state.drafts.filter(v => !(v.scope === scope && v.value.entryId === id)) })); const draftScope = getPersonalDataScope(); const personalDrafts = get().drafts.map(v => v.value); queueWrite(draftScope, () => writeDiaryDraftSets(personalDrafts, draftScope)); return true; },
}));

export async function hydrateDinnerDiaryStore(): Promise<void> {
  const ticket = ++generation; const scopes = [...new Set([getActiveDataScope(), getPersonalDataScope()])];
  try {
    const snapshots = await Promise.all(scopes.map(async scope => ({ scope, entries: await readDinnerEntries(scope), recipes: await readSavedRecipes(scope), drafts: await readDiaryDraftSets(scope) })));
    if (ticket !== generation || scopes[0] !== getActiveDataScope() || scopes[1] !== getPersonalDataScope() && scopes.length > 1) return;
    const entries = snapshots.flatMap(s => attach(s.scope, s.entries));
    const recipes = snapshots.flatMap(s => attach(s.scope, s.recipes));
    // Drafts are personal local data even when their entry now belongs to a
    // house. Present them alongside the active entry, never from house storage.
    const personalScope = getPersonalDataScope();
    const personalDrafts = snapshots.find(snapshot => snapshot.scope === personalScope)?.drafts ?? [];
    const drafts = personalDrafts.flatMap(value => {
      const entry = entries.find(candidate => candidate.value.id === value.entryId
        && candidate.value.updatedAt === value.entryUpdatedAt);
      return entry === undefined ? [] : [{ scope: entry.scope, value }];
    });
    useDinnerDiaryStore.setState({ entries, recipes, drafts, hasHydrated: true, error: null });
  } catch (error) { if (ticket === generation && scopes[0] === getActiveDataScope() && (scopes.length === 1 || scopes[1] === getPersonalDataScope())) useDinnerDiaryStore.setState({ hasHydrated: true, error }); }
}
const resetForScope = () => { generation++; useDinnerDiaryStore.setState({ hasHydrated: false, entries: [], recipes: [], drafts: [] }); void hydrateDinnerDiaryStore(); };
subscribeActiveDataScope(resetForScope); subscribePersonalDataScope(resetForScope);
registerDinnerDiarySnapshotListener(snapshot => {
  const scope = snapshot.scope; const values = useDinnerDiaryStore.getState();
  const allowedScopes = new Set([getActiveDataScope(), getPersonalDataScope()]);
  if (!allowedScopes.has(scope)) return;
  useDinnerDiaryStore.setState({ entries: [...values.entries.filter(v => v.scope !== scope), ...attach(scope, snapshot.entries)], recipes: [...values.recipes.filter(v => v.scope !== scope), ...attach(scope, snapshot.recipes)], drafts: values.drafts.filter(v => v.scope !== scope || snapshot.entries.some(e => e.id === v.value.entryId && e.updatedAt === v.value.entryUpdatedAt)) });
});
