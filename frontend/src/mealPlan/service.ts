import type { PlanCommand, PlanState, SyncMutationScope } from '@ikuck/shared/contracts';
import type { SyncScope } from '../sync/scopeContext';
import { assertScopeWritable } from '../sync/scopeWriteFence';
import { getDeviceId } from '../sync/syncQueue';
import type { MealPlanApi } from './api';
import { mealPlanApi } from './api';
import type { MealPlanImportItem } from './validation';
import {
  commitMealPlanCommand,
  enqueueMealPlanCommand,
  readMealPlanBootstrap,
  readMealPlanOutbox,
  readMealPlanSnapshot,
  saveMealPlanBootstrapPage,
  activateMealPlanBootstrap,
  applyMealPlanSyncPage,
  createMealPlanCapabilityFingerprint,
  isMealPlanBootstrapComplete,
  saveMealPlanCapability,
  saveMealPlanRead,
} from './storage';

export interface MealPlanSyncSummary {
  acknowledged: number;
  conflicts: number;
  pending: number;
}

const SYNC_PAGE_SIZE = 200;
const MAX_MEAL_PLAN_SYNC_PAGES = 1000;
const PLAN_READ_BATCH_SIZE = 100;
const syncTails = new Map<SyncScope, Promise<void>>();

const serializeMealPlanSync = async <T>(scope: SyncScope, action: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request(`ikuck:meal-plan-sync:${scope}`, { mode: 'exclusive' }, action);
  }
  const previous = syncTails.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  syncTails.set(scope, gate);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (syncTails.get(scope) === gate) syncTails.delete(scope);
  }
};

export async function synchronizeMealPlanScope(input: {
  scope: SyncScope;
  csrfToken: string;
  api?: MealPlanApi;
  assertCurrent?: () => void;
  deviceId?: string;
}): Promise<Awaited<ReturnType<typeof readMealPlanSnapshot>>> {
  const { scope, csrfToken, api = mealPlanApi, assertCurrent = () => {} } = input;
  if (scope === 'guest') throw new Error('Il piano ospite non richiede il bootstrap del server.');
  const scopeId = scope as SyncMutationScope;
  assertCurrent();
  assertScopeWritable(scope);
  const capability = await api.getCapabilities();
  assertCurrent();
  await saveMealPlanCapability(scope, capability, assertCurrent);
  assertCurrent();
  const fingerprint = createMealPlanCapabilityFingerprint(capability);
  const deviceId = input.deviceId ?? await getDeviceId();
  assertCurrent();

  let snapshot = await readMealPlanSnapshot(scope);
  assertCurrent();
  if (!isMealPlanBootstrapComplete(snapshot, capability)) {
    let activated = false;
    for (let pageNumber = 0; pageNumber < MAX_MEAL_PLAN_SYNC_PAGES; pageNumber += 1) {
      const stage = await readMealPlanBootstrap(scope, fingerprint);
      assertCurrent();
      const page = await api.readSyncPage(scopeId, deviceId, stage.cursor, csrfToken);
      assertCurrent();
      await saveMealPlanBootstrapPage(scope, fingerprint, stage.cursor, page, assertCurrent);
      assertCurrent();
      if (page.changes.length < SYNC_PAGE_SIZE) {
        await activateMealPlanBootstrap(scope, fingerprint, assertCurrent);
        assertCurrent();
        activated = true;
        break;
      }
    }
    if (!activated) throw new Error('Il bootstrap storico del piano è troppo ampio per essere completato in una sessione. Riprova.');
    snapshot = await readMealPlanSnapshot(scope);
    assertCurrent();
  }

  let cursor = snapshot.bootstrap?.cursor;
  if (cursor === undefined || snapshot.bootstrap?.capabilityFingerprint !== fingerprint) {
    throw new Error('Il bootstrap del piano non è completo per questo ambito.');
  }
  for (let pageNumber = 0; pageNumber < MAX_MEAL_PLAN_SYNC_PAGES; pageNumber += 1) {
    const page = await api.readSyncPage(scopeId, deviceId, cursor, csrfToken);
    assertCurrent();
    await applyMealPlanSyncPage(scope, fingerprint, cursor, page, assertCurrent);
    assertCurrent();
    cursor = page.nextCursor;
    if (page.changes.length < SYNC_PAGE_SIZE) break;
    if (pageNumber === MAX_MEAL_PLAN_SYNC_PAGES - 1) {
      throw new Error('La sincronizzazione incrementale del piano non si è stabilizzata. Riprova.');
    }
  }

  snapshot = await readMealPlanSnapshot(scope);
  assertCurrent();
  const dates = [...new Set([...snapshot.observedDates, ...Object.keys(snapshot.states)])];
  for (let offset = 0; offset < dates.length; offset += PLAN_READ_BATCH_SIZE) {
    const batch = dates.slice(offset, offset + PLAN_READ_BATCH_SIZE);
    const states = await api.readStates(scopeId, batch, csrfToken);
    assertCurrent();
    await saveMealPlanRead(scope, batch, states, undefined, assertCurrent);
    assertCurrent();
  }
  return readMealPlanSnapshot(scope).then((result) => {
    assertCurrent();
    return result;
  });
}

