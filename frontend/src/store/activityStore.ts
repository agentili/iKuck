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
  getMutationScope,
  enqueueEntityMutation,
  registerActivitySnapshotListener,
  waitForPendingQueueWrites,
} from '../sync/syncQueue';
import { trackPersistence, trackSync } from './persistenceStatusStore';
import { getPersonalDataScope, subscribePersonalDataScope, type SyncScope } from '../sync/scopeContext';

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
let hydrationGeneration = 0;
let hydratedPersonalScope: SyncScope | null = null;
let pendingEventWrites = Promise.resolve();
let pendingPreferenceWrites = Promise.resolve();

const createEventId = (): string => {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `event:${id}`;
};

const persistEvents = (events: readonly CookEvent[], scope: SyncScope): Promise<void> => {
  const operation = pendingEventWrites.then(() => writeCookEvents(events, scope));
  pendingEventWrites = operation.catch(() => undefined);
  return operation;
};

const persistPreferences = (preferences: readonly RecipePreference[], scope: SyncScope): Promise<void> => {
  const operation = pendingPreferenceWrites.then(() => writeRecipePreferences(preferences, scope));
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
    const personalScope = getPersonalDataScope();
    void trackPersistence('activity', () => persistEvents(events, personalScope));
    void trackSync('activity', () => enqueueEntityMutation(getMutationScope('cook_event', personalScope, personalScope), 'cook_event', event.id, 'upsert', event));
    return event.id;
  },
  removeCookEvent: (id) => {
    const existing = get().events.find((event) => event.id === id);
    if (existing === undefined) return false;
    const events = get().events.filter((event) => event.id !== id);
    set({ events });
    const personalScope = getPersonalDataScope();
    void trackPersistence('activity', () => persistEvents(events, personalScope));
    void trackSync('activity', () => enqueueEntityMutation(getMutationScope('cook_event', personalScope, personalScope), 'cook_event', id, 'delete', null));
    return true;
  },
  restoreCookEvent: (event) => {
    if (get().events.some((existing) => existing.id === event.id)) return false;
    if (validateCookEventDetails(event.recipeId, event.recipeTitle, event.servings, event.cookedAt, event.note).length > 0) return false;
    const events = [...get().events, event];
    set({ events });
    const personalScope = getPersonalDataScope();
    void trackPersistence('activity', () => persistEvents(events, personalScope));
    void trackSync('activity', () => enqueueEntityMutation(getMutationScope('cook_event', personalScope, personalScope), 'cook_event', event.id, 'upsert', event));
    return true;
  },
  clearActivity: () => {
    const events = get().events;
    if (events.length === 0) return 0;
    set({ events: [] });
    const personalScope = getPersonalDataScope();
    void trackPersistence('activity', () => persistEvents([], personalScope));
    for (const event of events) {
      void trackSync('activity', () => enqueueEntityMutation(getMutationScope('cook_event', personalScope, personalScope), 'cook_event', event.id, 'delete', null));
    }
    return events.length;
  },
  getRecipePreference: (recipeId) => get().preferences.find((preference) => preference.recipeId === recipeId),
  setRecipePreference: (recipeId, favorite, rating, note) => {
    const payload: RecipePreferencePayload = { recipeId, favorite, rating, note: normalizeNote(note) };
    if (!preferencePayloadIsValid(payload)) return false;
    const existing = get().getRecipePreference(recipeId);
    if (isEmptyRecipePreference(payload)) {
      const personalScope = getPersonalDataScope();
      if (existing === undefined) return true;
      const preferences = get().preferences.filter((preference) => preference.recipeId !== recipeId);
      set({ preferences });
      void trackPersistence('activity', () => persistPreferences(preferences, personalScope));
      void trackSync('activity', () => enqueueEntityMutation(getMutationScope('recipe_preference', personalScope, personalScope), 'recipe_preference', recipeId, 'delete', null));
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
    const personalScope = getPersonalDataScope();
    void trackPersistence('activity', () => persistPreferences(preferences, personalScope));
    void trackSync('activity', () => enqueueEntityMutation(getMutationScope('recipe_preference', personalScope, personalScope), 'recipe_preference', recipeId, 'upsert', preference));
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

const resetActivityHydration = (): void => {
  hydrationGeneration += 1;
  hydratedPersonalScope = null;
  useActivityStore.setState({ hasHydrated: false, events: [], preferences: [] });
};

subscribePersonalDataScope(resetActivityHydration);

export async function waitForPendingActivityWrites(): Promise<void> {
  await pendingEventWrites;
  await pendingPreferenceWrites;
  await waitForPendingQueueWrites();
}

export async function hydrateActivityStore(): Promise<void> {
  for (;;) {
    const personalScope = getPersonalDataScope();
    const generation = hydrationGeneration;
    if (useActivityStore.getState().hasHydrated && hydratedPersonalScope === personalScope) return;
    if (hydrationPromise === null) {
      const currentPromise = Promise.all([readCookEvents(personalScope), readRecipePreferences(personalScope)])
        .then(([events, preferences]) => {
          if (getPersonalDataScope() !== personalScope || hydrationGeneration !== generation) return;
          hydratedPersonalScope = personalScope;
          useActivityStore.setState({
            events: normalizeCookEvents(events),
            preferences: normalizeRecipePreferences(preferences),
            hasHydrated: true,
          });
        })
        .catch(() => {
          if (getPersonalDataScope() !== personalScope || hydrationGeneration !== generation) return;
          hydratedPersonalScope = personalScope;
          useActivityStore.setState({ events: [], preferences: [], hasHydrated: true });
        })
        .finally(() => {
          hydrationPromise = null;
        });
      hydrationPromise = currentPromise;
    }
    const pendingHydration = hydrationPromise;
    if (pendingHydration !== null) await pendingHydration;
    if (getPersonalDataScope() === personalScope && hydrationGeneration === generation
      && useActivityStore.getState().hasHydrated && hydratedPersonalScope === personalScope) return;
  }
}
