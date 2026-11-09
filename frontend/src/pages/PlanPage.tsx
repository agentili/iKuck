import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ShoppingCart } from 'lucide-react';
import type { DietProfile, PlanCommand, PlanState, SyncMutationScope } from '@ikuck/shared/contracts';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { RECIPES } from '../domain/recipes';
import type { PantryRecipe } from '../domain/types';
import { getActiveDataScope, subscribeActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { assertScopeWritable, isScopeWritable, subscribeScopeAvailability } from '../sync/scopeWriteFence';
import { hydrateDietProfileStore, useDietProfileStore } from '../store/dietProfileStore';
import { usePantryStore } from '../store/localPantryStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { getDeviceId } from '../sync/syncQueue';
import { MealPlanUnavailableError, mealPlanApi, type MealPlanApi, type MealPlanRecoveryConflict, type MealPlanRecoveryQuarantine, type MealPlanRecoveryResolution } from '../mealPlan/api';
import {
  formatCivilDateLong,
  getDeviceTimeZone,
  getNextSevenCivilDates,
  isValidIanaTimeZone,
  selectPlanRecipe,
} from '../mealPlan';
import {
  createLocalPlanState,
  readMealPlanOutbox,
  readMealPlanSnapshot,
  saveGuestPlanState,
  saveMealPlanRead,
  saveMealPlanTimeZone,
  isMealPlanBootstrapComplete,
} from '../mealPlan/storage';
import { createPlanCommand, queuePlanCommand, syncPendingMealPlan, synchronizeMealPlanScope } from '../mealPlan/service';
import { useHouseStore } from '../house/houseStore';

interface PlanPageView {
  status: 'loading' | 'ready' | 'blocked' | 'error';
  scope: SyncScope;
  dates: string[];
  states: Record<string, PlanState>;
  overlays: Record<string, PlanState>;
  conflicts: Array<{ id: string; date: string; command: PlanCommand; current: PlanState | null }>;
  recoveryConflicts: MealPlanRecoveryConflict[];
  recoveryQuarantines: MealPlanRecoveryQuarantine[];
  recoveryError: string | null;
  pendingDates: string[];
  timeZone: string | null;
  canEdit: boolean;
  mode: 'guest' | 'shared' | 'offline' | 'unsupported' | 'provisional';
  message: string | null;
}

const initialView = (scope: SyncScope): PlanPageView => ({
  status: 'loading',
  scope,
  dates: [],
  states: {},
  overlays: {},
  conflicts: [],
  recoveryConflicts: [],
  recoveryQuarantines: [],
  recoveryError: null,
  pendingDates: [],
  timeZone: null,
  canEdit: false,
  mode: 'guest',
  message: null,
});

const isNetworkError = (error: unknown): boolean => error instanceof ApiClientError && error.code === 'network_error';
const isVerifiedUser = (user: { emailVerifiedAt: string } | null): user is { emailVerifiedAt: string } => (
  user !== null && user.emailVerifiedAt.trim().length > 0
);

const createPlanContextKey = (
  auth: { user: { id: string; emailVerifiedAt: string } | null; csrfToken: string | null; expiresAt: string | null },
  activeScope: SyncScope,
  scope: SyncScope,
  reload: number,
  profile: DietProfile,
): string => JSON.stringify([
  auth.user?.id ?? null,
  auth.user?.emailVerifiedAt ?? null,
  auth.csrfToken,
  auth.expiresAt,
  activeScope,
  scope,
  reload,
  profile,
]);

const getAvailableRecipe = (
  date: string,
  profile: DietProfile,
  excludedRecipeIds: readonly string[],
): PantryRecipe | undefined => selectPlanRecipe({
  recipes: RECIPES,
  profile,
  date,
  excludedRecipeIds,
});

const toView = async (
  scope: SyncScope,
  dates: readonly string[],
  timeZone: string,
  mode: PlanPageView['mode'],
  canEdit: boolean,
  message: string | null,
  assertCurrent?: () => void,
): Promise<PlanPageView> => {
  assertCurrent?.();
  const snapshotRead = readMealPlanSnapshot(scope).then((snapshot) => {
    assertCurrent?.();
    return snapshot;
  });
  const outboxRead = readMealPlanOutbox([scope], assertCurrent).then((outbox) => {
    assertCurrent?.();
    return outbox;
  });
  const [snapshot, outbox] = await Promise.all([snapshotRead, outboxRead]);
  assertCurrent?.();
  for (const [date, overlay] of Object.entries(snapshot.overlays)) {
    if (!outbox.some((record) => record.command.date === date && record.optimisticState?.revision === overlay.revision)) {
      throw new Error('Il piano contiene una modifica provvisoria senza operazione pendente da riconciliare.');
    }
  }
  const recoveryConflicts: MealPlanRecoveryConflict[] = [];
  const recoveryQuarantines: MealPlanRecoveryQuarantine[] = [];
  let recoveryError: string | null = null;
  let recoveryBlocksEdits = false;
  if (scope.startsWith('house:') && scope !== 'guest') {
    try {
      assertCurrent?.();
      const recovery = await mealPlanApi.readRecovery();
      assertCurrent?.();
      recoveryConflicts.push(...recovery.conflicts);
      recoveryQuarantines.push(...recovery.quarantined);
    } catch (error) {
      assertCurrent?.();
      if (isNetworkError(error)) {
        recoveryError = 'La verifica dei conflitti di migrazione non è raggiungibile. Le modifiche non confermate restano sul dispositivo.';
      } else {
        recoveryError = 'Non è stato possibile verificare i conflitti di migrazione. Il piano resta in sola lettura finché il controllo non riesce.';
        recoveryBlocksEdits = true;
      }
    }
  }
  return {
    status: 'ready',
    scope,
    dates: [...dates],
    states: snapshot.states,
    overlays: snapshot.overlays,
    conflicts: snapshot.conflicts,
    recoveryConflicts,
    recoveryQuarantines,
    recoveryError,
    pendingDates: [...new Set(outbox.map((record) => record.command.date))],
    timeZone,
    canEdit: !recoveryBlocksEdits && canEdit,
    mode,
    message,
  };
};

async function loadGuestPlan(now: Date, profile: DietProfile, assertCurrent: () => void): Promise<PlanPageView> {
  const timeZone = getDeviceTimeZone();
  if (timeZone === null || !isValidIanaTimeZone(timeZone)) throw new Error('Il fuso orario del dispositivo non è disponibile.');
  const dates = getNextSevenCivilDates(now, timeZone);
  assertCurrent();
  const snapshot = await readMealPlanSnapshot('guest');
  assertCurrent();
  const states = { ...snapshot.states };
  const used = dates.flatMap((date) => {
    const state = states[date];
    return state?.recipeId === null || state === undefined ? [] : [state.recipeId];
  });
  for (const date of dates) {
    assertCurrent();
    if (states[date] !== undefined) continue;
    const recipe = getAvailableRecipe(date, profile, used);
    if (recipe === undefined) continue;
    const state = createLocalPlanState(date, 'automatic', recipe.id);
    await saveGuestPlanState(state, {}, assertCurrent);
    assertCurrent();
    states[date] = state;
    used.push(recipe.id);
  }
  const view = await toView('guest', dates, timeZone, 'guest', true, null, assertCurrent);
  assertCurrent();
  return view;
}

async function readHouseZone(
  scope: SyncScope,
  csrfToken: string,
  api: MealPlanApi,
  assertCurrent: () => void,
): Promise<{ timeZone: string; confirmed: boolean }> {
  const deviceTimeZone = getDeviceTimeZone();
  if (deviceTimeZone === null) throw new Error('Il fuso del dispositivo non è valido: verifica le impostazioni del browser.');
  if (!scope.startsWith('house:')) return { timeZone: deviceTimeZone, confirmed: true };

  assertCurrent();
  let state = await api.getHouseTimeZone();
  assertCurrent();
  if (state.timeZone === null && state.revision === null) {
    state = await api.initializeHouseTimeZone(deviceTimeZone, csrfToken);
    assertCurrent();
  }
  await saveMealPlanTimeZone(scope, state, assertCurrent);
  assertCurrent();
  return { timeZone: state.timeZone ?? deviceTimeZone, confirmed: state.timeZone !== null };
}

async function loadSharedPlan(input: {
  scope: SyncScope;
  csrfToken: string;
  now: Date;
  profile: DietProfile;
  api: MealPlanApi;
  assertCurrent: () => void;
}): Promise<PlanPageView> {
  const { scope, csrfToken, now, profile, api, assertCurrent } = input;
  if (scope === 'guest') throw new Error('L’ambito del piano non è pronto.');
  assertCurrent();
  assertScopeWritable(scope);
  const scopeId = scope as SyncMutationScope;
  let cached = await readMealPlanSnapshot(scope);
  assertCurrent();
  const deviceTimeZone = getDeviceTimeZone();
  if (deviceTimeZone === null) throw new Error('Il fuso del dispositivo non è valido: verifica le impostazioni del browser.');

  let capabilityReady = false;
  try {
    cached = await synchronizeMealPlanScope({ scope, csrfToken, api, assertCurrent });
    assertCurrent();
    capabilityReady = cached.capability !== null && isMealPlanBootstrapComplete(cached, cached.capability);
  } catch (error) {
    assertCurrent();
    if (error instanceof MealPlanUnavailableError) {
      const zone = scope.startsWith('house:') ? cached.timeZone?.timeZone ?? deviceTimeZone : deviceTimeZone;
      const view = await toView(scope, getNextSevenCivilDates(now, zone), zone, 'unsupported', false,
        'Questo server non supporta ancora il piano condiviso. La copia locale, se presente, non è aggiornata né condivisa.', assertCurrent);
      return view;
    }
    if (!isNetworkError(error)) throw error;
    const cachedZone = scope.startsWith('house:') ? cached.timeZone : null;
    const zone = cachedZone?.timeZone ?? deviceTimeZone;
    if (!isValidIanaTimeZone(zone)) throw new Error('Il fuso salvato non è valido; riconnettiti per aggiornare il piano.');
    const timeZoneConfirmed = !scope.startsWith('house:') || cachedZone?.timeZone !== null && cachedZone !== null;
    const hasCachedBootstrap = cached.capability !== null && isMealPlanBootstrapComplete(cached, cached.capability);
    if (!hasCachedBootstrap) {
      return toView(scope, getNextSevenCivilDates(now, zone), zone, 'provisional', false,
        'Connessione assente: il bootstrap storico del piano non è completo; i dati condivisi non vengono letti o modificati.', assertCurrent);
    }
    const canEditOffline = timeZoneConfirmed;
    const mode = timeZoneConfirmed ? 'offline' : 'provisional';
    const message = timeZoneConfirmed
      ? 'Connessione assente: la copia salvata può essere provvisoria. Le nuove scelte restano sul dispositivo finché non vengono confermate dal server.'
      : 'Connessione assente e fuso della Casa non memorizzato: il calendario usa provvisoriamente il fuso del dispositivo. Il piano condiviso non viene letto o modificato.';
    return toView(scope, getNextSevenCivilDates(now, zone), zone, mode, canEditOffline, message, assertCurrent);
  }

  if (!capabilityReady) throw new MealPlanUnavailableError();
  let zoneState: { timeZone: string; confirmed: boolean };
  try {
    zoneState = await readHouseZone(scope, csrfToken, api, assertCurrent);
  } catch (error) {
    assertCurrent();
    if (!isNetworkError(error) || cached.capability === null || !isMealPlanBootstrapComplete(cached, cached.capability)) throw error;
    const zone = scope.startsWith('house:') ? cached.timeZone?.timeZone ?? deviceTimeZone : deviceTimeZone;
    const confirmed = !scope.startsWith('house:') || cached.timeZone?.timeZone !== null && cached.timeZone !== null;
  return toView(scope, getNextSevenCivilDates(now, zone), zone, 'offline', confirmed,
      'Il fuso condiviso non è raggiungibile: vengono mostrate le date salvate, non una finestra confermata.', assertCurrent);
  }
  const dates = getNextSevenCivilDates(now, zoneState.timeZone);
  if (scope.startsWith('house:') && !zoneState.confirmed) {
    return toView(scope, dates, zoneState.timeZone, 'provisional', false,
      'Il fuso della Casa non è impostato. Le date mostrate usano il fuso del dispositivo e il piano condiviso non viene letto o modificato.', assertCurrent);
  }
  let serverStates: Array<{ date: string; state: PlanState | null }>;
  try {
    assertCurrent();
    serverStates = await api.readStates(scopeId, dates, csrfToken);
    assertCurrent();
    const persistedTimeZone = scope.startsWith('house:')
      ? (await readMealPlanSnapshot(scope)).timeZone ?? undefined
      : undefined;
    assertCurrent();
    await saveMealPlanRead(scope, dates, serverStates, persistedTimeZone, assertCurrent);
    assertCurrent();
  } catch (error) {
    assertCurrent();
    if (!isNetworkError(error) || cached.capability === null || !isMealPlanBootstrapComplete(cached, cached.capability)) throw error;
    return toView(scope, dates, zoneState.timeZone, 'offline', zoneState.confirmed,
      'Connessione assente: viene mostrata la copia salvata, non una conferma aggiornata dal server.', assertCurrent);
  }

  let syncMessage: string | null = null;
  let syncAvailable = true;
  try {
    await syncPendingMealPlan(scope, csrfToken, api, assertCurrent);
  } catch (error) {
    assertCurrent();
    if (error instanceof MealPlanUnavailableError) {
      syncAvailable = false;
      syncMessage = 'Il server non supporta più il piano condiviso. Le modifiche in attesa sono conservate sul dispositivo.';
    } else if (isNetworkError(error)) {
      syncMessage = 'Connessione assente: le modifiche in attesa non sono ancora condivise.';
    } else {
      syncMessage = 'Una modifica non è stata confermata. È conservata sul dispositivo e verrà riprovata.';
    }
  }

  let view = await toView(scope, dates, zoneState.timeZone, syncMessage === null ? 'shared' : 'offline',
    syncAvailable && zoneState.confirmed, syncMessage, assertCurrent);
  assertCurrent();
  if (zoneState.confirmed && syncAvailable) {
    const pendingDates = new Set(view.pendingDates);
    const used = dates.flatMap((date) => {
      const state = view.overlays[date] ?? view.states[date];
      return state?.recipeId === null || state === undefined ? [] : [state.recipeId];
    });
    let deviceId: string | null = null;
    let generated = 0;
    for (const date of dates) {
      assertCurrent();
      if (view.states[date] !== undefined || pendingDates.has(date)) continue;
      const recipe = getAvailableRecipe(date, profile, used);
      if (recipe === undefined) continue;
      deviceId ??= await getDeviceId();
      assertCurrent();
      const command = createPlanCommand({
        scope: scopeId,
        date,
        action: 'auto_create',
        deviceId,
        recipeId: recipe.id,
        baseRevision: null,
      });
      const optimisticState = createLocalPlanState(date, 'automatic', recipe.id);
      await queuePlanCommand(scope, command, optimisticState, { assertCurrent });
      assertCurrent();
      used.push(recipe.id);
      pendingDates.add(date);
      generated += 1;
    }
    if (generated > 0) {
      try {
        await syncPendingMealPlan(scope, csrfToken, api, assertCurrent);
      } catch (error) {
        assertCurrent();
        syncMessage = error instanceof MealPlanUnavailableError
          ? 'Il server non supporta più il piano condiviso. Le proposte sono conservate sul dispositivo.'
          : isNetworkError(error)
            ? 'Connessione assente: le proposte restano sul dispositivo finché il server non le conferma.'
            : 'Le proposte non sono ancora state confermate dal server.';
      }
      view = await toView(scope, dates, zoneState.timeZone, syncMessage === null ? 'shared' : 'offline',
        syncAvailable && syncMessage === null && zoneState.confirmed, syncMessage, assertCurrent);
      assertCurrent();
    }
  } else if (syncAvailable) {
    view = {
      ...view,
      mode: 'provisional',
      canEdit: false,
      message: 'Il fuso della Casa non è impostato. Le date mostrate usano il fuso del dispositivo e non sono modificabili come piano condiviso.',
    };
  }
  assertCurrent();
  return view;
}

export default function PlanPage() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const expiresAt = useAuthStore((state) => state.expiresAt);
  const profileState = useDietProfileStore((state) => state.profile);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const pantryHasHydrated = usePantryStore((state) => state.hasHydrated);
  const shoppingItems = useShoppingListStore((state) => state.items);
  const shoppingHasHydrated = useShoppingListStore((state) => state.hasHydrated);
  const houseState = useHouseStore((state) => state.state);
  const activeScope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const [view, setView] = useState<PlanPageView>(() => initialView('guest'));
  const [viewContextKey, setViewContextKey] = useState('');
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackContextKey, setFeedbackContextKey] = useState('');
  const [reload, setReload] = useState(0);
  const [timeZoneDraft, setTimeZoneDraft] = useState('');
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const refresh = (): void => setReload((current) => current + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) refresh();
    }, 60_000);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const verified = isVerifiedUser(user) && csrfToken !== null;
  const scope: SyncScope = verified ? activeScope : 'guest';
  const api = mealPlanApi;
  const contextKey = createPlanContextKey({ user, csrfToken, expiresAt }, activeScope, scope, reload, profileState);
  const scopeWritable = useSyncExternalStore(
    subscribeScopeAvailability,
    () => isScopeWritable(scope),
    () => isScopeWritable(scope),
  );
  const contextToken = `${contextKey}:${generation.current}`;
  const currentView = scopeWritable && view.scope === scope && viewContextKey === contextToken ? view : initialView(scope);
  const currentFeedback = feedbackContextKey === contextToken ? feedback : null;
  const publishView = (nextView: PlanPageView): void => {
    setView(nextView);
    setViewContextKey(contextToken);
  };
  const publishFeedback = (message: string | null): void => {
    setFeedback(message);
    setFeedbackContextKey(contextToken);
  };
  const captureActionFence = (actionScope: SyncScope) => {
    const capturedAuth = useAuthStore.getState();
    const capturedUserId = capturedAuth.user?.id ?? null;
    const capturedCsrfToken = capturedAuth.csrfToken;
    const capturedActiveScope = getActiveDataScope();
    const capturedGeneration = generation.current;
    const capturedContextKey = contextKey;
    const capturedContextToken = contextToken;
    const expectedScope = isVerifiedUser(capturedAuth.user) && capturedCsrfToken !== null
      ? capturedActiveScope : 'guest';
    const isCurrent = (): boolean => {
      const currentAuth = useAuthStore.getState();
      const currentActiveScope = getActiveDataScope();
      const currentScope = isVerifiedUser(currentAuth.user) && currentAuth.csrfToken !== null
        ? currentActiveScope : 'guest';
      const currentContextKey = createPlanContextKey(
        currentAuth, currentActiveScope, currentScope, reload, useDietProfileStore.getState().profile,
      );
      return generation.current === capturedGeneration
        && currentContextKey === capturedContextKey
        && viewContextKey === capturedContextToken
        && actionScope === scope
        && (currentAuth.user?.id ?? null) === capturedUserId
        && currentAuth.csrfToken === capturedCsrfToken
        && currentActiveScope === capturedActiveScope
        && currentScope === actionScope
        && expectedScope === actionScope
        && isScopeWritable(actionScope);
    };
    return {
      csrfToken: capturedCsrfToken,
      isCurrent,
      assertCurrent: (): void => {
        if (!isCurrent()) throw new Error('La sessione o la Casa è cambiata durante l’azione del piano.');
      },
    };
  };

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const effectContextToken = `${contextKey}:${currentGeneration}`;
    let cancelled = false;
    const session = user === null || csrfToken === null ? null : { userId: user.id, csrfToken };
    const sessionUserId = user?.id ?? null;
    const isCurrent = (): boolean => {
      const currentAuth = useAuthStore.getState();
      const currentActiveScope = getActiveDataScope();
      const currentScope = isVerifiedUser(currentAuth.user) && currentAuth.csrfToken !== null
        ? currentActiveScope : 'guest';
      const currentContextKey = createPlanContextKey(
        currentAuth, currentActiveScope, currentScope, reload, useDietProfileStore.getState().profile,
      );
      return !cancelled && generation.current === currentGeneration
        && currentContextKey === contextKey
        && (currentAuth.user?.id ?? null) === sessionUserId
        && currentAuth.csrfToken === csrfToken
        && currentActiveScope === activeScope
        && currentScope === scope
        && isScopeWritable(scope);
    };
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new Error('La sessione o la Casa è cambiata durante il caricamento del piano.');
    };

    setViewContextKey(effectContextToken);
    setView(initialView(scope));
    setFeedbackContextKey(effectContextToken);
    setFeedback(null);
    setBusyDate(null);
    setSavingTimeZone(false);
    if (user !== null && (!verified || scope === 'guest')) {
      return () => { cancelled = true; };
    }

    void (async () => {
      try {
        await hydrateDietProfileStore();
        assertCurrent();
        const profile = useDietProfileStore.getState().profile;
        const loaded = session === null
          ? await loadGuestPlan(new Date(), profile, assertCurrent)
          : await loadSharedPlan({ scope, csrfToken: session.csrfToken, now: new Date(), profile, api, assertCurrent });
        assertCurrent();
        setView(loaded);
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : 'Il piano non è stato caricato.';
        setView({ ...initialView(scope), status: 'error', message });
      }
    })();
    return () => { cancelled = true; };
  }, [activeScope, api, contextKey, csrfToken, profileState, reload, scope, user, verified]);

  const rows = useMemo(() => currentView.dates.map((date) => ({
      date,
      label: formatCivilDateLong(date),
      state: currentView.overlays[date] ?? currentView.states[date] ?? null,
      pending: currentView.pendingDates.includes(date),
    })), [currentView]);

  const missingIngredients = useMemo(() => {
    if (currentView.status !== 'ready' || !pantryHasHydrated || !shoppingHasHydrated) return [];
    const availableIds = new Set([
      ...pantryItems.filter((item) => item.known).map((item) => item.id),
      ...stapleIds,
    ]);
    const listedIds = new Set(shoppingItems.map((item) => item.ingredientId));
    const result: Array<{
      ingredientId: string;
      label: string;
      recipeId: string;
      recipeTitle: string;
      alreadyListed: boolean;
    }> = [];
    for (const row of rows) {
      const state = row.state;
      if (state === null || state.recipeId === null) continue;
      const recipe = RECIPES.find((candidate) => candidate.id === state.recipeId);
      if (!recipe) continue;
      for (const ingredient of recipe.ingredients) {
        if (ingredient.optional || availableIds.has(ingredient.ingredientId)) continue;
        result.push({
          ingredientId: ingredient.ingredientId,
          label: ingredient.name ?? ingredient.ingredientId,
          recipeId: recipe.id,
          recipeTitle: recipe.title,
          alreadyListed: listedIds.has(ingredient.ingredientId),
        });
      }
    }
    return result;
  }, [
    rows,
    currentView.status,
    pantryHasHydrated,
    shoppingHasHydrated,
    pantryItems,
    stapleIds,
    shoppingItems,
  ]);

  const localCopy = currentView.mode === 'guest';

  const shareStatus = currentView.mode === 'guest'
    ? 'Salvato su questo dispositivo · non condiviso'
    : currentView.mode === 'unsupported'
      ? 'Condivisione non disponibile'
      : currentView.mode === 'offline'
        ? 'In attesa di conferma · non ancora condiviso'
        : currentView.mode === 'provisional'
          ? 'Fuso provvisorio · piano condiviso non modificabile'
          : currentView.scope.startsWith('house:') ? 'Condiviso con la Casa' : 'Sincronizzato con il tuo account';

  useLayoutEffect(() => setTimeZoneDraft(currentView.timeZone ?? ''), [currentView.timeZone]);

  const chooseReplacement = async (date: string, currentState: PlanState | null): Promise<void> => {
    const fence = captureActionFence(view.scope);
    if (!fence.isCurrent() || busyDate !== null) return;
    const recipeIdsInOtherDays = rows.filter((row) => row.date !== date)
      .map((row) => row.state?.recipeId).filter((recipeId): recipeId is string => recipeId !== undefined && recipeId !== null);
    const excluded = [...recipeIdsInOtherDays, ...(currentState?.recipeId === null || currentState === null ? [] : [currentState.recipeId])];
    const recipe = selectPlanRecipe({ recipes: RECIPES, profile: profileState, date, excludedRecipeIds: excluded });
    if (recipe === undefined || recipe.id === currentState?.recipeId) {
      publishFeedback('Non ci sono altre ricette compatibili da proporre per questo giorno.');
      return;
    }
    setBusyDate(date);
    publishFeedback(null);
    try {
      if (localCopy) {
        const state = createLocalPlanState(date, 'manual', recipe.id);
        await saveGuestPlanState(state, {}, fence.assertCurrent);
        fence.assertCurrent();
        const nextView = await toView('guest', view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'guest', true, null, fence.assertCurrent);
        fence.assertCurrent();
        publishView(nextView);
      } else {
        if (!view.canEdit || view.scope === 'guest') throw new Error('Il piano condiviso non è disponibile per le modifiche in questo momento.');
        fence.assertCurrent();
        const deviceId = await getDeviceId();
        fence.assertCurrent();
        const command = createPlanCommand({
          scope: view.scope as SyncMutationScope,
          date,
          action: 'manual_set',
          deviceId,
          recipeId: recipe.id,
        });
        const optimisticState = createLocalPlanState(date, 'manual', recipe.id);
        await queuePlanCommand(view.scope, command, optimisticState, { assertCurrent: fence.assertCurrent });
        fence.assertCurrent();
        const optimistic = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'offline', true,
          'Modifica salvata sul dispositivo; non è condivisa finché il server non la conferma.', fence.assertCurrent);
        fence.assertCurrent();
        publishView(optimistic);
        try {
          await syncPendingMealPlan(view.scope, fence.csrfToken ?? '', api, fence.assertCurrent);
          fence.assertCurrent();
          const confirmed = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'shared', true, null, fence.assertCurrent);
          fence.assertCurrent();
          publishView(confirmed);
          if (confirmed.conflicts.some((conflict) => conflict.id === command.operationId)) {
            publishFeedback('La modifica è in conflitto con una scelta più recente; la copia locale è conservata.');
          }
        } catch (error) {
          if (!fence.isCurrent()) return;
          const pending = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'offline',
            !(error instanceof MealPlanUnavailableError), error instanceof MealPlanUnavailableError
              ? 'Il server non supporta più il piano condiviso. La modifica resta conservata sul dispositivo.'
              : 'La modifica resta sul dispositivo e non è ancora condivisa.', fence.assertCurrent);
          fence.assertCurrent();
          publishView(pending);
        }
      }
    } catch (error) {
      if (fence.isCurrent()) publishFeedback(error instanceof Error ? error.message : 'La scelta non è stata salvata.');
    } finally {
      if (fence.isCurrent()) setBusyDate(null);
    }
  };

  const retryConflict = async (conflictId: string): Promise<void> => {
    const fence = captureActionFence(view.scope);
    if (!fence.isCurrent()) return;
    const conflict = view.conflicts.find((item) => item.id === conflictId);
    if (conflict === undefined || conflict.command.action !== 'manual_set' || view.scope === 'guest' || !view.canEdit) return;
    const recipeId = conflict.command.recipeId;
    const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
    if (recipe === undefined) {
      publishFeedback('La ricetta in conflitto non è più disponibile nel catalogo; la copia resta conservata.');
      return;
    }
    setBusyDate(conflict.date);
    publishFeedback(null);
    try {
      fence.assertCurrent();
      const pendingResolution = (await readMealPlanOutbox([view.scope], fence.assertCurrent))
        .find((record) => record.resolvesConflictId === conflict.id);
      fence.assertCurrent();
      if (pendingResolution !== undefined) {
        if (pendingResolution.command.action !== 'manual_set'
          || pendingResolution.command.date !== conflict.date
          || pendingResolution.command.recipeId !== recipeId) {
          throw new Error('La scelta di riproposizione esistente non corrisponde al conflitto; la copia resta conservata.');
        }
      } else {
        const deviceId = await getDeviceId();
        fence.assertCurrent();
        const command = createPlanCommand({
          scope: view.scope as SyncMutationScope,
          date: conflict.date,
          action: 'manual_set',
          deviceId,
          recipeId,
        });
        const optimisticState = createLocalPlanState(conflict.date, 'manual', recipeId);
        await queuePlanCommand(view.scope, command, optimisticState, {
          assertCurrent: fence.assertCurrent,
          resolvesConflictId: conflict.id,
        });
        fence.assertCurrent();
      }
      await syncPendingMealPlan(view.scope, fence.csrfToken ?? '', api, fence.assertCurrent);
      fence.assertCurrent();
      const confirmed = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'shared', true, null, fence.assertCurrent);
      fence.assertCurrent();
      publishView(confirmed);
    } catch {
      if (!fence.isCurrent()) return;
      publishFeedback('La scelta resta conservata sul dispositivo e non è stata confermata dal server.');
      const pending = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'offline', true,
        'In attesa di conferma · la copia locale non è ancora condivisa.', fence.assertCurrent);
      if (fence.isCurrent()) publishView(pending);
    } finally {
      if (fence.isCurrent()) setBusyDate(null);
    }
  };

  const resolveRecoveryConflict = async (
    conflictId: string,
    recipeId: string | null,
    originalCommand: PlanCommand,
    expectedSourceRevision: string,
    expectedTargetRevision: string,
  ): Promise<void> => {
    const fence = captureActionFence(view.scope);
    if (!fence.isCurrent() || fence.csrfToken === null || recipeId === null) return;
    const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
    if (recipe === undefined) {
      publishFeedback('La ricetta non è più disponibile nel catalogo.');
      return;
    }
    const deviceId = await getDeviceId();
    fence.assertCurrent();
    const resolutionCommand = createPlanCommand({
      scope: view.scope as SyncMutationScope,
      date: originalCommand.date,
      action: originalCommand.action,
      deviceId,
      recipeId,
    });
    const resolution: MealPlanRecoveryResolution = {
      expectedSourceRevision,
      expectedTargetRevision,
      command: resolutionCommand,
    };
    setBusyDate(originalCommand.date);
    publishFeedback(null);
    try {
      await mealPlanApi.resolveRecovery(conflictId, resolution, fence.csrfToken);
      fence.assertCurrent();
      const confirmed = await toView(view.scope, view.dates, view.timeZone ?? getDeviceTimeZone() ?? 'UTC', 'shared', true, null, fence.assertCurrent);
      fence.assertCurrent();
      publishView(confirmed);
      publishFeedback('Conflitto risolto: la scelta è stata confermata.');
    } catch (error) {
      if (!fence.isCurrent()) return;
      publishFeedback(error instanceof Error ? error.message : 'La risoluzione non è stata confermata.');
    } finally {
      if (fence.isCurrent()) setBusyDate(null);
    }
  };

  const changeHouseTimeZone = async (): Promise<void> => {
    const fence = captureActionFence(view.scope);
    if (!fence.isCurrent()) return;
    const nextTimeZone = timeZoneDraft.trim();
    if (!isValidIanaTimeZone(nextTimeZone)) {
      publishFeedback('Inserisci un fuso IANA valido, per esempio Europe/Rome.');
      return;
    }
    if (fence.csrfToken === null || !view.scope.startsWith('house:')) return;
    setSavingTimeZone(true);
    publishFeedback(null);
    try {
      fence.assertCurrent();
      const current = await api.getHouseTimeZone();
      fence.assertCurrent();
      const updated = await api.updateHouseTimeZone(nextTimeZone, current.revision, fence.csrfToken);
      fence.assertCurrent();
      await saveMealPlanTimeZone(view.scope, updated, fence.assertCurrent);
      fence.assertCurrent();
      setReload((value) => value + 1);
    } catch {
      if (fence.isCurrent()) publishFeedback('Il fuso non è stato aggiornato. Ricarica il piano e riprova.');
    } finally {
      if (fence.isCurrent()) setSavingTimeZone(false);
    }
  };

  const addMissingToShoppingList = (): void => {
    const fence = captureActionFence(currentView.scope);
    if (!fence.isCurrent() || !pantryHasHydrated || !shoppingHasHydrated) return;
    const availableIds = new Set([
      ...usePantryStore.getState().getAvailableIngredientIds(),
      ...useShoppingListStore.getState().items.map((item) => item.ingredientId),
    ]);
    const recipeIds = new Set(rows.flatMap((row) => (
      row.state?.recipeId === null || row.state === null ? [] : [row.state.recipeId]
    )));
    let totalAdded = 0;
    for (const recipeId of recipeIds) {
      if (!fence.isCurrent()) return;
      const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
      if (recipe === undefined) continue;
      totalAdded += useShoppingListStore.getState().addMissingRecipeIngredients(recipe, [...availableIds]);
    }
    if (!fence.isCurrent()) return;
    publishFeedback(totalAdded > 0
      ? `${totalAdded} ingredienti aggiunti alla lista della spesa.`
      : 'Nessun nuovo ingrediente da aggiungere (già presenti in dispensa o nella lista).');
  };

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 pb-8 pt-5 text-[var(--ik-ink)] sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold">Una ricetta al giorno</p>
        <h1 className="mt-1 text-[clamp(2rem,4.8vw,3rem)] font-black leading-[1.04] tracking-[-0.03em] text-[var(--ik-ink)]">Piano settimanale</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--ik-ink-muted)]">Organizza i prossimi sette giorni e cambia le ricette quando vuoi.</p>
      </header>

      <section aria-label="Stato della condivisione" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4">
        <p role="status" className="inline-flex min-h-9 items-center rounded-full bg-[var(--ik-mist)] px-3 py-1 text-sm font-semibold text-[var(--ik-ink)]">{currentView.status === 'loading' ? 'Caricamento del piano…' : shareStatus}</p>
        {currentView.timeZone !== null && <p className="text-sm font-medium text-[var(--ik-ink-muted)]">Fuso: {currentView.timeZone}</p>}
      </section>

      {currentView.status === 'ready' && currentView.scope.startsWith('house:') && houseState?.membership?.role === 'admin' && currentView.canEdit && (
        <form className="mb-4 flex flex-wrap items-end gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4" onSubmit={(event) => { event.preventDefault(); void changeHouseTimeZone(); }}>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
            Fuso orario della Casa
            <input
              type="text"
              name="house-time-zone"
              autoComplete="off"
              value={timeZoneDraft}
              onChange={(event) => setTimeZoneDraft(event.currentTarget.value)}
              className="ik-input min-h-11 w-full border-2 px-3 py-2 sm:w-56"
              aria-describedby="house-time-zone-help"
            />
          </label>
          <p id="house-time-zone-help" className="sr-only">Usa un identificativo IANA, per esempio Europe/Rome.</p>
          <button type="submit" disabled={savingTimeZone || !scopeWritable} className="min-h-11 rounded-xl border-2 border-[var(--ik-basil)] bg-[var(--ik-surface)] px-4 py-2 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)] disabled:opacity-60">
            {savingTimeZone ? 'Aggiornamento…' : 'Aggiorna fuso'}
          </button>
        </form>
      )}

      {currentView.message !== null && <p role="status" className="mb-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] px-4 py-3 text-sm text-[var(--ik-warn-ink)]">{currentView.message}</p>}
      {currentView.status === 'ready' && currentView.recoveryError !== null && <p role="alert" className="mb-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-sm text-[var(--ik-tomato)]">{currentView.recoveryError}</p>}
      {currentFeedback !== null && <p role="alert" className="mb-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] px-4 py-3 text-sm font-semibold text-[var(--ik-warn-ink)]">{currentFeedback}</p>}
      {currentView.status === 'loading' && <p role="status" className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] px-4 py-5 text-[var(--ik-ink-muted)]">Caricamento del piano…</p>}
      {currentView.status === 'error' && <p role="alert" className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-4 text-[var(--ik-tomato)]">{currentView.message ?? 'Il piano non è stato caricato.'}</p>}
      {currentView.status === 'blocked' && <p role="status" className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-4 text-[var(--ik-ink-muted)]">Il piano condiviso non è disponibile.</p>}

      {currentView.status === 'ready' && (
        <ol aria-label="Pasti da domani" className="grid gap-3">
          {rows.map(({ date, label, state, pending }) => {
            const recipe = state?.recipeId === null || state === null ? undefined : RECIPES.find((candidate) => candidate.id === state.recipeId);
            const rowPending = pending || currentView.mode === 'offline' && state !== null && currentView.overlays[date] !== undefined;
            return (
              <li key={date} className="grid gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:grid-cols-[minmax(10rem,0.85fr)_minmax(0,1.7fr)_auto] sm:items-center sm:gap-x-4 sm:p-5" data-date={date}>
                <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-3">
                  <time dateTime={date} className="text-sm font-bold capitalize text-[var(--ik-basil-dark)]">{label}</time>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                    {state?.kind === 'automatic' && <span className="rounded-full bg-[var(--ik-mist)] px-2.5 py-1 text-[var(--ik-ink-muted)]">Proposta automatica</span>}
                    {state?.kind === 'manual' && <span className="rounded-full bg-[var(--ik-sage)] px-2.5 py-1 text-[var(--ik-basil-dark)]">Scelta manuale</span>}
                    {state?.kind === 'deleted' && <span className="rounded-full bg-[var(--ik-yolk-soft)] px-2.5 py-1 text-[var(--ik-warn-ink)]">Pasto rimosso</span>}
                    {rowPending && <span className="rounded-full bg-[var(--ik-yolk-soft)] px-2.5 py-1 text-[var(--ik-warn-ink)]">In attesa di conferma · non condivisa</span>}
                  </div>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  {recipe !== undefined ? <p className="text-lg font-bold leading-snug text-[var(--ik-ink)]">{recipe.title}</p>
                    : state?.kind === 'deleted' ? <p className="font-semibold text-[var(--ik-ink)]">Pasto rimosso</p>
                      : state !== null ? <p className="font-semibold text-[var(--ik-ink)]">Ricetta non più disponibile nel catalogo</p>
                        : <p className="text-[var(--ik-ink-muted)]">Nessuna ricetta compatibile al momento</p>}
                  {recipe?.durationMinutes !== null && recipe?.durationMinutes !== undefined
                    && <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">{recipe.durationMinutes} minuti</p>}
                </div>
                {state !== null && currentView.canEdit && (
                  <button
                    type="button"
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border-2 border-[var(--ik-basil)] bg-[var(--ik-surface)] px-3 py-2 text-sm font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)] disabled:opacity-60 sm:col-start-3 sm:row-start-2 sm:w-auto"
                    aria-label={`Cambia ricetta per ${label}`}
                    disabled={busyDate !== null || !scopeWritable}
                    onClick={() => void chooseReplacement(date, state)}
                  >
                    {busyDate === date ? 'Salvataggio…' : 'Cambia ricetta'}
                  </button>
                )}
              </li>
            );
          })}
                  </ol>
                )}

                {currentView.status === 'ready' && missingIngredients.length > 0 && (
                  <section aria-label="Ingredienti mancanti per il piano" className="mt-5 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5">
                    <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="inline-flex items-center gap-2 text-xs font-bold text-[var(--ik-basil-dark)]">
                          <ShoppingCart size={14} aria-hidden="true" /> Spesa
                        </p>
                        <h2 className="mt-1 text-xl font-black text-[var(--ik-ink)]">Ingredienti mancanti per il piano</h2>
                        <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">{missingIngredients.length} ingredienti non presenti in dispensa</p>
                      </div>
                      <button
                        type="button"
                        onClick={addMissingToShoppingList}
                        disabled={missingIngredients.length === 0 || !pantryHasHydrated || !shoppingHasHydrated}
                        className="ik-button-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 font-bold disabled:opacity-60"
                      >
                        <Plus size={18} aria-hidden="true" /> Aggiungi alla lista
                      </button>
                    </header>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {missingIngredients.map((ingredient, index) => (
                        <li key={`${ingredient.ingredientId}-${index}`} className="flex flex-wrap items-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3">
                          <p className="font-semibold text-[var(--ik-ink)]">{ingredient.label}</p>
                          <p className="text-sm text-[var(--ik-ink-muted)]">Per: {ingredient.recipeTitle}</p>
                          {ingredient.alreadyListed && <p className="text-sm font-semibold text-[var(--ik-basil-dark)]">Già nella lista</p>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {currentView.status === 'ready' && (currentView.conflicts.length > 0 || currentView.recoveryConflicts.length > 0 || currentView.recoveryQuarantines.length > 0) && (
        <section aria-label="Modifiche in conflitto e recovery" className="mt-5 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5">
          <h2 className="text-2xl font-black text-[var(--ik-ink)]">Modifiche da rivedere</h2>
          {currentView.conflicts.map((conflict) => {
            const recipeId = conflict.command.action === 'manual_set' ? conflict.command.recipeId : null;
            const recipe = recipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === recipeId);
            return (
              <div key={conflict.id} className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm text-[var(--ik-ink)]">
                <p>{recipe?.title ?? 'Una scelta precedente'} non è stata condivisa; resta conservata su questo dispositivo.</p>
                {recipe !== undefined && currentView.canEdit && <button type="button" disabled={!scopeWritable} className="min-h-11 rounded-xl border-2 border-[var(--ik-basil)] bg-[var(--ik-surface)] px-3 py-2 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)] disabled:opacity-60" onClick={() => void retryConflict(conflict.id)}>Riproporre la scelta</button>}
              </div>
            );
          })}
          {currentView.recoveryConflicts.map((conflict: MealPlanRecoveryConflict) => {
            const recipeId = conflict.originalCommand.action === 'manual_set' ? conflict.originalCommand.recipeId : null;
            const recipe = recipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === recipeId);
            const sourceRecipeId = conflict.sourceState?.kind === 'manual' || conflict.sourceState?.kind === 'automatic' ? conflict.sourceState?.recipeId : null;
            const sourceRecipe = sourceRecipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === sourceRecipeId);
            const targetRecipeId = conflict.targetStateAtStaging.kind === 'manual' || conflict.targetStateAtStaging.kind === 'automatic' ? conflict.targetStateAtStaging.recipeId : null;
            const targetRecipe = targetRecipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === targetRecipeId);
            const originalAction = conflict.originalCommand.action;
            const originalActionLabel = originalAction === 'manual_set'
              ? `Impostato manualmente su ${recipe?.title ?? recipeId}`
              : originalAction === 'manual_delete'
              ? 'Rimosso manualmente'
              : originalAction === 'auto_create'
              ? 'Proposta automatica'
              : originalAction === 'explicit_regenerate'
              ? 'Rigenerazione esplicita'
              : originalAction;
            return (
              <div key={conflict.id} className="mt-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-4">
                <div className="flex flex-wrap items-start gap-3 text-sm text-[var(--ik-ink)]">
                  <div className="flex-1 min-w-[200px]">
                    <p className="font-semibold text-[var(--ik-warn-ink)]">Conflitto migrazione: {conflict.planDate}</p>
                    <p className="mt-1"><strong>Fonte (account):</strong> {sourceRecipe?.title ?? (conflict.sourceState?.kind === 'deleted' ? 'Pasto rimosso' : conflict.sourceState?.kind ?? 'Sconosciuto')}</p>
                    <p><strong>Destinazione (Casa):</strong> {targetRecipe?.title ?? (conflict.targetStateAtStaging.kind === 'deleted' ? 'Pasto rimosso' : conflict.targetStateAtStaging.kind ?? 'Sconosciuto')}</p>
                    <p className="mt-1 text-xs text-[var(--ik-ink-muted)]">Comando originale: {originalActionLabel}</p>
                  </div>
                  {recipe !== undefined && currentView.canEdit && scopeWritable && (
                    <button
                      type="button"
                      disabled={!scopeWritable}
                      className="min-h-11 min-w-28 rounded-xl border-2 border-[var(--ik-basil)] px-3 py-2 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)] disabled:opacity-60"
                      onClick={() => void resolveRecoveryConflict(conflict.id, recipeId, conflict.originalCommand, conflict.sourceRevision, conflict.targetRevisionAtStaging)}
                    >
                      Risolvi
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {currentView.recoveryQuarantines.map((quarantine) => {
            const sourceRecipeId = quarantine.sourceSnapshot.state?.kind === 'manual' || quarantine.sourceSnapshot.state?.kind === 'automatic' ? quarantine.sourceSnapshot.state?.recipeId : null;
            const sourceRecipe = sourceRecipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === sourceRecipeId);
            const targetRecipeId = quarantine.targetSnapshot.state?.kind === 'manual' || quarantine.targetSnapshot.state?.kind === 'automatic' ? quarantine.targetSnapshot.state?.recipeId : null;
            const targetRecipe = targetRecipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === targetRecipeId);
            return (
              <div key={quarantine.planDate} className="mt-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-4" role="alert">
                <div className="flex flex-wrap items-start gap-3 text-sm text-[var(--ik-ink)]">
                  <div className="flex-1 min-w-[200px]">
                    <p className="font-semibold text-[var(--ik-tomato)]">Quarantena migrazione: {quarantine.planDate}</p>
                    <p className="mt-1"><strong>Codice:</strong> {quarantine.reasonCode}</p>
                    <p><strong>Fonte (account):</strong> {sourceRecipe?.title ?? (quarantine.sourceSnapshot.state?.kind === 'deleted' ? 'Pasto rimosso' : quarantine.sourceSnapshot.state?.kind ?? 'Sconosciuto')}</p>
                    <p><strong>Destinazione (Casa):</strong> {targetRecipe?.title ?? (quarantine.targetSnapshot.state?.kind === 'deleted' ? 'Pasto rimosso' : quarantine.targetSnapshot.state?.kind ?? 'Sconosciuto')}</p>
                    <p className="mt-1 text-xs text-[var(--ik-ink-muted)]">Non risolvibile automaticamente: i dati originali sono incompleti o incoerenti. L'evidenza grezza è conservata per analisi manuale.</p>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <Link to="/shopping-list" className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-[var(--ik-basil)] bg-[var(--ik-surface)] px-4 py-2 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)]">Apri la lista della spesa</Link>
        <Link to="/" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-3 py-2 font-semibold text-[var(--ik-basil-dark)] underline underline-offset-2">Torna al Chef</Link>
      </div>
    </main>
  );
}