export function syncPendingMealPlan(
  scope: SyncScope,
  csrfToken: string,
  api: MealPlanApi = mealPlanApi,
  assertCurrent: () => void,
): Promise<MealPlanSyncSummary> {
  return serializeMealPlanSync(scope, () => syncPendingMealPlanUnlocked(scope, csrfToken, api, assertCurrent));
}

async function syncPendingMealPlanUnlocked(
  scope: SyncScope,
  csrfToken: string,
  api: MealPlanApi,
  assertCurrent: () => void,
): Promise<MealPlanSyncSummary> {
  if (scope === 'guest') throw new Error('Il piano ospite non viene sincronizzato con il server.');
  const scopeId = scope as SyncMutationScope;
  assertCurrent();
  assertScopeWritable(scope);
  const capability = await api.getCapabilities();
  assertCurrent();
  await saveMealPlanCapability(scope, capability, assertCurrent);
  assertCurrent();
  const snapshot = await readMealPlanSnapshot(scope);
  assertCurrent();
  if (!isMealPlanBootstrapComplete(snapshot, capability)) {
    throw new Error("Il piano resta non modificabile finché il bootstrap storico dell'ambito non è completo.");
  }
  const outbox = await readMealPlanOutbox([scope], assertCurrent);
  assertCurrent();
  let acknowledged = 0;
  let conflicts = 0;
  let index = 0;
  while (index < outbox.length) {
    assertCurrent();
    const record = outbox[index];
    if (record === undefined || record.scope !== scope || record.command.scope !== scopeId) {
      throw new Error('La coda contiene un’operazione di un altro ambito dati.');
    }
    if (record.sourceScope !== undefined || record.sourceRevision !== undefined) {
      if (record.sourceScope !== 'guest' || record.sourceRevision === undefined) {
        throw new Error('La coda contiene una provenienza di importazione non valida.');
      }
      const batch: typeof outbox = [];
      const dates = new Set<string>();
      while (index < outbox.length && batch.length < 100) {
        const candidate = outbox[index];
        if (candidate === undefined || candidate.sourceScope === undefined && candidate.sourceRevision === undefined) break;
        if (dates.has(candidate.command.date)) break;
        if (candidate.scope !== scope || candidate.command.scope !== scopeId
          || candidate.sourceScope !== 'guest' || candidate.sourceRevision === undefined) {
          throw new Error('La coda contiene una provenienza di importazione non valida.');
        }
        batch.push(candidate);
        dates.add(candidate.command.date);
        index += 1;
      }
      const items: MealPlanImportItem[] = batch.map((entry) => ({
        source: 'guest',
        sourceId: entry.command.date,
        localRevision: entry.sourceRevision!,
        command: entry.command,
      }));
      const receipts = await api.importCommands(scopeId, items, csrfToken);
      assertCurrent();
      for (const item of receipts.results) {
        const imported = batch.find((entry) => entry.command.date === item.sourceId
          && entry.sourceRevision === item.localRevision && entry.command.operationId === item.result.operationId);
        if (imported === undefined) throw new Error('La risposta di importazione non corrisponde alla coda locale.');
        const currentRows = await api.readStates(scopeId, [imported.command.date], csrfToken);
        assertCurrent();
        const current = currentRows.find((entry) => entry.date === imported.command.date)?.state;
        if (current === undefined) throw new Error('La risposta del piano non contiene la data richiesta.');
        const source = imported.sourceRevision === undefined
          ? undefined
          : { scope: 'guest' as const, date: imported.command.date, revision: imported.sourceRevision, receiptState: item.result.current };
        await commitMealPlanCommand(scope, imported.scope, imported.command, item.result, current, {
          source,
          resolvesConflictId: imported.resolvesConflictId,
          assertCurrent,
        });
        assertCurrent();
        acknowledged += 1;
        if (item.result.outcome === 'conflict') conflicts += 1;
      }
      continue;
    }
    const receipt = await api.sendCommand(record.command, csrfToken);
    assertCurrent();
    const currentRows = await api.readStates(scopeId, [record.command.date], csrfToken);
    assertCurrent();
    const current = currentRows.find((entry) => entry.date === record.command.date)?.state;
    if (current === undefined) throw new Error('La risposta del piano non contiene la data richiesta.');
    await commitMealPlanCommand(
      scope,
      record.scope,
      record.command,
      receipt,
      current,
      {
        resolvesConflictId: record.resolvesConflictId,
        assertCurrent,
      },
    );
    assertCurrent();
    acknowledged += 1;
    if (receipt.outcome === 'conflict') conflicts += 1;
    index += 1;
  }
  const remaining = await readMealPlanOutbox([scope], assertCurrent);
  assertCurrent();
  return {
    acknowledged,
    conflicts,
    pending: remaining.length,
  };
}

