import type {
  HouseTimeZoneState,
  MealPlanCapabilities,
  PlanCommand,
  PlanResult,
  PlanState,
  SyncEntityType,
  SyncMutationScope,
} from '@ikuck/shared/contracts';
import type { SyncScope } from '../sync/scopeContext';
import { scopeStorageKey } from '../sync/scopeContext';
import { assertScopeWritable, trackScopedWrite } from '../sync/scopeWriteFence';
import {
  atomicUpdateKeyValuesAndQueue,
  readKeyValue,
  readQueueValues,
  type AtomicKeyValueUpdate,
} from '../storage/indexedDb';
import {
  parseHouseTimeZoneState,
  parseMealPlanCapabilities,
  isPlanCommand,
  isPlanState,
  type MealPlanSyncPage,
} from './validation';

export interface MealPlanConflict {
  id: string;
  date: string;
  command: PlanCommand;
  current: PlanState | null;
  savedAt: string;
  sourceScope?: SyncScope;
  sourceRevision?: string;
}

const MEAL_PLAN_ENTITY_TYPE: Extract<SyncEntityType, 'meal_plan_entry'> = 'meal_plan_entry';

export interface MealPlanBootstrapMarker {
  version: 2;
  capabilityFingerprint: string;
  cursor: number;
}

export interface MealPlanBootstrapStage {
  version: 2;
  scope: SyncScope;
  capabilityFingerprint: string;
  cursor: number;
  states: Record<string, PlanState>;
}

export interface MealPlanSnapshot {
  version: 2;
  states: Record<string, PlanState>;
  overlays: Record<string, PlanState>;
  observedDates: string[];
  timeZone: HouseTimeZoneState | null;
  capability: MealPlanCapabilities | null;
  bootstrap: MealPlanBootstrapMarker | null;
  conflicts: MealPlanConflict[];
  receipts: Record<string, PlanResult>;
  guestOrigins: Record<string, { revision: string; clientUpdatedAt: string; originalAction: PlanCommand['action'] }>;
}

export interface MealPlanOutboxRecord {
  mutationId: string;
  entityType: typeof MEAL_PLAN_ENTITY_TYPE;
  scope: SyncScope;
  command: PlanCommand;
  createdAt: string;
  localOrder: number;
  optimisticState?: PlanState;
  sourceScope?: SyncScope;
  sourceRevision?: string;
  resolvesConflictId?: string;
}

const storageKey = (scope: SyncScope): string => scopeStorageKey(scope, 'meal-plan-v2');
const bootstrapStorageKey = (scope: SyncScope): string => scopeStorageKey(scope, 'meal-plan-bootstrap-v2');

const assertGuard = (guard?: () => void): void => {
  if (guard !== undefined && (guard as () => unknown)() !== undefined) {
    throw new Error('Meal plan guard must assert by throwing, not return a value');
  }
};

const trackPlanWrite = <T>(
  scope: SyncScope,
  action: (assertActive: () => void) => Promise<T>,
  assertCurrent?: () => void,
): Promise<T> => trackScopedWrite(scope, (assertWritable) => {
  const assertActive = (): void => {
    assertWritable();
    assertGuard(assertCurrent);
  };
  assertActive();
  return action(assertActive);
});
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const isSyncScope = (value: unknown): value is SyncScope => value === 'guest'
  || typeof value === 'string' && /^(?:account|house):[^:]{1,128}$/.test(value);
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const parts = value.split('-').map(Number);
    if (parts.length !== 3) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  } catch {
    return false;
  }
};

const parseBootstrapMarker = (value: unknown): MealPlanBootstrapMarker | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'capabilityFingerprint', 'cursor'])
    || value.version !== 2 || typeof value.capabilityFingerprint !== 'string'
    || value.capabilityFingerprint.length < 1 || value.capabilityFingerprint.length > 128
    || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0) return null;
  return { version: 2, capabilityFingerprint: value.capabilityFingerprint, cursor: value.cursor as number };
};

const emptyBootstrapStage = (scope: SyncScope, capabilityFingerprint: string): MealPlanBootstrapStage => ({
  version: 2,
  scope,
  capabilityFingerprint,
  cursor: 0,
  states: {},
});

