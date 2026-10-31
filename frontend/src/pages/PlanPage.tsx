import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { useShoppingListStore } from '../store/shoppingListStore';
import { getDeviceId } from '../sync/syncQueue';
import { MealPlanUnavailableError, mealPlanApi, type MealPlanApi, type MealPlanRecoveryConflict, type MealPlanRecoveryQuarantine, type MealPlanRecoveryResolution } from '../mealPlan/api';
import {
  formatCivilDateLong,
  getDeviceTimeZone,
  getNextFourCivilDates,
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
  if (scope.startsWith('house:') && scope !== 'guest') {
    try {
      const recovery = await mealPlanApi.readRecovery();
      recoveryConflicts.push(...recovery.conflicts);
      recoveryQuarantines.push(...recovery.quarantined);
    } catch {
      // Ignore recovery fetch errors; local conflicts still shown
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
    pendingDates: [...new Set(outbox.map((record) => record.command.date))],
    timeZone,
    canEdit,
    mode,
    message,
  };
};

async function loadGuestPlan(now: Date, profile: DietProfile, assertCurrent: () => void): Promise<PlanPageView> {
  const timeZone = getDeviceTimeZone();
  if (timeZone === null || !isValidIanaTimeZone(timeZone)) throw new Error('Il fuso orario del dispositivo non è disponibile.');
  const dates = getNextFourCivilDates(now, timeZone);
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
      const view = await toView(scope, getNextFourCivilDates(now, zone), zone, 'unsupported', false,
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
      return toView(scope, getNextFourCivilDates(now, zone), zone, 'provisional', false,
        'Connessione assente: il bootstrap storico del piano non è completo; i dati condivisi non vengono letti o modificati.', assertCurrent);
    }
    const canEditOffline = timeZoneConfirmed;
    const mode = timeZoneConfirmed ? 'offline' : 'provisional';
    const message = timeZoneConfirmed
      ? 'Connessione assente: la copia salvata può essere provvisoria. Le nuove scelte restano sul dispositivo finché non vengono confermate dal server.'
      : 'Connessione assente e fuso della Casa non memorizzato: il calendario usa provvisoriamente il fuso del dispositivo. Il piano condiviso non viene letto o modificato.';
    return toView(scope, getNextFourCivilDates(now, zone), zone, mode, canEditOffline, message, assertCurrent);
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
    return toView(scope, getNextFourCivilDates(now, zone), zone, 'offline', confirmed,
      'Il fuso condiviso non è raggiungibile: vengono mostrate le date salvate, non una finestra confermata.', assertCurrent);
  }
  const dates = getNextFourCivilDates(now, zoneState.timeZone);
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
      if (currentView.status !== 'ready') return [] as const;
      const availableIds = new Set(
        useShoppingListStore.getState().items
          .filter((item) => !item.purchased)
          .map((item) => item.ingredientId)
      );
      const result: Array<{ ingredientId: string; label: string; recipeTitle: string }> = [];
      for (const row of rows) {
        const state = row.state;
        if (state === null || state.recipeId === null) continue;
        const recipe = RECIPES.find((r) => r.id === state.recipeId);
        if (!recipe) continue;
        for (const ing of recipe.ingredients) {
          if (ing.optional) continue;
          if (availableIds.has(ing.ingredientId)) continue;
          const label = ing.name ?? ing.ingredientId;
          result.push({
            ingredientId: ing.ingredientId,
            label,
            recipeTitle: recipe.title,
          });
        }
      }
      return result;
    }, [rows, currentView.status]);

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

  useEffect(() => setTimeZoneDraft(currentView.timeZone ?? ''), [currentView.timeZone]);

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

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Pasti dei prossimi giorni</p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-5xl">Piano</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700">Quattro giorni da domani, con ricette che puoi cambiare.</p>
      </header>

      <section aria-label="Stato della condivisione" className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ik-border)] pb-3">
        <p role="status" className="font-semibold text-gray-800">{currentView.status === 'loading' ? 'Caricamento del piano…' : shareStatus}</p>
        {currentView.timeZone !== null && <p className="text-sm text-gray-600">Fuso: {currentView.timeZone}</p>}
      </section>

      {currentView.status === 'ready' && currentView.scope.startsWith('house:') && houseState?.membership?.role === 'admin' && currentView.canEdit && (
        <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void changeHouseTimeZone(); }}>
          <label className="grid gap-1 text-sm font-semibold text-gray-800">
            Fuso orario della Casa
            <input
              type="text"
              name="house-time-zone"
              autoComplete="off"
              value={timeZoneDraft}
              onChange={(event) => setTimeZoneDraft(event.currentTarget.value)}
              className="min-h-11 w-56 rounded-lg border border-gray-400 px-3 py-2"
              aria-describedby="house-time-zone-help"
            />
          </label>
          <p id="house-time-zone-help" className="sr-only">Usa un identificativo IANA, per esempio Europe/Rome.</p>
          <button type="submit" disabled={savingTimeZone || !scopeWritable} className="min-h-11 rounded-xl border-2 border-emerald-700 px-4 py-2 font-bold text-emerald-950 disabled:opacity-60">
            {savingTimeZone ? 'Aggiornamento…' : 'Aggiorna fuso'}
          </button>
        </form>
      )}

      {currentView.message !== null && <p role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{currentView.message}</p>}
      {currentFeedback !== null && <p role="alert" className="mb-4 text-sm font-semibold text-amber-900">{currentFeedback}</p>}
      {currentView.status === 'loading' && <p role="status" className="py-6 text-gray-600">Caricamento del piano…</p>}
      {currentView.status === 'error' && <p role="alert" className="py-4 text-red-800">{currentView.message ?? 'Il piano non è stato caricato.'}</p>}
      {currentView.status === 'blocked' && <p role="status" className="py-4 text-gray-700">Il piano condiviso non è disponibile.</p>}

      {currentView.status === 'ready' && (
        <ol aria-label="Pasti da domani" className="divide-y divide-[var(--ik-border)] border-y border-[var(--ik-border)]">
          {rows.map(({ date, label, state, pending }) => {
            const recipe = state?.recipeId === null || state === null ? undefined : RECIPES.find((candidate) => candidate.id === state.recipeId);
            const rowPending = pending || currentView.mode === 'offline' && state !== null && currentView.overlays[date] !== undefined;
            return (
              <li key={date} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 py-4 sm:grid-cols-[minmax(10rem,0.85fr)_minmax(0,1.7fr)_auto] sm:items-center" data-date={date}>
                <time dateTime={date} className="font-bold capitalize text-gray-950">{label}</time>
                <div className="min-w-0">
                  {recipe !== undefined ? <p className="font-semibold text-gray-900">{recipe.title}</p>
                    : state?.kind === 'deleted' ? <p className="font-semibold text-gray-700">Pasto rimosso</p>
                      : state !== null ? <p className="font-semibold text-gray-800">Ricetta non più disponibile nel catalogo</p>
                        : <p className="text-gray-600">Nessuna ricetta compatibile al momento</p>}
                  {recipe?.durationMinutes !== null && recipe?.durationMinutes !== undefined
                    && <p className="mt-1 text-sm text-gray-600">{recipe.durationMinutes} minuti</p>}
                  {rowPending && <p className="mt-1 text-sm font-medium text-amber-800">In attesa di conferma · non condivisa</p>}
                </div>
                {state !== null && currentView.canEdit && (
                  <button
                    type="button"
                    className="col-span-2 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-emerald-700 px-3 py-2 text-sm font-bold text-emerald-950 hover:bg-emerald-50 disabled:opacity-60 sm:col-span-1"
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
                  <section aria-label="Ingredienti mancanti per il piano" className="mt-5 border-t border-[var(--ik-border)] pt-4">
                    <header className="flex flex-wrap items-center justify-between gap-3 mb-3">
                      <div>
                        <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[var(--sc-basil-dark)]">
                          <ShoppingCart size={14} aria-hidden="true" /> Spesa
                        </p>
                        <h2 className="mt-1 text-xl font-black text-gray-900">Ingredienti mancanti per il piano</h2>
                        <p className="mt-1 text-sm text-gray-600">{missingIngredients.length} ingredienti non presenti in dispensa</p>
                      </div>
                      <button
                                    type="button"
                                    onClick={() => {
                                      const recipesForMissing = missingIngredients
                                        .map((m) => RECIPES.find((r) => r.title === m.recipeTitle))
                                        .filter((r): r is typeof RECIPES[0] => r !== undefined);
                                      let totalAdded = 0;
                                      for (const recipe of recipesForMissing) {
                                        const added = useShoppingListStore.getState().addMissingRecipeIngredients(recipe, []);
                                        totalAdded += added;
                                      }
                                      if (totalAdded > 0) {
                                        publishFeedback(`${totalAdded} ingredienti aggiunti alla lista della spesa.`);
                                      } else {
                                        publishFeedback('Nessun nuovo ingrediente da aggiungere (già presenti o acquistati).');
                                      }
                                    }}
                                    disabled={missingIngredients.length === 0}
                                    className="min-h-11 rounded-xl border-2 border-emerald-700 px-4 py-2 font-bold text-emerald-950 hover:bg-emerald-50 disabled:opacity-60"
                                  >
                                    <Plus size={18} aria-hidden="true" /> Aggiungi alla lista
                                  </button>
                    </header>
                    <div className="grid gap-2" role="list">
                                {missingIngredients.map((m, idx) => (
                                  <div key={`${m.ingredientId}-${idx}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--ik-border)] bg-white p-3">
                                    <p className="font-semibold text-gray-900">{m.label}</p>
                                    <p className="text-sm text-gray-600">Per: {m.recipeTitle}</p>
                                  </div>
                                ))}
                              </div>
                  </section>
                )}

                {currentView.status === 'ready' && (currentView.conflicts.length > 0 || currentView.recoveryConflicts.length > 0 || currentView.recoveryQuarantines.length > 0) && (
        <section aria-label="Modifiche in conflitto e recovery" className="mt-5 border-t border-[var(--ik-border)] pt-4">
          <h2 className="text-base font-bold text-gray-900">Modifiche da rivedere</h2>
          {currentView.conflicts.map((conflict) => {
            const recipeId = conflict.command.action === 'manual_set' ? conflict.command.recipeId : null;
            const recipe = recipeId === null ? undefined : RECIPES.find((candidate) => candidate.id === recipeId);
            return (
              <div key={conflict.id} className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-700">
                <p>{recipe?.title ?? 'Una scelta precedente'} non è stata condivisa; resta conservata su questo dispositivo.</p>
                {recipe !== undefined && currentView.canEdit && <button type="button" disabled={!scopeWritable} className="min-h-11 font-bold text-emerald-900 underline underline-offset-2 disabled:opacity-60" onClick={() => void retryConflict(conflict.id)}>Riproporre la scelta</button>}
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
              <div key={conflict.id} className="mt-2 p-3 rounded-lg border border-amber-300 bg-amber-50">
                <div className="flex flex-wrap items-start gap-3 text-sm text-gray-800">
                  <div className="flex-1 min-w-[200px]">
                    <p className="font-semibold text-amber-900">Conflitto migrazione: {conflict.planDate}</p>
                    <p className="mt-1"><strong>Fonte (account):</strong> {sourceRecipe?.title ?? conflict.sourceState?.kind === 'deleted' ? 'Pasto rimosso' : conflict.sourceState?.kind ?? 'Sconosciuto'}</p>
                    <p><strong>Destinazione (Casa):</strong> {targetRecipe?.title ?? conflict.targetStateAtStaging.kind === 'deleted' ? 'Pasto rimosso' : conflict.targetStateAtStaging.kind ?? 'Sconosciuto'}</p>
                    <p className="mt-1 text-xs text-gray-600">Comando originale: {originalActionLabel}</p>
                  </div>
                  {recipe !== undefined && currentView.canEdit && scopeWritable && (
                    <button
                      type="button"
                      disabled={!scopeWritable}
                      className="min-h-11 min-w-28 rounded-xl border-2 border-emerald-700 px-3 py-2 font-bold text-emerald-900 hover:bg-emerald-50 disabled:opacity-60"
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
              <div key={quarantine.planDate} className="mt-2 p-3 rounded-lg border border-red-300 bg-red-50" role="alert">
                <div className="flex flex-wrap items-start gap-3 text-sm text-gray-800">
                  <div className="flex-1 min-w-[200px]">
                    <p className="font-semibold text-red-900">Quarantena migrazione: {quarantine.planDate}</p>
                    <p className="mt-1"><strong>Codice:</strong> {quarantine.reasonCode}</p>
                    <p><strong>Fonte (account):</strong> {sourceRecipe?.title ?? quarantine.sourceSnapshot.state?.kind === 'deleted' ? 'Pasto rimosso' : quarantine.sourceSnapshot.state?.kind ?? 'Sconosciuto'}</p>
                    <p><strong>Destinazione (Casa):</strong> {targetRecipe?.title ?? quarantine.targetSnapshot.state?.kind === 'deleted' ? 'Pasto rimosso' : quarantine.targetSnapshot.state?.kind ?? 'Sconosciuto'}</p>
                    <p className="mt-1 text-xs text-gray-600">Non risolvibile automaticamente: i dati originali sono incompleti o incoerenti. L'evidenza grezza è conservata per analisi manuale.</p>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <Link to="/shopping-list" className="inline-flex min-h-11 items-center rounded-xl border-2 border-emerald-700 px-4 py-2 font-bold text-emerald-900 hover:bg-emerald-50">Apri la lista della spesa</Link>
        <Link to="/" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-3 py-2 font-semibold text-emerald-800 underline underline-offset-2">Torna al Chef</Link>
      </div>
    </main>
  );
}