export interface GuestPlanImportSummary extends MealPlanSyncSummary {
  queued: number;
  preservedConflicts: number;
}

const createGuestImportCommand = async (state: PlanState, scope: SyncMutationScope, deviceId: string, clientUpdatedAt: string): Promise<PlanCommand> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([scope, state.date, state.revision])));
  const sourceKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const base = {
    version: 2 as const,
    scope,
    date: state.date,
    operationId: `guest-plan:${sourceKey}`,
    deviceId,
    clientUpdatedAt,
  };
  if (state.kind === 'deleted') return { ...base, action: 'manual_delete' };
  if (state.kind === 'manual') return { ...base, action: 'manual_set', recipeId: state.recipeId };
  return { ...base, action: 'auto_create', recipeId: state.recipeId, baseRevision: null };
};

export async function importGuestMealPlan(input: {
  scope: SyncScope;
  csrfToken: string;
  api?: MealPlanApi;
  assertCurrent?: () => void;
  deviceId?: string;
}): Promise<GuestPlanImportSummary> {
  const { scope, csrfToken, api = mealPlanApi, assertCurrent = () => {} } = input;
  if (scope === 'guest') throw new Error('Scegli prima un account o una Casa per importare il Piano ospite.');
  assertCurrent();
  assertScopeWritable(scope);
  const guest = await readMealPlanSnapshot('guest');
  assertCurrent();
  const target = await synchronizeMealPlanScope({ scope, csrfToken, api, assertCurrent, deviceId: input.deviceId });
  assertCurrent();
  if (target.capability === null || !isMealPlanBootstrapComplete(target, target.capability)) {
    throw new Error('Il Piano ospite non può essere importato prima del bootstrap completo dell’ambito.');
  }
  const existingOutbox = await readMealPlanOutbox([scope], assertCurrent);
  assertCurrent();
  const scopeId = scope as SyncMutationScope;
  const deviceId = input.deviceId ?? await getDeviceId();
  assertCurrent();
  let queued = 0;
  let preservedConflicts = 0;
  for (const state of Object.values(guest.states)) {
    assertCurrent();
    const priorConflict = target.conflicts.some((conflict) => conflict.date === state.date
      && conflict.sourceScope === 'guest' && conflict.sourceRevision === state.revision);
    if (priorConflict) {
      preservedConflicts += 1;
      continue;
    }
    const alreadyQueued = existingOutbox.some((entry) => entry.sourceScope === 'guest'
      && entry.sourceRevision === state.revision && entry.command.date === state.date);
    if (alreadyQueued) continue;
    const origin = guest.guestOrigins[state.date];
    const expectedAction = state.kind === 'manual' ? 'manual_set' : state.kind === 'deleted' ? 'manual_delete' : 'auto_create';
    if (origin === undefined || origin.revision !== state.revision || origin.originalAction !== expectedAction) {
      preservedConflicts += 1;
      continue;
    }
    const command = await createGuestImportCommand(state, scopeId, deviceId, origin.clientUpdatedAt);
    assertCurrent();
    const optimisticState: PlanState = { ...state, serverSequence: 0 };
    await queuePlanCommand(scope, command, optimisticState, { sourceScope: 'guest', sourceRevision: state.revision, assertCurrent });
    assertCurrent();
    queued += 1;
  }
  const sync = await syncPendingMealPlan(scope, csrfToken, api, assertCurrent);
  assertCurrent();
  const reconciled = await readMealPlanSnapshot(scope);
  assertCurrent();
  const previousConflictIds = new Set(target.conflicts.map((conflict) => conflict.id));
  const newGuestConflicts = reconciled.conflicts.filter((conflict) => conflict.sourceScope === 'guest'
    && !previousConflictIds.has(conflict.id)).length;
  return { ...sync, queued, preservedConflicts: preservedConflicts + newGuestConflicts };
}