const parseBootstrapStage = (value: unknown): MealPlanBootstrapStage | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'scope', 'capabilityFingerprint', 'cursor', 'states'])
    || value.version !== 2 || !isSyncScope(value.scope) || typeof value.capabilityFingerprint !== 'string'
    || value.capabilityFingerprint.length < 1 || value.capabilityFingerprint.length > 128
    || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 || !isRecord(value.states)) return null;
  const states: Record<string, PlanState> = {};
  for (const [date, state] of Object.entries(value.states)) {
    if (!isDate(date) || !isPlanState(state) || state.date !== date) return null;
    states[date] = state;
  }
  return {
    version: 2,
    scope: value.scope,
    capabilityFingerprint: value.capabilityFingerprint,
    cursor: value.cursor as number,
    states,
  };
};

export function createMealPlanCapabilityFingerprint(capability: MealPlanCapabilities): string {
  return `meal-plan-v${capability.version}-read-v${capability.syncReadVersion}`;
}

export function isMealPlanBootstrapComplete(snapshot: MealPlanSnapshot, capability: MealPlanCapabilities): boolean {
  return snapshot.bootstrap?.version === 2
    && snapshot.bootstrap.capabilityFingerprint === createMealPlanCapabilityFingerprint(capability);
}

const emptySnapshot = (): MealPlanSnapshot => ({
  version: 2,
  states: {},
  overlays: {},
  observedDates: [],
  timeZone: null,
  capability: null,
  bootstrap: null,
  conflicts: [],
  receipts: {},
  guestOrigins: {},
});

const samePlanState = (left: PlanState, right: PlanState): boolean => left.date === right.date
  && left.revision === right.revision && left.serverSequence === right.serverSequence
  && left.kind === right.kind && left.recipeId === right.recipeId;

const isPlanResult = (value: unknown): value is PlanResult => isRecord(value)
  && hasExactKeys(value, ['version', 'operationId', 'outcome', 'current'])
  && value.version === 2 && typeof value.operationId === 'string' && value.operationId.length > 0
  && (value.outcome === 'applied' || value.outcome === 'conflict')
  && (value.current === null || isPlanState(value.current));

const samePlanResult = (left: PlanResult, right: PlanResult): boolean => left.operationId === right.operationId
  && left.outcome === right.outcome
  && (left.current === null ? right.current === null : right.current !== null && samePlanState(left.current, right.current));

const isConflict = (value: unknown): value is MealPlanConflict => {
  if (!isRecord(value)) return false;
  const keys = ['id', 'date', 'command', 'current', 'savedAt'];
  if (value.sourceScope !== undefined) keys.push('sourceScope');
  if (value.sourceRevision !== undefined) keys.push('sourceRevision');
  return hasExactKeys(value, keys)
    && typeof value.id === 'string' && value.id.length > 0
    && value.id === (value.command as PlanCommand | undefined)?.operationId
    && isDate(value.date) && isPlanCommand(value.command) && value.command.date === value.date
    && (value.current === null || isPlanState(value.current) && value.current.date === value.date)
    && typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))
    && (value.sourceScope === undefined || isSyncScope(value.sourceScope))
    && (value.sourceRevision === undefined || typeof value.sourceRevision === 'string' && value.sourceScope !== undefined);
};

