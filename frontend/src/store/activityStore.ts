import { create } from 'zustand';
import type { CookEvent, RecipePreference, RecipePreferencePayload } from '@ikuck/shared/contracts';
import { isEmptyRecipePreference, validateCookEventDetails, validateRecipePreferenceDetails } from '../domain/activity';
import type { PantryRecipe } from '../domain/types';
import {
  normalizeCookEvents,
  normalizeRecipePreferences,
  readCookEvents,
  readRecipePreferences,
  writeCookEvents,
  writeRecipePreferences,
} from '../storage/activityStorage';
import {
  GUEST_SYNC_SCOPE,
  enqueueEntityMutation,
  registerActivitySnapshotListener,
  waitForPendingQueueWrites,
} from '../sync/syncQueue';
import { trackPersistence, trackSync } from './persistenceStatusStore';

export interface ActivityState {
  hasHydrated: boolean;
  events: CookEvent[];
  preferences: RecipePreference[];
  recordCookEvent: (recipe: PantryRecipe, servings?: number, note?: string | null) => string | null;
  removeCookEvent: (id: string) => boolean;
  restoreCookEvent: (event: CookEvent) => boolean;
  clearActivity: () => number;
  getRecipePreference: (recipeId: string) => RecipePreference | undefined;
  setRecipePreference: (recipeId: string, favorite: boolean, rating: number | null, note: string | null) => boolean;
  removeRecipePreference: (recipeId: string) => boolean;
}

let hydrationPromise: Promise<void> | null = null;
let pendingEventWrites = Promise.resolve();
let pendingPreferenceWrites = Promise.resolve();

const createEventId = (): string => {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `event:${id}`;
};

const persistEvents = (events: readonly CookEvent[]): Promise<void> => {
  const operation = pendingEventWrites.then(() => writeCookEvents(events));
  pendingEventWrites = operation.catch(() => undefined);
  return operation;
};

const persistPreferences = (preferences: readonly RecipePreference[]): Promise<void> => {
  const operation = pendingPreferenceWrites.then(() => writeRecipePreferences(preferences));
  pendingPreferenceWrites = operation.catch(() => undefined);
  return operation;
};

const normalizeNote = (note: string | null): string | null => {
  const normalized = note?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
};

const preferencePayloadIsValid = (payload: RecipePreferencePayload): boolean => (
  validateRecipePreferenceDetails(payload.recipeId, payload.favorite, payload.rating, payload.note).length === 0
);

export const useActivityStore = create<ActivityState>((set, get) => ({
  hasHydrated: false,
  events: [],
  preferences: [],
  recordCookEvent: (recipe, servings = recipe.servings, note = null) => {
    const cookedAt = new Date().toISOString();
    const normalizedNote = normalizeNote(note);
    if (validateCookEventDetails(recipe.id, recipe.title, servings, cookedAt, normalizedNote).length > 0) return null;
    const event: CookEvent = {
      id: createEventId(),
      recipeId: recipe.id,
      recipeTitle: recipe.title,
      servings,
      cookedAt,
      note: normalizedNote,
      createdAt: cookedAt,
      updatedAt: cookedAt,
    };
    const events = [...get().events, event];
    set({ events });
    void trackPersistence('activity', () => persistEvents(events));
    void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'cook_event', event.id, 'upsert', event));
    return event.id;
  },
  removeCookEvent: (id) => {
    const existing = get().events.find((event) => event.id === id);
    if (existing === undefined) return false;
    const events = get().events.filter((event) => event.id !== id);
    set({ events });
    void trackPersistence('activity', () => persistEvents(events));
    void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'cook_event', id, 'delete', null));
    return true;
  },
  restoreCookEvent: (event) => {
    if (get().events.some((existing) => existing.id === event.id)) return false;
    if (validateCookEventDetails(event.recipeId, event.recipeTitle, event.servings, event.cookedAt, event.note).length > 0) return false;
    const events = [...get().events, event];
    set({ events });
    void trackPersistence('activity', () => persistEvents(events));
    void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'cook_event', event.id, 'upsert', event));
    return true;
  },
  clearActivity: () => {
    const events = get().events;
    if (events.length === 0) return 0;
    set({ events: [] });
    void trackPersistence('activity', () => persistEvents([]));
    for (const event of events) {
      void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'cook_event', event.id, 'delete', null));
    }
    return events.length;
  },
  getRecipePreference: (recipeId) => get().preferences.find((preference) => preference.recipeId === recipeId),
  setRecipePreference: (recipeId, favorite, rating, note) => {
    const payload: RecipePreferencePayload = { recipeId, favorite, rating, note: normalizeNote(note) };
    if (!preferencePayloadIsValid(payload)) return false;
    const existing = get().getRecipePreference(recipeId);
    if (isEmptyRecipePreference(payload)) {
      if (existing === undefined) return true;
      const preferences = get().preferences.filter((preference) => preference.recipeId !== recipeId);
      set({ preferences });
      void trackPersistence('activity', () => persistPreferences(preferences));
      void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'recipe_preference', recipeId, 'delete', null));
      return true;
    }
    const now = new Date().toISOString();
    const preference: RecipePreference = {
      ...payload,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const preferences = [...get().preferences.filter((item) => item.recipeId !== recipeId), preference];
    set({ preferences });
    void trackPersistence('activity', () => persistPreferences(preferences));
    void trackSync('activity', () => enqueueEntityMutation(GUEST_SYNC_SCOPE, 'recipe_preference', recipeId, 'upsert', preference));
    return true;
  },
  removeRecipePreference: (recipeId) => get().setRecipePreference(recipeId, false, null, null),
}));

registerActivitySnapshotListener((snapshot) => {
  useActivityStore.setState({
    events: normalizeCookEvents(snapshot.events),
    preferences: normalizeRecipePreferences(snapshot.preferences),
  });
});

export async function waitForPendingActivityWrites(): Promise<void> {
  await pendingEventWrites;
  await pendingPreferenceWrites;
  await waitForPendingQueueWrites();
}

export async function hydrateActivityStore(): Promise<void> {
  if (useActivityStore.getState().hasHydrated) return;
  if (hydrationPromise === null) {
    hydrationPromise = Promise.all([readCookEvents(), readRecipePreferences()])
      .then(([events, preferences]) => useActivityStore.setState({
        events: normalizeCookEvents(events),
        preferences: normalizeRecipePreferences(preferences),
        hasHydrated: true,
      }))
      .catch(() => useActivityStore.setState({ events: [], preferences: [], hasHydrated: true }))
      .finally(() => {
        hydrationPromise = null;
      });
  }
  await hydrationPromise;
}