export async function queuePlanCommand(
  scope: SyncScope,
  command: PlanCommand,
  optimisticState: PlanState,
  options: { sourceScope?: SyncScope; sourceRevision?: string; assertCurrent?: () => void; resolvesConflictId?: string } = {},
): Promise<void> {
  options.assertCurrent?.();
  const snapshot = await readMealPlanSnapshot(scope);
  options.assertCurrent?.();
  if (snapshot.capability === null || !isMealPlanBootstrapComplete(snapshot, snapshot.capability)) {
    throw new Error('Il piano resta non modificabile finché il bootstrap storico dell’ambito non è completo.');
  }
  await enqueueMealPlanCommand(scope, command, { ...options, optimisticState }, options.assertCurrent);
}

export function createPlanCommand(input: {
  scope: SyncMutationScope;
  date: string;
  action: PlanCommand['action'];
  deviceId: string;
  recipeId?: string;
  baseRevision?: string | null;
  clientUpdatedAt?: string;
}): PlanCommand {
  const operationId = globalThis.crypto?.randomUUID?.();
  if (operationId === undefined) throw new Error('Il browser non può creare un identificativo sicuro per il piano.');
  const base = {
    version: 2 as const,
    scope: input.scope,
    date: input.date,
    operationId,
    deviceId: input.deviceId,
    clientUpdatedAt: input.clientUpdatedAt ?? new Date().toISOString(),
  };
  if (input.action === 'manual_delete') return { ...base, action: input.action };
  if (input.recipeId === undefined) throw new Error('La ricetta è obbligatoria per questa azione.');
  if (input.action === 'manual_set') return { ...base, action: input.action, recipeId: input.recipeId };
  if (input.baseRevision === undefined) throw new Error('Manca la revisione di partenza del piano.');
  if (input.action === 'auto_create') {
    if (input.baseRevision !== null) throw new Error('La proposta automatica richiede una data vuota.');
    return { ...base, action: 'auto_create', recipeId: input.recipeId, baseRevision: null };
  }
  if (input.baseRevision === null) throw new Error('La rigenerazione richiede la revisione cancellata.');
  return { ...base, action: 'explicit_regenerate', recipeId: input.recipeId, baseRevision: input.baseRevision };
}

export async function readPlanView(scope: SyncScope): Promise<{
  snapshot: Awaited<ReturnType<typeof readMealPlanSnapshot>>;
  outbox: Awaited<ReturnType<typeof readMealPlanOutbox>>;
}> {
  const [snapshot, outbox] = await Promise.all([
    readMealPlanSnapshot(scope),
    readMealPlanOutbox([scope]),
  ]);
  return { snapshot, outbox };
}