const parseSnapshot = (value: unknown): MealPlanSnapshot | null => {
  const snapshotKeys = ['version', 'states', 'overlays', 'observedDates', 'timeZone', 'capability', 'conflicts'];
  if (!isRecord(value)) return null;
  if (value.bootstrap !== undefined) snapshotKeys.push('bootstrap');
  if (value.receipts !== undefined) snapshotKeys.push('receipts');
  if (value.guestOrigins !== undefined) snapshotKeys.push('guestOrigins');
  if (!hasExactKeys(value, snapshotKeys)
    || value.version !== 2 || !isRecord(value.states) || !isRecord(value.overlays)
    || !Array.isArray(value.observedDates) || !value.observedDates.every(isDate)
    || new Set(value.observedDates).size !== value.observedDates.length
    || value.timeZone !== null && parseHouseTimeZoneState(value.timeZone) === null
    || value.capability !== null && parseMealPlanCapabilities(value.capability) === null
    || value.bootstrap !== undefined && value.bootstrap !== null && parseBootstrapMarker(value.bootstrap) === null
    || !Array.isArray(value.conflicts) || !value.conflicts.every(isConflict)
    || value.receipts !== undefined && !isRecord(value.receipts)) return null;
  const states: Record<string, PlanState> = {};
  for (const [date, state] of Object.entries(value.states)) {
    if (!isDate(date) || !isPlanState(state) || state.date !== date) return null;
    states[date] = state;
  }
  const overlays: Record<string, PlanState> = {};
  for (const [date, state] of Object.entries(value.overlays)) {
    if (!isDate(date) || !isPlanState(state) || state.date !== date) return null;
    overlays[date] = state;
  }
  const receipts: MealPlanSnapshot['receipts'] = {};
  if (value.receipts !== undefined) {
    for (const [operationId, receipt] of Object.entries(value.receipts)) {
      if (!isPlanResult(receipt) || receipt.operationId !== operationId) return null;
      receipts[operationId] = receipt;
    }
  }
  const guestOrigins: MealPlanSnapshot['guestOrigins'] = {};
  if (value.guestOrigins !== undefined) {
    if (!isRecord(value.guestOrigins)) return null;
    for (const [date, origin] of Object.entries(value.guestOrigins)) {
      if (!isRecord(origin) || !hasExactKeys(origin, ['revision', 'clientUpdatedAt', 'originalAction'])
        || origin.revision !== states[date]?.revision || typeof origin.clientUpdatedAt !== 'string'
        || !Number.isFinite(Date.parse(origin.clientUpdatedAt))
        || !['auto_create', 'manual_set', 'manual_delete', 'explicit_regenerate'].includes(String(origin.originalAction))) return null;
      guestOrigins[date] = origin as unknown as MealPlanSnapshot['guestOrigins'][string];
    }
  }
  return {
    version: 2,
    states,
    overlays,
    observedDates: [...value.observedDates],
    timeZone: value.timeZone === null ? null : parseHouseTimeZoneState(value.timeZone),
    capability: value.capability === null ? null : parseMealPlanCapabilities(value.capability),
    bootstrap: value.bootstrap === undefined || value.bootstrap === null ? null : parseBootstrapMarker(value.bootstrap),
    conflicts: [...value.conflicts],
    receipts,
    guestOrigins,
  };
};

export function isMealPlanOutboxRecord(value: unknown): value is MealPlanOutboxRecord {
  if (!isRecord(value) || typeof value.mutationId !== 'string' || value.mutationId.length < 1
    || value.mutationId.length > 128 || value.entityType !== MEAL_PLAN_ENTITY_TYPE || !isSyncScope(value.scope)
    || !isPlanCommand(value.command) || value.command.operationId !== value.mutationId
    || value.command.scope !== value.scope || typeof value.createdAt !== 'string'
    || !Number.isSafeInteger(value.localOrder) || (value.localOrder as number) < 1
    || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (value.sourceScope !== undefined && !isSyncScope(value.sourceScope)) return false;
  if (value.sourceRevision !== undefined && (typeof value.sourceRevision !== 'string' || value.sourceRevision.length < 1 || value.sourceScope === undefined)) return false;
  if (value.sourceScope !== undefined && value.sourceRevision === undefined) return false;
  if (value.resolvesConflictId !== undefined && (typeof value.resolvesConflictId !== 'string'
    || value.resolvesConflictId.length < 1 || value.resolvesConflictId.length > 128)) return false;
  if (value.optimisticState !== undefined && (!isPlanState(value.optimisticState)
    || value.optimisticState.date !== value.command.date)) return false;
  const keys = ['mutationId', 'entityType', 'scope', 'command', 'createdAt', 'localOrder'];
  if (value.optimisticState !== undefined) keys.push('optimisticState');
  if (value.sourceScope !== undefined) keys.push('sourceScope');
  if (value.sourceRevision !== undefined) keys.push('sourceRevision');
  if (value.resolvesConflictId !== undefined) keys.push('resolvesConflictId');
  if (!hasExactKeys(value, keys)) return false;
  return true;
}

export async function readMealPlanSnapshot(scope: SyncScope): Promise<MealPlanSnapshot> {
  const stored = await readKeyValue<unknown>(storageKey(scope));
  if (stored === null) return emptySnapshot();
  const parsed = parseSnapshot(stored);
  if (parsed === null) throw new Error('I dati locali del piano non sono leggibili in sicurezza.');
  return parsed;
}

export async function readMealPlanBootstrap(
  scope: SyncScope,
  capabilityFingerprint: string,
): Promise<MealPlanBootstrapStage> {
  const stored = await readKeyValue<unknown>(bootstrapStorageKey(scope));
  if (stored === null) return emptyBootstrapStage(scope, capabilityFingerprint);
  const parsed = parseBootstrapStage(stored);
  if (parsed === null) throw new Error('La scansione storica locale del piano non è leggibile in sicurezza.');
  if (parsed.scope !== scope || parsed.capabilityFingerprint !== capabilityFingerprint) {
    return emptyBootstrapStage(scope, capabilityFingerprint);
  }
  return parsed;
}

const mergeServerStates = (
  current: Record<string, PlanState>,
  changes: MealPlanSyncPage['changes'],
): Record<string, PlanState> => {
  const next = { ...current };
  for (const { state, serverSequence } of changes) {
    if (!isPlanState(state) || state.serverSequence !== serverSequence) throw new Error('Lo stato sincronizzato del piano non è valido.');
    const previous = next[state.date];
    if (previous !== undefined && previous.serverSequence > serverSequence) continue;
    if (previous !== undefined && previous.serverSequence === serverSequence && !samePlanState(previous, state)) {
      throw new Error('La sincronizzazione del piano ha restituito due stati diversi con lo stesso cursore.');
    }
    next[state.date] = state;
  }
  return next;
};

const assertMealPlanPage = (requestedCursor: number, page: MealPlanSyncPage): void => {
  if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0
    || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < requestedCursor
    || page.changes.length > 200
    || page.changes.some(({ state, serverSequence }) => !isPlanState(state)
      || state.serverSequence !== serverSequence || serverSequence <= requestedCursor)
    || page.changes.length > 0 && page.nextCursor <= requestedCursor) {
    throw new Error('La pagina di sincronizzazione del piano non è valida o non avanza il cursore.');
  }
}

