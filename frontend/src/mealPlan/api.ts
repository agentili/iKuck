import type {
  HouseTimeZoneState,
  MealPlanCapabilities,
  PlanCommand,
  PlanResult,
  PlanState,
  SyncMutationScope,
} from '@ikuck/shared/contracts';

export interface MealPlanMigrationProjectionSnapshot {
  [key: string]: unknown;
  entityType: 'meal_plan_entry';
  entityId: string;
  deviceId: string;
  payload: unknown | null;
  deleted: boolean;
  clientUpdatedAt: string;
  serverUpdatedAt: string;
  mutationId: string;
  syncScope?: string;
  serverSequence: number;
}

export interface MealPlanRecoveryConflict {
  id: string;
  sourceAccountId: string;
  targetHouseId: string;
  planDate: string;
  sourceRevision: string;
  sourceProjectionMutationId: string;
  sourceDeviceId: string;
  sourceClientUpdatedAt: string;
  sourceServerUpdatedAt: string;
  sourceState: PlanState | null;
  sourceProjection: MealPlanMigrationProjectionSnapshot | null;
  targetRevisionAtStaging: string;
  targetStateAtStaging: PlanState;
  originalCommand: PlanCommand;
  createdAt: string;
}

export interface MealPlanRecoveryQuarantine {
  planDate: string;
  reasonCode: string;
  sourceSnapshot: { state: PlanState | null; projection: MealPlanMigrationProjectionSnapshot | null };
  targetSnapshot: { state: PlanState | null; projection: MealPlanMigrationProjectionSnapshot | null };
  observed: { manualTuple: null; command: null };
  createdAt: string;
}

export type MealPlanRecoveryEntry = MealPlanRecoveryConflict | MealPlanRecoveryQuarantine;

export interface MealPlanRecoveryResponse {
  version: 2;
  conflicts: MealPlanRecoveryConflict[];
  quarantined: MealPlanRecoveryQuarantine[];
}

export interface MealPlanRecoveryResolution {
  expectedSourceRevision: string;
  expectedTargetRevision: string;
  command: PlanCommand;
}
import { ApiClientError, apiRequest, type ApiRequest } from '../api/apiClient';
import {
  parseHouseTimeZoneState,
  parseMealPlanCapabilities,
  parseMealPlanImportResponse,
  parseMealPlanReadResponse,
  parseMealPlanSyncPage,
  parsePlanResult,
  type MealPlanImportItem,
  type MealPlanImportResponse,
  type MealPlanSyncPage,
} from './validation';

export class MealPlanProtocolError extends Error {
  constructor(message = 'La risposta del piano non è valida.') {
    super(message);
    this.name = 'MealPlanProtocolError';
  }
}

export class MealPlanUnavailableError extends Error {
  constructor() {
    super('Il piano condiviso non è disponibile su questo server.');
    this.name = 'MealPlanUnavailableError';
  }
}

export interface MealPlanApi {
  getCapabilities: () => Promise<MealPlanCapabilities>;
  readSyncPage: (scope: SyncMutationScope, deviceId: string, cursor: number, csrfToken: string) => Promise<MealPlanSyncPage>;
  readStates: (scope: SyncMutationScope, dates: readonly string[], csrfToken: string) => Promise<Array<{ date: string; state: PlanState | null }>>;
  sendCommand: (command: PlanCommand, csrfToken: string) => Promise<PlanResult>;
  importCommands: (scope: SyncMutationScope, items: readonly MealPlanImportItem[], csrfToken: string) => Promise<MealPlanImportResponse>;
  getHouseTimeZone: () => Promise<HouseTimeZoneState>;
  initializeHouseTimeZone: (timeZone: string, csrfToken: string) => Promise<HouseTimeZoneState>;
  updateHouseTimeZone: (timeZone: string | null, expectedRevision: string | null, csrfToken: string) => Promise<HouseTimeZoneState>;
  readRecovery: () => Promise<MealPlanRecoveryResponse>;
  resolveRecovery: (conflictId: string, resolution: MealPlanRecoveryResolution, csrfToken: string) => Promise<PlanResult>;
}

