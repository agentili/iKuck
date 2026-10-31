import type {
  MealPlanCapabilities,
  PlanCommand,
  PlanResult,
  PlanState,
  HouseTimeZoneState,
  SyncMutationScope,
} from '@ikuck/shared/contracts';
import { assertCivilDate, isValidIanaTimeZone } from './dates';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const isBoundedText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= max;
const isUuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isScope = (value: unknown): value is PlanCommand['scope'] => typeof value === 'string'
  && /^(?:account|house):[^:]{1,128}$/.test(value);
const isDateTime = (value: unknown): value is string => typeof value === 'string'
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const isCivilDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    assertCivilDate(value);
    return true;
  } catch {
    return false;
  }
};

export function isPlanCommand(value: unknown): value is PlanCommand {
  if (!isRecord(value) || value.version !== 2 || !isScope(value.scope) || !isCivilDate(value.date)
    || !isBoundedText(value.operationId, 128) || !isBoundedText(value.deviceId, 128)
    || !isDateTime(value.clientUpdatedAt)) return false;
  const baseKeys = ['version', 'scope', 'date', 'operationId', 'deviceId', 'clientUpdatedAt', 'action'];
  if (value.action === 'manual_set') {
    return hasExactKeys(value, [...baseKeys, 'recipeId']) && isBoundedText(value.recipeId, 128);
  }
  if (value.action === 'manual_delete') return hasExactKeys(value, baseKeys);
  if (value.action === 'auto_create') {
    return hasExactKeys(value, [...baseKeys, 'recipeId', 'baseRevision'])
      && isBoundedText(value.recipeId, 128) && value.baseRevision === null;
  }
  if (value.action === 'explicit_regenerate') {
    return hasExactKeys(value, [...baseKeys, 'recipeId', 'baseRevision'])
      && isBoundedText(value.recipeId, 128) && isUuid(value.baseRevision);
  }
  return false;
}

export function isPlanState(value: unknown): value is PlanState {
  if (!isRecord(value) || !isCivilDate(value.date) || !isUuid(value.revision)
    || !Number.isSafeInteger(value.serverSequence) || (value.serverSequence as number) < 0) return false;
  const baseKeys = ['date', 'revision', 'serverSequence', 'kind', 'recipeId'];
  if (value.kind === 'deleted') return hasExactKeys(value, baseKeys) && value.recipeId === null;
  if (value.kind === 'manual' || value.kind === 'automatic') {
    return hasExactKeys(value, baseKeys) && isBoundedText(value.recipeId, 128);
  }
  return false;
}

export function parseMealPlanCapabilities(value: unknown): MealPlanCapabilities | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'syncReadVersion'])
    || value.version !== 2 || value.syncReadVersion !== 2) return null;
  return { version: 2, syncReadVersion: 2 };
}

export function parseMealPlanReadResponse(
  value: unknown,
  requestedDates: readonly string[],
): { version: 2; states: Array<{ date: string; state: PlanState | null }> } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'states']) || value.version !== 2
    || !Array.isArray(value.states) || value.states.length !== requestedDates.length) return null;
  const requested = new Set(requestedDates);
  const received = new Set<string>();
  const states: Array<{ date: string; state: PlanState | null }> = [];
  for (const entry of value.states) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['date', 'state']) || !isCivilDate(entry.date)
      || !requested.has(entry.date) || received.has(entry.date)
      || entry.state !== null && (!isPlanState(entry.state) || entry.state.date !== entry.date)) return null;
    received.add(entry.date);
    states.push({ date: entry.date, state: entry.state as PlanState | null });
  }
  if (received.size !== requested.size) return null;
  return { version: 2, states };
}

export function parsePlanResult(value: unknown, operationId: string): PlanResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'operationId', 'outcome', 'current'])
    || value.version !== 2 || value.operationId !== operationId
    || (value.outcome !== 'applied' && value.outcome !== 'conflict')
    || value.current !== null && !isPlanState(value.current)) return null;
  return value as unknown as PlanResult;
}

export interface MealPlanSyncPage {
  changes: Array<{ state: PlanState; serverSequence: number }>;
  nextCursor: number;
}

export interface MealPlanImportItem {
  source: 'guest' | 'account';
  sourceId: string;
  localRevision: string;
  command: PlanCommand;
}

export interface MealPlanImportResponse {
  version: 2;
  results: Array<{ sourceId: string; localRevision: string; result: PlanResult }>;
}

export function parseMealPlanSyncPage(
  value: unknown,
  scope: SyncMutationScope,
  cursor: number,
): MealPlanSyncPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ['changes', 'nextCursor'])
    || !Array.isArray(value.changes) || value.changes.length > 200
    || !Number.isSafeInteger(value.nextCursor) || (value.nextCursor as number) < cursor) return null;
  const changes: MealPlanSyncPage['changes'] = [];
  let maximumSequence = cursor;
  for (const entry of value.changes) {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      'mutationId', 'deviceId', 'entityType', 'entityId', 'operation', 'payload',
      'clientUpdatedAt', 'syncScope', 'serverSequence',
    ]) || !isBoundedText(entry.mutationId, 128) || !isBoundedText(entry.deviceId, 128)
      || entry.entityType !== 'meal_plan_entry' || entry.operation !== 'upsert'
      || entry.syncScope !== scope || !isCivilDate(entry.entityId)
      || !isDateTime(entry.clientUpdatedAt) || !Number.isSafeInteger(entry.serverSequence)
      || (entry.serverSequence as number) <= cursor || !isPlanState(entry.payload)
      || entry.payload.date !== entry.entityId || entry.payload.serverSequence !== entry.serverSequence) return null;
    maximumSequence = Math.max(maximumSequence, entry.serverSequence as number);
    changes.push({ state: entry.payload, serverSequence: entry.serverSequence as number });
  }
  if (maximumSequence !== value.nextCursor || (changes.length === 0 && value.nextCursor !== cursor)) return null;
  return { changes, nextCursor: value.nextCursor as number };
}

export function parseMealPlanImportResponse(
  value: unknown,
  scope: SyncMutationScope,
  items: readonly MealPlanImportItem[],
): MealPlanImportResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'results']) || value.version !== 2
    || !Array.isArray(value.results) || value.results.length !== items.length || items.length > 100
    || items.some((item) => (item.source !== 'guest' && item.source !== 'account') || item.command.scope !== scope
      || !isBoundedText(item.sourceId, 128) || !isBoundedText(item.localRevision, 128)
      || !isPlanCommand(item.command))) return null;
  const results: MealPlanImportResponse['results'] = [];
  for (let index = 0; index < value.results.length; index += 1) {
    const entry = value.results[index];
    const expected = items[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ['sourceId', 'localRevision', 'result'])
      || entry.sourceId !== expected?.sourceId || entry.localRevision !== expected.localRevision) return null;
    const result = parsePlanResult(entry.result, expected.command.operationId);
    if (result === null) return null;
    results.push({ sourceId: entry.sourceId, localRevision: entry.localRevision, result });
  }
  return { version: 2, results };
}

export function parseHouseTimeZoneState(value: unknown): HouseTimeZoneState | null {
  if (!isRecord(value) || !hasExactKeys(value, ['timeZone', 'revision'])) return null;
  if (value.timeZone !== null && (typeof value.timeZone !== 'string' || !isValidIanaTimeZone(value.timeZone))) return null;
  if (value.revision !== null && !isUuid(value.revision)) return null;
  if (value.timeZone !== null && value.revision === null) return null;
  return { timeZone: value.timeZone as string | null, revision: value.revision as string | null };
}