export async function saveMealPlanBootstrapPage(
  scope: SyncScope,
  capabilityFingerprint: string,
  requestedCursor: number,
  page: MealPlanSyncPage,
  assertCurrent?: () => void,
): Promise<void> {
  assertMealPlanPage(requestedCursor, page);
  await trackPlanWrite(scope, async (assertWritable) => {
    await atomicUpdateKeyValuesAndQueue([{
      key: bootstrapStorageKey(scope),
      update: (stored) => {
        const parsed = stored === null ? null : parseBootstrapStage(stored);
        if (stored !== null && parsed === null) throw new Error('La scansione storica locale del piano non è leggibile in sicurezza.');
        const stage = parsed !== null && parsed.scope === scope && parsed.capabilityFingerprint === capabilityFingerprint
          ? parsed
          : emptyBootstrapStage(scope, capabilityFingerprint);
        if (stage.cursor !== requestedCursor) throw new Error('Il cursore della scansione storica è cambiato durante il caricamento.');
        if (page.nextCursor < stage.cursor) throw new Error('Il cursore della scansione storica non può arretrare.');
        return {
          ...stage,
          cursor: page.nextCursor,
          states: mergeServerStates(stage.states, page.changes),
        } satisfies MealPlanBootstrapStage;
      },
    }], [], [], assertWritable);
  }, assertCurrent);
}

export async function activateMealPlanBootstrap(scope: SyncScope, capabilityFingerprint: string, assertCurrent?: () => void): Promise<void> {
  const stage = await readMealPlanBootstrap(scope, capabilityFingerprint);
  const expectedStage = JSON.stringify(stage);
  await trackPlanWrite(scope, async (assertWritable) => {
    await atomicUpdateKeyValuesAndQueue([
      {
        key: storageKey(scope),
        update: (stored) => {
          const snapshot = stored === null ? emptySnapshot() : parseSnapshot(stored);
          if (snapshot === null) throw new Error('I dati locali del piano non sono leggibili in sicurezza.');
          const states = mergeServerStates(Object.fromEntries(Object.entries(snapshot.states)
            .filter(([, state]) => state.serverSequence > stage.cursor)),
          Object.values(stage.states).map((state) => ({ state, serverSequence: state.serverSequence })));
          return {
            ...snapshot,
            states,
            observedDates: Object.keys(states),
            bootstrap: { version: 2, capabilityFingerprint, cursor: stage.cursor },
          } satisfies MealPlanSnapshot;
        },
      },
      {
        key: bootstrapStorageKey(scope),
        update: (stored) => {
          if (stored === null || JSON.stringify(stored) !== expectedStage) {
            throw new Error('La scansione storica del piano è cambiata prima dell’attivazione.');
          }
          return undefined;
        },
      },
    ], [], [], assertWritable);
  }, assertCurrent);
}