export function createMealPlanApi(request: ApiRequest = apiRequest): MealPlanApi {
  const parseTimeZone = (value: unknown): HouseTimeZoneState => {
    const state = parseHouseTimeZoneState(value);
    if (state === null) throw new MealPlanProtocolError('La risposta del fuso della Casa non è valida.');
    return state;
  };

  const parseRecovery = (value: unknown): MealPlanRecoveryResponse => {
    if (typeof value !== 'object' || value === null) throw new MealPlanProtocolError('La risposta di recovery non è valida.');
    const obj = value as Record<string, unknown>;
    if (obj.version !== 2) throw new MealPlanProtocolError('Versione di recovery non supportata.');
    if (!Array.isArray(obj.conflicts) || !Array.isArray(obj.quarantined)) throw new MealPlanProtocolError('La risposta di recovery non è valida.');
    return obj as unknown as MealPlanRecoveryResponse;
  };

  return {
    getCapabilities: async () => {
      let response: unknown;
      try {
        response = await request<unknown>('/v1/meal-plan/capabilities');
      } catch (error) {
        if (error instanceof ApiClientError && (error.status === 404 || error.code === 'capability_unavailable')) {
          throw new MealPlanUnavailableError();
        }
        throw error;
      }
      const capabilities = parseMealPlanCapabilities(response);
      if (capabilities === null) throw new MealPlanUnavailableError();
      return capabilities;
    },
    readSyncPage: async (scope, deviceId, cursor, csrfToken) => {
      const response = await request<unknown>('/v1/sync', {
        method: 'POST',
        csrfToken,
        body: {
          deviceId,
          cursor,
          syncScope: scope,
          mutations: [],
          supportedEntityTypes: ['meal_plan_entry'],
          mealPlanReadVersion: 2,
        },
      });
      const parsed = parseMealPlanSyncPage(response, scope, cursor);
      if (parsed === null) throw new MealPlanProtocolError('La pagina di sincronizzazione del piano non è valida.');
      return parsed;
    },
    readStates: async (scope, dates, csrfToken) => {
      const response = await request<unknown>('/v1/meal-plan/read', {
        method: 'POST', csrfToken, body: { version: 2, scope, dates },
      });
      const parsed = parseMealPlanReadResponse(response, dates);
      if (parsed === null) throw new MealPlanProtocolError('La risposta del piano non è valida.');
      return parsed.states;
    },
    sendCommand: async (command, csrfToken) => {
      const response = await request<unknown>('/v1/meal-plan/commands', {
        method: 'POST', csrfToken, body: command,
      });
      const result = parsePlanResult(response, command.operationId);
      if (result === null) throw new MealPlanProtocolError('La conferma del piano non è valida.');
      return result;
    },
    importCommands: async (scope, items, csrfToken) => {
      if (items.length < 1 || items.length > 100 || items.some((item) => item.command.scope !== scope)) {
        throw new MealPlanProtocolError('Il lotto di importazione del piano non è valido.');
      }
      const response = await request<unknown>('/v1/meal-plan/import', {
        method: 'POST', csrfToken, body: { version: 2, scope, items },
      });
      const parsed = parseMealPlanImportResponse(response, scope, items);
      if (parsed === null) throw new MealPlanProtocolError('La conferma di importazione del piano non è valida.');
      return parsed;
    },
    getHouseTimeZone: async () => parseTimeZone(await request<unknown>('/v1/house/time-zone')),
    initializeHouseTimeZone: async (timeZone, csrfToken) => parseTimeZone(await request<unknown>('/v1/house/time-zone/initialize', {
      method: 'POST', csrfToken, body: { timeZone },
    })),
    updateHouseTimeZone: async (timeZone, expectedRevision, csrfToken) => parseTimeZone(await request<unknown>('/v1/house/time-zone', {
      method: 'PUT', csrfToken, body: { timeZone, expectedRevision },
    })),
    readRecovery: async () => parseRecovery(await request<unknown>('/v1/meal-plan/recovery')),
    resolveRecovery: async (conflictId, resolution, csrfToken) => {
      const response = await request<unknown>(`/v1/meal-plan/recovery/${conflictId}/resolve`, {
        method: 'POST', csrfToken, body: resolution,
      });
      const result = parsePlanResult(response, resolution.command.operationId);
      if (result === null) throw new MealPlanProtocolError('La conferma di risoluzione non è valida.');
      return result;
    },
  };
}

export const mealPlanApi = createMealPlanApi();