export async function applyMealPlanSyncPage(
  scope: SyncScope,
  capabilityFingerprint: string,
  requestedCursor: number,
  page: MealPlanSyncPage,
  assertCurrent?: () => void,
): Promise<void> {
  assertMealPlanPage(requestedCursor, page);
  await updateSnapshot(scope, (snapshot) => {
    if (snapshot.bootstrap?.capabilityFingerprint !== capabilityFingerprint) {
      throw new Error('Il bootstrap completo del piano non corrisponde alla versione negoziata.');
    }
    if (snapshot.bootstrap.cursor !== requestedCursor) {
      throw new Error('Il cursore del piano è cambiato durante la sincronizzazione.');
    }
    return {
      ...snapshot,
      states: mergeServerStates(snapshot.states, page.changes),
      observedDates: [...new Set([...snapshot.observedDates, ...page.changes.map(({ state }) => state.date)])],
      bootstrap: { ...snapshot.bootstrap, cursor: page.nextCursor },
    };
  }, [], [], assertCurrent);
}

export async function readMealPlanOutbox(
  scopes: readonly SyncScope[],
  assertCurrent?: () => void,
): Promise<MealPlanOutboxRecord[]> {
  assertGuard(assertCurrent);
  const batches = await Promise.all(scopes.map(async (scope) => {
    const assertActive = (): void => {
      assertScopeWritable(scope);
      assertGuard(assertCurrent);
    };
    assertActive();
    const records = await readQueueValues<unknown>(scope, assertActive);
    assertActive();
    return records;
  }));
  assertGuard(assertCurrent);
  const planRecords = batches.flat().filter((record) => isRecord(record) && record.entityType === MEAL_PLAN_ENTITY_TYPE);
  if (planRecords.some((record) => !isMealPlanOutboxRecord(record))) {
    throw new Error('La coda del piano contiene un’operazione da recuperare prima di poter continuare.');
  }
  return (planRecords as MealPlanOutboxRecord[]).sort((left, right) => left.localOrder - right.localOrder
    || (left.mutationId < right.mutationId ? -1 : left.mutationId > right.mutationId ? 1 : 0));
}

const rebuildMealPlanOverlays = (queueValues: readonly unknown[]): MealPlanSnapshot['overlays'] => {
  const overlays: MealPlanSnapshot['overlays'] = {};
  const records = queueValues.filter(isMealPlanOutboxRecord).sort((left, right) => left.localOrder - right.localOrder
    || (left.mutationId < right.mutationId ? -1 : left.mutationId > right.mutationId ? 1 : 0));
  for (const record of records) {
    if (record.optimisticState !== undefined) overlays[record.command.date] = record.optimisticState;
  }
  return overlays;
};

const updateSnapshot = (
  scope: SyncScope,
  update: (snapshot: MealPlanSnapshot, queueValues: readonly unknown[]) => MealPlanSnapshot,
  queueWrites: readonly unknown[] = [],
  queueDeletes: readonly { mutationId: string; scope: SyncScope }[] = [],
  assertCurrent?: () => void,
  queueScope?: SyncScope,
): Promise<void> => trackPlanWrite(scope, async (assertWritable) => {
  const key = storageKey(scope);
  const updates: AtomicKeyValueUpdate[] = [{
    key,
    ...(queueScope === undefined ? {} : { queueScope }),
    update: (current, queueValues) => {
      const snapshot = current === null ? emptySnapshot() : parseSnapshot(current);
      if (snapshot === null) throw new Error('I dati locali del piano non sono leggibili in sicurezza.');
      return update(snapshot, queueValues);
    },
  }];
  await atomicUpdateKeyValuesAndQueue(updates, queueWrites, queueDeletes, assertWritable);
}, assertCurrent);

export async function saveGuestPlanState(
  state: PlanState,
  origin: { clientUpdatedAt?: string; originalAction?: PlanCommand['action'] } = {},
  assertCurrent?: () => void,
): Promise<void> {
  if (!isPlanState(state)) throw new Error('La scelta del piano non è valida.');
  const originalAction = origin.originalAction ?? (state.kind === 'manual' ? 'manual_set'
    : state.kind === 'deleted' ? 'manual_delete' : 'auto_create');
  const clientUpdatedAt = origin.clientUpdatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(clientUpdatedAt))) throw new Error('La data della scelta del piano non è valida.');
  await updateSnapshot('guest', (snapshot) => ({
    ...snapshot,
    states: { ...snapshot.states, [state.date]: state },
    observedDates: snapshot.observedDates.includes(state.date) ? snapshot.observedDates : [...snapshot.observedDates, state.date],
    guestOrigins: { ...snapshot.guestOrigins, [state.date]: { revision: state.revision, clientUpdatedAt, originalAction } },
  }), [], [], assertCurrent);
}

export async function saveMealPlanCapability(scope: SyncScope, capability: MealPlanCapabilities, assertCurrent?: () => void): Promise<void> {
  const parsed = parseMealPlanCapabilities(capability);
  if (parsed === null) throw new Error('La versione del piano non è supportata.');
  await updateSnapshot(scope, (snapshot) => ({ ...snapshot, capability: parsed }), [], [], assertCurrent);
}

export async function saveMealPlanTimeZone(
  scope: SyncScope,
  timeZone: HouseTimeZoneState,
  assertCurrent?: () => void,
): Promise<void> {
  const parsed = parseHouseTimeZoneState(timeZone);
  if (parsed === null) throw new Error('Il fuso della Casa non è valido.');
  await updateSnapshot(scope, (snapshot) => ({ ...snapshot, timeZone: parsed }), [], [], assertCurrent);
}

export async function saveMealPlanRead(
  scope: SyncScope,
  requestedDates: readonly string[],
  states: readonly { date: string; state: PlanState | null }[],
  timeZone?: HouseTimeZoneState,
  assertCurrent?: () => void,
): Promise<void> {
  const byDate = new Map(states.map((entry) => [entry.date, entry.state]));
  if (requestedDates.length !== states.length || byDate.size !== requestedDates.length
    || requestedDates.some((date) => !byDate.has(date))) throw new Error('La lettura del piano non corrisponde alle date richieste.');
  await updateSnapshot(scope, (snapshot) => {
    const nextStates = { ...snapshot.states };
    for (const date of requestedDates) {
      const state = byDate.get(date) ?? null;
      if (state === null) {
        if (nextStates[date] !== undefined) {
          throw new Error('Il server ha omesso una revisione già presente nella copia locale del piano.');
        }
        continue;
      }
      const previous = nextStates[date];
      if (previous !== undefined && state.serverSequence < previous.serverSequence) continue;
      if (previous !== undefined && state.serverSequence === previous.serverSequence && !samePlanState(previous, state)) {
        throw new Error('Il piano ha restituito due stati diversi con la stessa revisione di lettura.');
      }
      nextStates[date] = state;
    }
    return {
      ...snapshot,
      states: nextStates,
      observedDates: [...new Set([...snapshot.observedDates, ...requestedDates])],
      ...(timeZone === undefined ? {} : { timeZone }),
    };
  }, [], [], assertCurrent);
}

export async function enqueueMealPlanCommand(
  scope: SyncScope,
  command: PlanCommand,
  options: { sourceScope?: SyncScope; sourceRevision?: string; optimisticState?: PlanState; resolvesConflictId?: string } = {},
  assertCurrent?: () => void,
): Promise<void> {
  if (!isPlanCommand(command) || command.scope !== scope) throw new Error('L’operazione del piano non è valida per questo ambito.');
  if (options.optimisticState !== undefined && (!isPlanState(options.optimisticState)
    || options.optimisticState.date !== command.date)) throw new Error('Lo stato provvisorio del piano non è valido.');
  const record: Omit<MealPlanOutboxRecord, 'localOrder'> = {
    mutationId: command.operationId,
    entityType: MEAL_PLAN_ENTITY_TYPE,
    scope,
    command,
    createdAt: new Date().toISOString(),
    ...(options.optimisticState === undefined ? {} : { optimisticState: options.optimisticState }),
    ...(options.sourceScope === undefined ? {} : { sourceScope: options.sourceScope }),
    ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
    ...(options.resolvesConflictId === undefined ? {} : { resolvesConflictId: options.resolvesConflictId }),
  };
  await updateSnapshot(scope, (snapshot, queueValues) => {
    if (options.resolvesConflictId !== undefined && !snapshot.conflicts.some((conflict) => (
      conflict.id === options.resolvesConflictId && conflict.date === command.date
    ))) throw new Error('La modifica in conflitto non è più presente nel Piano.');
    return { ...snapshot, overlays: rebuildMealPlanOverlays(queueValues) };
  }, [record], [], assertCurrent, scope);
}

const commandMatchesPlanState = (command: PlanCommand, state: PlanState | null): boolean => {
  if (state === null) return command.action === 'manual_delete';
  if (command.action === 'manual_set') return state.kind === 'manual' && state.recipeId === command.recipeId;
  if (command.action === 'manual_delete') return state.kind === 'deleted';
  return state.kind === 'automatic' && state.recipeId === command.recipeId;
};

export async function commitMealPlanCommand(
  targetScope: SyncScope,
  queueScope: SyncScope,
  command: PlanCommand,
  receipt: PlanResult,
  current: PlanState | null,
  options: {
    source?: { scope: SyncScope; date: string; revision: string; receiptState: PlanState | null };
    sourceOutbox?: { scope: SyncScope; mutationId: string };
    provenance?: { scope: SyncScope; revision: string };
    resolvesConflictId?: string;
    assertCurrent?: () => void;
  } = {},
): Promise<void> {
  const sourceOutbox = options.sourceOutbox;
  const sourceQueueMatches = sourceOutbox !== undefined
    && sourceOutbox.scope === queueScope && sourceOutbox.mutationId === command.operationId;
  if (!isPlanCommand(command) || (targetScope !== queueScope || sourceOutbox !== undefined) && !sourceQueueMatches || command.scope !== targetScope
    || !isPlanResult(receipt) || receipt.operationId !== command.operationId
    || receipt.current !== null && receipt.current.date !== command.date
    || current !== null && (!isPlanState(current) || current.date !== command.date)) {
    throw new Error('La ricevuta della modifica del Piano non corrisponde all’operazione inviata.');
  }
  if (receipt.outcome === 'applied' && !commandMatchesPlanState(command, receipt.current)) {
    throw new Error('La ricevuta non conferma la scelta richiesta dal Piano.');
  }
  if (receipt.current !== null && (current === null || current.serverSequence < receipt.current.serverSequence
    || current.serverSequence === receipt.current.serverSequence && !samePlanState(current, receipt.current))) {
    throw new Error('La lettura del Piano non conferma la ricevuta del server.');
  }
  if (receipt.current === null && receipt.outcome === 'applied' && command.action !== 'manual_delete') {
    throw new Error('La ricevuta applicata non contiene lo stato della scelta del Piano.');
  }

  const { source, resolvesConflictId } = options;
  const provenance = options.provenance ?? (source === undefined ? undefined : { scope: source.scope, revision: source.revision });
  const now = new Date().toISOString();
  let sourceStillRepresented = source !== undefined && receipt.outcome === 'applied'
    && source.receiptState !== null && receipt.current !== null && current !== null
    && source.receiptState.revision === receipt.current.revision
    && source.receiptState.date === receipt.current.date && source.receiptState.kind === receipt.current.kind
    && source.receiptState.recipeId === receipt.current.recipeId && commandMatchesPlanState(command, receipt.current);
  const targetUpdate: AtomicKeyValueUpdate = {
    key: storageKey(targetScope),
    queueScope: targetScope,
    update: (stored, queueValues) => {
      const snapshot = stored === null ? emptySnapshot() : parseSnapshot(stored);
      if (snapshot === null) throw new Error('I dati locali del piano non sono leggibili in sicurezza.');
      const previousReceipt = snapshot.receipts[command.operationId];
      if (previousReceipt !== undefined && !samePlanResult(previousReceipt, receipt)) {
        throw new Error('Il server ha restituito una ricevuta diversa per un’operazione già confermata.');
      }
      if (resolvesConflictId !== undefined && snapshot.conflicts.some((conflict) => (
        conflict.id === resolvesConflictId && conflict.date !== command.date
      ))) throw new Error('La modifica in conflitto non corrisponde alla data riproposta.');

      const states = { ...snapshot.states };
      if (current === null) {
        if (states[command.date] !== undefined) {
          throw new Error('Il server ha omesso una revisione già presente nella copia locale del piano.');
        }
      } else {
        const previous = states[command.date];
        if (previous !== undefined && previous.serverSequence === current.serverSequence && !samePlanState(previous, current)) {
          throw new Error('Il Piano ha restituito stati diversi con la stessa sequenza.');
        }
        if (previous === undefined || current.serverSequence > previous.serverSequence) states[command.date] = current;
      }
      sourceStillRepresented = sourceStillRepresented && states[command.date]?.revision === receipt.current?.revision;
      const shouldPreserveImport = source !== undefined && receipt.outcome === 'applied' && !sourceStillRepresented;
      let conflicts = snapshot.conflicts;
      if (receipt.outcome === 'conflict' || shouldPreserveImport) {
        conflicts = [
          ...snapshot.conflicts.filter((conflict) => conflict.id !== command.operationId),
          {
            id: command.operationId,
            date: command.date,
            command,
            current,
            savedAt: now,
            ...(provenance === undefined ? {} : { sourceScope: provenance.scope, sourceRevision: provenance.revision }),
          },
        ];
      } else if (receipt.outcome === 'applied' && resolvesConflictId !== undefined) {
        conflicts = snapshot.conflicts.filter((conflict) => conflict.id !== resolvesConflictId);
      }
      const receiptEntries = [...Object.entries(snapshot.receipts).filter(([id]) => id !== receipt.operationId), [receipt.operationId, receipt] as const];
      while (receiptEntries.length > 200) receiptEntries.shift();
      return {
        ...snapshot,
        states,
        overlays: rebuildMealPlanOverlays(queueValues),
        observedDates: snapshot.observedDates.includes(command.date) ? snapshot.observedDates : [...snapshot.observedDates, command.date],
        conflicts,
        receipts: Object.fromEntries(receiptEntries),
      } satisfies MealPlanSnapshot;
    },
  };
  const updates: AtomicKeyValueUpdate[] = [targetUpdate];
  if (source !== undefined) {
    updates.push({
      key: storageKey(source.scope),
      update: (stored) => {
        if (stored === null) return undefined;
        const snapshot = parseSnapshot(stored);
        if (snapshot === null) throw new Error('I dati locali del piano non sono leggibili in sicurezza.');
        const sourceState = snapshot.states[source.date];
        if (!sourceStillRepresented || sourceState?.revision !== source.revision || receipt.current === null
          || sourceState.kind !== receipt.current.kind || sourceState.recipeId !== receipt.current.recipeId) return snapshot;
        const states = { ...snapshot.states };
        delete states[source.date];
        const guestOrigins = { ...snapshot.guestOrigins };
        delete guestOrigins[source.date];
        return {
          ...snapshot,
          states,
          guestOrigins,
          observedDates: snapshot.observedDates.filter((date) => date !== source.date),
        } satisfies MealPlanSnapshot;
      },
    });
  }
  await trackPlanWrite(targetScope, async (assertWritable) => {
    const queueDeletes = sourceOutbox === undefined
      ? [{ mutationId: command.operationId, scope: queueScope }]
      : [{ mutationId: sourceOutbox.mutationId, scope: sourceOutbox.scope }];
    await atomicUpdateKeyValuesAndQueue(updates, [], queueDeletes, assertWritable);
  }, options.assertCurrent);
}

export async function clearMealPlanSnapshot(scope: SyncScope): Promise<void> {
  const clearIfNoPlanOutbox = (stored: unknown, queueValues: readonly unknown[]): unknown => {
    const planCommandPending = queueValues.some((value) => isRecord(value) && value.entityType === MEAL_PLAN_ENTITY_TYPE);
    return planCommandPending ? stored : undefined;
  };
  await atomicUpdateKeyValuesAndQueue([
    { key: storageKey(scope), queueScope: scope, update: clearIfNoPlanOutbox },
    { key: bootstrapStorageKey(scope), queueScope: scope, update: clearIfNoPlanOutbox },
  ]);
}

export function createLocalPlanState(date: string, kind: PlanState['kind'], recipeId: string | null): PlanState {
  const revision = globalThis.crypto?.randomUUID?.();
  if (revision === undefined) throw new Error('Il browser non può creare una revisione sicura per il piano.');
  if (kind === 'deleted') return { date, revision, serverSequence: 0, kind, recipeId: null };
  if (recipeId === null) throw new Error('La ricetta è obbligatoria per questa scelta.');
  return { date, revision, serverSequence: 0, kind, recipeId };
}

export function asPlanScope(scope: SyncScope): SyncMutationScope | null {
  return scope === 'guest' ? null : scope;
}
