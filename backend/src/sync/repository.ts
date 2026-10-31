import { DIARY_MAX_RECIPES } from '@ikuck/shared/limits';
import { isDinnerEntry, type DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { HOUSE_SYNC_ENTITY_TYPES } from '@ikuck/shared/contracts';
import type { AiConsent, AiRecipeProvider, CookEvent, DietProfile, DietType, PantryLot, PlanCommand, PlanResult, PlanState, SyncChange, SyncMutation, SyncMutationScope } from '@ikuck/shared/contracts';
import { mergePantryLots, type PantryMergeSummary } from '@ikuck/shared/pantryMerge';
import { planPantryConsumption, type DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import { and, asc, eq, gt, inArray, like, or, sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationDatabase } from '../db/client.js';
import { dinnerConsumptionReceipts, houseMigrationPending, mealPlanMigrationConflicts, mealPlanMigrationQuarantines, mealPlanReceipts, mealPlanStates, processedSyncMutations, houseMemberships, houses, syncItems, users } from '../db/schema.js';
import { isAiConsent } from '../ai/validation.js';
import { isCookEvent } from '../activity/validation.js';
import { isDietProfile } from '../diet/validation.js';
import { isPantryLot } from '../pantry/validation.js';
import {
  assertDinnerConsumptionRequest,
  DinnerConsumptionConflictError,
  type DinnerConsumptionReceipt,
  type DinnerConsumptionRequest,
  type DinnerConsumptionResult,
  type DinnerConsumptionRepository,
} from '../pantry/consumptionService.js';
import { assertStoredSyncMutation, assertSyncMutation } from './validation.js';
import {
  compareManualPlanOrders,
  decidePlanCommand,
  type ManualPlanOrder,
} from '../mealPlan/stateMachine.js';
import {
  PlanCommandRequiredError,
  PlanCommandValidationError,
  PlanOperationIdReusedError,
  PlanRecoveryNotFoundError,
  PlanRecoveryResolutionReusedError,
  PlanRecoveryRevisionConflictError,
  PlanScopeInvalidError,
  assertPlanCommand,
} from '../mealPlan/validation.js';
import { createDispatchCapacityGate, DispatchAbortedError, DispatchCapacityError, type DispatchCapacityGate } from './dispatchCapacity.js';

type ReservedPostgresConnection = Awaited<ReturnType<ApplicationDatabase['db']['$client']['reserve']>>;

const aiConsentDispatchGates = new WeakMap<object, DispatchCapacityGate>();
const aiConsentLockKey = (userId: string): string => `ikuck:ai-consent:${userId}`;

const dispatchGateFor = (client: ApplicationDatabase['db']['$client']): DispatchCapacityGate => {
  const key = client as object;
  const existing = aiConsentDispatchGates.get(key);
  if (existing !== undefined) return existing;
  const gate = createDispatchCapacityGate(client.options.max);
  aiConsentDispatchGates.set(key, gate);
  return gate;
};

export interface StoredSyncItem {
  entityType: SyncMutation['entityType'];
  entityId: string;
  deviceId: string;
  payload: unknown | null;
  deleted: boolean;
  clientUpdatedAt: Date;
  serverUpdatedAt: Date;
  mutationId: string;
  syncScope?: SyncMutation['syncScope'];
  serverSequence: number;
}

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
  syncScope?: SyncMutation['syncScope'];
  serverSequence: number;
}

export interface AppliedSyncMutation {
  applied: boolean;
  change: SyncChange | null;
}

export interface SyncRepositoryLogger {
  warn: (message: string) => void;
}

export interface SyncRepositoryOptions {
  clock?: () => Date;
  logger?: SyncRepositoryLogger;
  maxClientClockSkewMs?: number;
  mealPlanV2Enabled?: boolean;
  scopeResolver?: (userId: string) => Promise<SyncScope | null>;
}

export type SyncScope =
  | { kind: 'user'; id: string }
  | { kind: 'house'; id: string };

export interface MealPlanImportReceipt extends PlanResult {
  sourceAccountId: string;
  source: 'guest' | 'account';
  sourceId: string;
  localRevision: string;
  targetScope: SyncMutationScope;
  commandDigest: string;
}

export interface MealPlanMigrationConflict {
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

interface StoredMealPlanMigrationConflict extends MealPlanMigrationConflict {
  status: 'pending' | 'resolved';
  resolutionDigest: string | null;
  resolutionCommand: PlanCommand | null;
  resolutionResult: PlanResult | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
}

interface StoredMealPlanMigrationQuarantine {
  id: string;
  sourceAccountId: string;
  targetHouseId: string;
  planDate: string;
  reasonCode: string;
  fingerprint: string;
  rawSourceState: unknown | null;
  rawSourceProjection: unknown | null;
  rawTargetState: unknown | null;
  rawTargetProjection: unknown | null;
  createdAt: string;
}

export interface MealPlanMigrationQuarantineView {
  planDate: string;
  reasonCode: string;
  sourceSnapshot: { state: PlanState | null; projection: MealPlanMigrationProjectionSnapshot | null };
  targetSnapshot: { state: PlanState | null; projection: MealPlanMigrationProjectionSnapshot | null };
  observed: { manualTuple: ManualPlanOrder | null; command: PlanCommand | null };
  createdAt: string;
}

export type MealPlanRecoveryEntry = MealPlanMigrationConflict | MealPlanMigrationQuarantineView;

const publicMealPlanMigrationConflict = (conflict: StoredMealPlanMigrationConflict): MealPlanMigrationConflict => ({
  id: conflict.id,
  sourceAccountId: conflict.sourceAccountId,
  targetHouseId: conflict.targetHouseId,
  planDate: conflict.planDate,
  sourceRevision: conflict.sourceRevision,
  sourceProjectionMutationId: conflict.sourceProjectionMutationId,
  sourceDeviceId: conflict.sourceDeviceId,
  sourceClientUpdatedAt: conflict.sourceClientUpdatedAt,
  sourceServerUpdatedAt: conflict.sourceServerUpdatedAt,
  sourceState: conflict.sourceState === null ? null : structuredClone(conflict.sourceState),
  sourceProjection: conflict.sourceProjection === null ? null : structuredClone(conflict.sourceProjection),
  targetRevisionAtStaging: conflict.targetRevisionAtStaging,
  targetStateAtStaging: conflict.targetStateAtStaging,
  originalCommand: conflict.originalCommand,
  createdAt: conflict.createdAt,
});

type MealPlanRecoveryResolution = {
  expectedSourceRevision: string;
  expectedTargetRevision: string;
  command: PlanCommand;
};

type MealPlanImportBinding = Omit<MealPlanImportReceipt, keyof PlanResult>;

type StoredMealPlanReceipt = {
  requestDigest: string;
  commandDigest: string;
  command: PlanCommand;
  binding: MealPlanImportBinding | null;
  result: PlanResult;
};

type ResolvedSyncRepositoryOptions = Required<SyncRepositoryOptions> & {
  scopeResolverConfigured: boolean;
};


export class SyncScopeInvalidError extends Error {
  readonly code = 'sync_scope_invalid';
  readonly status = 409;

  constructor() {
    super('The requested sync scope is not valid for this entity');
    this.name = 'SyncScopeInvalidError';
  }
}

export class SyncDiaryRecipeLimitError extends Error {
  readonly code = 'sync_recipe_limit';
  readonly status = 409;
  constructor() { super('Dinner entry already has the maximum number of linked recipes'); this.name = 'SyncDiaryRecipeLimitError'; }
}

export class AiConsentRequiredError extends Error {
  readonly code = 'ai_consent_required';
  readonly status = 403;

  constructor() {
    super('Global AI consent must be enabled before granting Dinner consent');
    this.name = 'AiConsentRequiredError';
  }
}

export class AiConsentRevisionRequiredError extends Error {
  readonly code = 'ai_consent_revision_required';
  readonly status = 428;

  constructor() {
    super('A current AI consent revision is required for grants');
    this.name = 'AiConsentRevisionRequiredError';
  }
}

export class AiConsentRevisionConflictError extends Error {
  readonly code = 'ai_consent_revision_conflict';
  readonly status = 409;

  constructor() {
    super('AI consent changed; refresh the current consent before granting');
    this.name = 'AiConsentRevisionConflictError';
  }
}

export const DEFAULT_AI_CONSENT_REVISION = '1970-01-01T00:00:00.000Z';

export interface AiConsentUpdate {
  enabled?: boolean;
  homeProvider?: AiRecipeProvider | null;
  dinnerProvider?: AiRecipeProvider | null;
  chatProvider?: AiRecipeProvider | null;
  chatPolicyVersion?: 'chef-chat-v1';
  expectedRevision?: string;
}

export type AiConsentDispatchRequirement =
  | { kind: 'home'; provider: AiRecipeProvider }
  | { kind: 'dinner'; provider: AiRecipeProvider }
  | { kind: 'chat'; provider: AiRecipeProvider; policyVersion: 'chef-chat-v1' };

const isDiaryEntityType = (entityType: SyncMutation['entityType']): boolean =>
  entityType === 'dinner_entry' || entityType === 'saved_recipe';

const diaryAuthorId = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null || !('authorId' in payload)) return null;
  const authorId = (payload as { authorId?: unknown }).authorId;
  return typeof authorId === 'string' ? authorId : null;
};

const normalizeDiaryMutation = (
  userId: string,
  mutation: SyncMutation,
  existing: StoredSyncItem | null,
): SyncMutation => {
  if (!isDiaryEntityType(mutation.entityType)) return mutation;
  if (existing === null) {
    return {
      ...mutation,
      payload: mutation.operation === 'delete'
        ? { authorId: userId }
        : { ...(mutation.payload as Record<string, unknown>), authorId: userId },
    };
  }
  const authorId = diaryAuthorId(existing.payload);
  const payload = mutation.operation === 'delete'
    ? existing.payload ?? { authorId }
    : { ...(mutation.payload as Record<string, unknown>), authorId };
  if (mutation.entityType === 'dinner_entry' && mutation.operation === 'upsert' && !existing.deleted
    && isDinnerEntry(existing.payload) && isDinnerEntry(payload)) {
    const recipes = [...existing.payload.recipes];
    const linkedIds = new Set(recipes.map((recipe) => recipe.recipeId));
    for (const recipe of payload.recipes) {
      if (linkedIds.has(recipe.recipeId)) continue;
      if (recipes.length >= DIARY_MAX_RECIPES) throw new SyncDiaryRecipeLimitError();
      recipes.push(recipe);
      linkedIds.add(recipe.recipeId);
    }
    return { ...mutation, payload: { ...payload, recipes } };
  }
  return { ...mutation, payload };
};

const mergeStaleDinnerRecipeLinks = (mutation: SyncMutation, existing: StoredSyncItem): SyncMutation | null => {
  if (existing.deleted || mutation.entityType !== 'dinner_entry' || mutation.operation !== 'upsert'
    || !isDinnerEntry(existing.payload) || !isDinnerEntry(mutation.payload)) return null;
  const existingIds = new Set(existing.payload.recipes.map((recipe) => recipe.recipeId));
  const newLinks = mutation.payload.recipes.filter((recipe) => !existingIds.has(recipe.recipeId));
  if (newLinks.length === 0) return null;
  if (existing.payload.recipes.length + newLinks.length > DIARY_MAX_RECIPES) throw new SyncDiaryRecipeLimitError();
  return {
    ...mutation,
    payload: { ...existing.payload, recipes: [...existing.payload.recipes, ...newLinks] },
    clientUpdatedAt: existing.clientUpdatedAt.toISOString(),
  };
};

const DIET_RESTRICTION_RANK: Readonly<Record<DietType, number>> = {
  omnivore: 0,
  pescatarian: 1,
  vegetarian: 2,
  vegan: 3,
};

const lowerNonNull = (left: number | null, right: number | null): number | null => {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
};

const higherNonNull = (left: number | null, right: number | null): number | null => {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
};

const mergeDietProfiles = (left: unknown, right: unknown): DietProfile | null => {
  if (!isDietProfile(left) || !isDietProfile(right)) return null;
  const diet = DIET_RESTRICTION_RANK[left.diet] >= DIET_RESTRICTION_RANK[right.diet]
    ? left.diet
    : right.diet;
  return {
    diet,
    excludedAllergens: [...new Set([...left.excludedAllergens, ...right.excludedAllergens])].sort(),
    nutrition: {
      maxCaloriesPerServing: lowerNonNull(
        left.nutrition.maxCaloriesPerServing,
        right.nutrition.maxCaloriesPerServing,
      ),
      minProteinGramsPerServing: higherNonNull(
        left.nutrition.minProteinGramsPerServing,
        right.nutrition.minProteinGramsPerServing,
      ),
    },
    updatedAt: Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left.updatedAt : right.updatedAt,
  };
};

const shouldPreserveLiveHouseDietProfile = (
  entityType: string,
  incomingDeleted: boolean,
  existing: StoredSyncItem | null,
): boolean => entityType === 'diet_profile' && incomingDeleted && existing !== null && !existing.deleted;

const SHARED_ENTITY_TYPES: ReadonlySet<SyncMutation['entityType']> = new Set([
  ...HOUSE_SYNC_ENTITY_TYPES,
]);
const AUTO_MIGRATED_ENTITY_TYPES: ReadonlySet<SyncMutation['entityType']> = SHARED_ENTITY_TYPES;

export const isSharedEntityType = (entityType: SyncMutation['entityType']): boolean => SHARED_ENTITY_TYPES.has(entityType);

export const DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class SyncMembershipRequiredError extends Error {
  readonly code = 'house_membership_required';
  readonly status = 403;

  constructor() {
    super('House membership is required for shared data');
    this.name = 'SyncMembershipRequiredError';
  }
}

export class HouseMigrationPendingError extends Error {
  readonly code = 'house_migration_pending';
  readonly status = 503;
  readonly retryAfterSeconds = 1;

  constructor() {
    super('House data migration is pending; retry via GET /v1/house');
    this.name = 'HouseMigrationPendingError';
  }
}

export class PlanMigrationQuarantinedError extends Error {
  readonly code = 'plan_migration_quarantined';
  readonly status = 409;

  constructor() {
    super('The meal-plan date is quarantined by a migration decision pending product disposition');
    this.name = 'PlanMigrationQuarantinedError';
  }
}

export interface SyncRepository extends DinnerConsumptionRepository {
  applyMutation: (userId: string, mutation: SyncMutation) => Promise<AppliedSyncMutation>;
  applyMealPlanCommand: (userId: string, command: PlanCommand) => Promise<PlanResult>;
  importMealPlanCommand: (
    userId: string,
    source: 'guest' | 'account',
    sourceId: string,
    localRevision: string,
    command: PlanCommand,
  ) => Promise<MealPlanImportReceipt>;
  readMealPlanStates: (userId: string, scope: SyncMutationScope, dates: readonly string[]) => Promise<{
    version: 2;
    states: Array<{ date: string; state: PlanState | null }>;
  }>;
  readMealPlanRecovery: (userId: string) => Promise<MealPlanRecoveryEntry[]>;
  resolveMealPlanRecovery: (userId: string, conflictId: string, resolution: MealPlanRecoveryResolution) => Promise<PlanResult>;
  isMealPlanV2Enabled: () => Promise<boolean>;
  updateAiConsent: (userId: string, update: AiConsentUpdate) => Promise<AiConsent>;
  withAiConsentDispatch: <T>(
    userId: string,
    requirement: AiConsentDispatchRequirement,
    dispatch: (consent: AiConsent) => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readChanges: (userId: string, cursor: number, limit: number, requestedScope?: SyncMutation['syncScope'], supportedEntityTypes?: readonly SyncMutation['entityType'][]) => Promise<SyncChange[]>;
  readAll: (userId: string) => Promise<SyncChange[]>;
  readEntity: (userId: string, entityType: SyncMutation['entityType'], entityId: string) => Promise<StoredSyncItem | null>;
  migrateUserSharedDataToHouse: (userId: string, houseId: string, pendingAccountMutations?: readonly SyncMutation[]) => Promise<void>;
  readHouseMigrationPending: (userId: string) => Promise<{ houseId: string } | null>;
  setHouseMigrationPending: (userId: string, houseId: string) => Promise<void>;
  clearHouseMigrationPending: (userId: string) => Promise<void>;
  mergeUserPantryToHouse: (userId: string, houseId: string) => Promise<PantryMergeSummary>;
  mergeGuestPantryToHouse: (userId: string, houseId: string, input: {
    deviceId: string;
    lots: PantryLot[];
    stapleIds: string[];
  }) => Promise<PantryMergeSummary>;
  mergeGuestDietProfileToHouse: (userId: string, houseId: string, mutation: SyncMutation) => Promise<boolean>;
}

const scopeKey = (scope: SyncScope): string => `${scope.kind}:${scope.id}`;
const userScope = (userId: string): SyncScope => ({ kind: 'user', id: userId });

const applyAiConsentUpdate = (
  current: AiConsent | null,
  update: AiConsentUpdate,
  updatedAt: string,
): AiConsent => {
  const requestsHomeGrant = update.homeProvider !== undefined && update.homeProvider !== null;
  const requestsDinnerGrant = update.dinnerProvider !== undefined && update.dinnerProvider !== null;
  const requestsChatGrant = update.chatProvider !== undefined && update.chatProvider !== null;
  if (requestsHomeGrant && update.enabled !== true && !current?.enabled) {
    throw new AiConsentRequiredError();
  }
  if (requestsDinnerGrant && (update.enabled === false || !current?.enabled)) {
    throw new AiConsentRequiredError();
  }
  if (requestsChatGrant && (update.enabled === false || (update.enabled !== true && !current?.enabled) || update.chatPolicyVersion !== 'chef-chat-v1')) {
    throw new AiConsentRequiredError();
  }

  const enabled = update.enabled ?? current?.enabled ?? false;
  const homeProvider = !enabled || update.homeProvider === null
    ? undefined
    : update.homeProvider ?? (current?.enabled ? current.homeProvider : undefined);
  const dinnerProvider = !enabled || update.dinnerProvider === null
    ? undefined
    : update.dinnerProvider ?? (current?.enabled ? current.dinnerProvider : undefined);
  const chatProvider = !enabled || update.chatProvider === null
    ? undefined
    : update.chatProvider ?? (current?.enabled ? current.chatProvider : undefined);
  const chatPolicyVersion = chatProvider === undefined ? undefined
    : requestsChatGrant ? update.chatPolicyVersion : current?.chatPolicyVersion;
  return {
    enabled,
    updatedAt,
    ...(homeProvider === undefined ? {} : { homeProvider }),
    ...(dinnerProvider === undefined ? {} : { dinnerProvider }),
    ...(chatProvider === undefined ? {} : { chatProvider }),
    ...(chatPolicyVersion === undefined ? {} : { chatPolicyVersion }),
  };
};

const isAiConsentGrant = (update: AiConsentUpdate): boolean => update.enabled === true
  || (update.homeProvider !== undefined && update.homeProvider !== null)
  || (update.dinnerProvider !== undefined && update.dinnerProvider !== null)
  || (update.chatProvider !== undefined && update.chatProvider !== null);

const currentConsentFromItem = (item: StoredSyncItem | null): AiConsent | null => (
  item !== null && !item.deleted && isAiConsent(item.payload) ? item.payload : null
);

const consentRevisionFromItem = (item: StoredSyncItem | null, current: AiConsent | null): string => (
  current?.updatedAt ?? item?.serverUpdatedAt.toISOString() ?? DEFAULT_AI_CONSENT_REVISION
);

const assertCurrentConsentRevision = (update: AiConsentUpdate, currentRevision: string): void => {
  if (update.enabled === true && (update.homeProvider === undefined || update.homeProvider === null)
    && (update.chatProvider === undefined || update.chatProvider === null)) {
    throw new AiConsentRevisionRequiredError();
  }
  if (!isAiConsentGrant(update)) return;
  if (update.expectedRevision === undefined) throw new AiConsentRevisionRequiredError();
  if (update.expectedRevision !== currentRevision) throw new AiConsentRevisionConflictError();
};

const nextConsentTimestamp = (clock: () => Date, currentRevision: string): Date => new Date(Math.max(
  clock().getTime(),
  Date.parse(currentRevision) + 1,
));

const createKeyedLock = () => {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
};

// Account-queue replay is a distinct authenticated import, never a normal
// shared sync write. A forged foreign/personal scope cannot enter migration.
const validatePendingAccountMutations = (userId: string, mutations: readonly SyncMutation[]): SyncMutation[] => mutations.map((mutation) => {
  if (mutation.entityType === 'meal_plan_entry') throw new PlanCommandRequiredError();
  const valid = assertSyncMutation(mutation);
  if (!isSharedEntityType(valid.entityType) || valid.syncScope !== `account:${userId}`) throw new SyncScopeInvalidError();
  return valid;
});

const validateGuestDietProfileMutation = (mutation: SyncMutation): SyncMutation => {
  const valid = assertSyncMutation(mutation);
  if (valid.entityType !== 'diet_profile' || valid.entityId !== 'profile' || valid.operation !== 'upsert'
    || valid.syncScope !== undefined || !isDietProfile(valid.payload)) throw new SyncScopeInvalidError();
  return valid;
};

const pantryItemPayload = (value: unknown): value is { id: string; label: string; known: boolean } => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.known === 'boolean';
};

const storedPantryLot = (item: StoredSyncItem): PantryLot | null => {
  if (item.deleted) return null;
  if (item.entityType === 'pantry_lot' && typeof item.payload === 'object' && item.payload !== null) {
    const candidate = item.payload as PantryLot;
    if (typeof candidate.id === 'string' && typeof candidate.ingredientId === 'string'
      && typeof candidate.label === 'string' && typeof candidate.known === 'boolean'
      && (candidate.quantity === null || typeof candidate.quantity === 'number')
      && (candidate.unit === null || typeof candidate.unit === 'string')
      && (candidate.expiresAt === null || typeof candidate.expiresAt === 'string')
      && typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string') {
      return candidate;
    }
  }
  if (item.entityType !== 'pantry_item' || !pantryItemPayload(item.payload)) return null;
  const timestamp = item.clientUpdatedAt.toISOString();
  return {
    id: `legacy:${item.entityId}`,
    ingredientId: item.payload.id,
    label: item.payload.label,
    known: item.payload.known,
    quantity: null,
    unit: null,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const pantryItemTypes = new Set<SyncMutation['entityType']>(['pantry_item', 'pantry_lot']);
const pantryTypes = new Set<SyncMutation['entityType']>(['pantry_item', 'pantry_lot', 'staple_preference']);

const lotFingerprint = (lot: PantryLot): string => JSON.stringify({
  ingredientId: lot.ingredientId,
  label: lot.label,
  known: lot.known,
  quantity: lot.quantity,
  unit: lot.unit,
  expiresAt: lot.expiresAt,
  createdAt: lot.createdAt,
  updatedAt: lot.updatedAt,
});

const guestMarkerPrefixForItem = (item: Pick<StoredSyncItem, 'entityType' | 'entityId' | 'deviceId'>): string | null => {
  if (item.entityType === 'pantry_lot' || item.entityType === 'pantry_item') return `guest:${item.deviceId}:pantry_lot:${item.entityId}:`;
  if (item.entityType === 'staple_preference') return `guest:${item.deviceId}:staple_preference:${item.entityId}:`;
  return null;
};

const guestMarkerForItem = (item: StoredSyncItem): string | null => {
  const prefix = guestMarkerPrefixForItem(item);
  if (prefix === null) return null;
  if (item.entityType === 'pantry_lot' || item.entityType === 'pantry_item') {
    const lot = storedPantryLot(item);
    return lot === null ? null : `${prefix}${lotFingerprint(lot)}`;
  }
  return `${prefix}${JSON.stringify(item.payload)}`;
};

const guestMarkerForLot = (deviceId: string, lot: PantryLot): string =>
  `guest:${deviceId}:pantry_lot:${lot.id}:${lotFingerprint(lot)}`;

const entityPayloadEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const entityMatches = (
  row: StoredSyncItem | undefined,
  entityType: SyncMutation['entityType'],
  entityId: string,
  payload: unknown,
): boolean => row !== undefined
  && !row.deleted
  && row.entityType === entityType
  && row.entityId === entityId
  && entityPayloadEqual(row.payload, payload);

const lotRevisionTime = (value: string): number => Date.parse(value);

const latestLotsById = (lots: readonly PantryLot[]): PantryLot[] => {
  const distinct = new Map<string, PantryLot>();
  for (const lot of lots) {
    const current = distinct.get(lot.id);
    const nextTime = lotRevisionTime(lot.updatedAt);
    const currentTime = current === undefined ? Number.NEGATIVE_INFINITY : lotRevisionTime(current.updatedAt);
    if (current === undefined || nextTime > currentTime || (nextTime === currentTime && lot.updatedAt >= current.updatedAt)) {
      distinct.set(lot.id, lot);
    }
  }
  return [...distinct.values()];
};

const lotGroupKey = (lot: PantryLot): string => {
  const ingredient = lot.known
    ? `known:${lot.ingredientId}`
    : `custom:${lot.label.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[’']/g, ' ').replace(/[^a-zA-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()}`;
  return `${ingredient}|${lot.expiresAt ?? 'none'}`;
};

const unitFamily = (unit: PantryLot['unit']): 'mass' | 'volume' | 'piece' | 'pack' | null => {
  if (unit === 'g' || unit === 'kg') return 'mass';
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'piece') return 'piece';
  if (unit === 'pack') return 'pack';
  return null;
};

const unitFactor = (unit: PantryLot['unit']): number => {
  if (unit === 'kg' || unit === 'l') return 1000;
  return 1;
};

const sameLotGroup = (left: PantryLot, right: PantryLot): boolean => lotGroupKey(left) === lotGroupKey(right)
  && (left.quantity === null || left.unit === null || right.quantity === null || right.unit === null
    || unitFamily(left.unit) === unitFamily(right.unit));

const removeLotContribution = (existing: PantryLot, contribution: PantryLot): PantryLot | null => {
  if (existing.quantity === null || existing.unit === null || contribution.quantity === null || contribution.unit === null) return existing;
  if (unitFamily(existing.unit) !== unitFamily(contribution.unit)) return existing;
  const remaining = existing.quantity * unitFactor(existing.unit) - contribution.quantity * unitFactor(contribution.unit);
  if (remaining <= 0) return null;
  return { ...existing, quantity: remaining / unitFactor(existing.unit) };
};

const encodedMarkerPart = (value: string): string => Buffer.from(value, 'utf8').toString('hex');

const userSourceLotMarkerPrefix = (
  userId: string,
  deviceId: string,
  entityType: SyncMutation['entityType'],
  entityId: string,
): string => `user-source:${encodedMarkerPart(userId)}:${encodedMarkerPart(deviceId)}:${encodedMarkerPart(entityType)}:${encodedMarkerPart(entityId)}:`;

const userSourceLotMarkerForLot = (
  userId: string,
  deviceId: string,
  entityType: SyncMutation['entityType'],
  entityId: string,
  lot: PantryLot,
): string => `${userSourceLotMarkerPrefix(userId, deviceId, entityType, entityId)}${lotFingerprint(lot)}`;

const userSourceLotMarkerForItem = (userId: string, item: StoredSyncItem): string | null => {
  if (!pantryItemTypes.has(item.entityType)) return null;
  const lot = storedPantryLot(item);
  return lot === null ? null : userSourceLotMarkerForLot(userId, item.deviceId, item.entityType, item.entityId, lot);
};

const latestUserSourceLotRevision = (
  markers: readonly string[],
  userId: string,
  deviceId: string,
  entityType: SyncMutation['entityType'],
  entityId: string,
): PantryLot | null => {
  const prefix = userSourceLotMarkerPrefix(userId, deviceId, entityType, entityId);
  const lotId = entityType === 'pantry_item' ? `legacy:${entityId}` : entityId;
  const revisions = markers.flatMap((marker) => {
    if (!marker.startsWith(prefix)) return [];
    try {
      const value = JSON.parse(marker.slice(prefix.length)) as Record<string, unknown>;
      const candidate = { ...value, id: lotId };
      return isPantryLot(candidate) ? [candidate] : [];
    } catch {
      return [];
    }
  });
  return latestLotsById(revisions)[0] ?? null;
};

interface AccountSourceLotRevision {
  deleted: boolean;
  clientUpdatedAt: string;
  serverUpdatedAt: string;
  deviceId: string;
  mutationId: string;
  lot: PantryLot | null;
}

const accountSourceLotMarkerPrefix = (
  userId: string,
  entityType: SyncMutation['entityType'],
  entityId: string,
): string => `account-source:${encodedMarkerPart(userId)}:${encodedMarkerPart(entityType)}:${encodedMarkerPart(entityId)}:`;

const accountSourceLotRevisionMarkerForItem = (
  userId: string,
  item: StoredSyncItem,
  previous: AccountSourceLotRevision | null,
): string | null => {
  if (!pantryItemTypes.has(item.entityType)) return null;
  const lot = item.deleted
    ? previous?.deleted === false ? previous.lot : null
    : storedPantryLot(item);
  return `${accountSourceLotMarkerPrefix(userId, item.entityType, item.entityId)}${JSON.stringify({
    deleted: item.deleted,
    clientUpdatedAt: item.clientUpdatedAt.toISOString(),
    serverUpdatedAt: item.serverUpdatedAt.toISOString(),
    deviceId: item.deviceId,
    mutationId: item.mutationId,
    lot,
  } satisfies AccountSourceLotRevision)}`;
};

const latestAccountSourceLotRevision = (
  markers: readonly string[],
  userId: string,
  entityType: SyncMutation['entityType'],
  entityId: string,
): AccountSourceLotRevision | null => {
  const prefix = accountSourceLotMarkerPrefix(userId, entityType, entityId);
  const revisions = markers.flatMap((marker) => {
    if (!marker.startsWith(prefix)) return [];
    try {
      const value = JSON.parse(marker.slice(prefix.length)) as Record<string, unknown>;
      if (typeof value.deleted !== 'boolean' || typeof value.clientUpdatedAt !== 'string'
        || !Number.isFinite(Date.parse(value.clientUpdatedAt)) || typeof value.serverUpdatedAt !== 'string'
        || !Number.isFinite(Date.parse(value.serverUpdatedAt)) || typeof value.deviceId !== 'string'
        || typeof value.mutationId !== 'string' || (value.lot !== null && !isPantryLot(value.lot))) return [];
      return [value as unknown as AccountSourceLotRevision];
    } catch {
      return [];
    }
  });
  return revisions.sort((left, right) => Date.parse(right.clientUpdatedAt) - Date.parse(left.clientUpdatedAt)
    || Date.parse(right.serverUpdatedAt) - Date.parse(left.serverUpdatedAt)
    || right.deviceId.localeCompare(left.deviceId) || right.mutationId.localeCompare(left.mutationId))[0] ?? null;
};

const accountSourceRevisionWins = (item: StoredSyncItem, existing: AccountSourceLotRevision): boolean => {
  const incomingClientTime = item.clientUpdatedAt.getTime();
  const existingClientTime = Date.parse(existing.clientUpdatedAt);
  if (incomingClientTime !== existingClientTime) return incomingClientTime > existingClientTime;
  const incomingServerTime = item.serverUpdatedAt.getTime();
  const existingServerTime = Date.parse(existing.serverUpdatedAt);
  if (incomingServerTime !== existingServerTime) return incomingServerTime > existingServerTime;
  if (item.deviceId !== existing.deviceId) return item.deviceId > existing.deviceId;
  return item.mutationId > existing.mutationId;
};

const rekeyCollidingLots = (
  existingLots: readonly PantryLot[],
  incomingLots: readonly PantryLot[],
  sourcePrefix: string,
): PantryLot[] => {
  const usedIds = new Set(existingLots.map((lot) => lot.id));
  const distinctIncoming = latestLotsById(incomingLots);
  return distinctIncoming.map((lot) => {
    let id = lot.id;
    if (usedIds.has(id)) {
      id = `${sourcePrefix}:${lot.id}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${sourcePrefix}:${lot.id}:${suffix++}`;
    }
    usedIds.add(id);
    return id === lot.id ? lot : { ...lot, id };
  });
};

const entityForMergedLot = (lot: PantryLot, now: Date, houseId: string): StoredSyncItem => ({
  entityType: 'pantry_lot',
  entityId: lot.id,
  deviceId: 'house-pantry-merge',
  payload: lot,
  deleted: false,
  clientUpdatedAt: new Date(lot.updatedAt),
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:pantry_lot:${lot.id}`,
  syncScope: `house:${houseId}`,
  serverSequence: 0,
});

const entityForTombstone = (
  entityType: SyncMutation['entityType'],
  entityId: string,
  now: Date,
  houseId: string,
): StoredSyncItem => ({
  entityType,
  entityId,
  deviceId: 'house-pantry-merge',
  payload: null,
  deleted: true,
  clientUpdatedAt: now,
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:delete:${entityType}:${entityId}`,
  syncScope: `house:${houseId}`,
  serverSequence: 0,
});

const entityForMergedStaple = (stapleId: string, now: Date, houseId: string): StoredSyncItem => ({
  entityType: 'staple_preference',
  entityId: stapleId,
  deviceId: 'house-pantry-merge',
  payload: { enabled: true },
  deleted: false,
  clientUpdatedAt: now,
  serverUpdatedAt: now,
  mutationId: `house-pantry-merge:staple_preference:${stapleId}`,
  syncScope: `house:${houseId}`,
  serverSequence: 0,
});

const isPlanStatePayload = (payload: unknown): payload is PlanState => {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.date === 'string'
    && typeof candidate.revision === 'string'
    && typeof candidate.serverSequence === 'number'
    && Number.isSafeInteger(candidate.serverSequence)
    && (candidate.kind === 'automatic' || candidate.kind === 'manual' || candidate.kind === 'deleted')
    && (candidate.kind === 'deleted' ? candidate.recipeId === null : typeof candidate.recipeId === 'string');
};

const createPlanState = (
  date: string,
  revision: string,
  serverSequence: number,
  kind: string,
  recipeId: string | null | undefined,
): PlanState => {
  if (kind === 'deleted' && recipeId === null) return { date, revision, serverSequence, kind: 'deleted', recipeId: null };
  if ((kind === 'automatic' || kind === 'manual') && typeof recipeId === 'string') {
    return { date, revision, serverSequence, kind, recipeId };
  }
  throw new Error('Meal-plan state is inconsistent');
};

const planStateFromSyncItem = (item: StoredSyncItem | null): PlanState | null => {
  if (item === null || item.deleted || item.entityType !== 'meal_plan_entry' || !isPlanStatePayload(item.payload)) return null;
  return { ...item.payload, serverSequence: item.serverSequence };
};

const manualPlanOrderFromStateRow = (
  row: typeof mealPlanStates.$inferSelect | null | undefined,
): ManualPlanOrder | null => row === null || row === undefined
  || row.manualClientAt === null || row.manualServerAt === null
  || row.manualDeviceId === null || row.manualOperationId === null
  ? null
  : {
    clientUpdatedAt: row.manualClientAt.toISOString(),
    serverUpdatedAt: row.manualServerAt.toISOString(),
    deviceId: row.manualDeviceId,
    operationId: row.manualOperationId,
  };

const planStateFromDatabaseRow = (
  row: typeof mealPlanStates.$inferSelect,
  serverSequence: number,
): PlanState => createPlanState(row.planDate, row.revision, serverSequence, row.kind, row.recipeId);

const planCommandDigest = (command: PlanCommand): string => createHash('sha256')
  .update(canonicalJson(command))
  .digest('hex');

const planRecoveryResolutionDigest = (resolution: MealPlanRecoveryResolution): string => createHash('sha256')
  .update(canonicalJson(resolution))
  .digest('hex');

const mealPlanMigrationConflictKey = (houseId: string, userId: string, date: string, revision: string): string =>
  JSON.stringify([houseId, userId, date, revision]);

const manualPlanCommandFromMigration = (
  scope: SyncMutationScope,
  date: string,
  kind: 'manual' | 'deleted',
  recipeId: string | null,
  order: ManualPlanOrder,
): PlanCommand => assertPlanCommand(kind === 'deleted' ? {
  version: 2,
  scope,
  date,
  operationId: order.operationId,
  deviceId: order.deviceId,
  clientUpdatedAt: order.clientUpdatedAt,
  action: 'manual_delete',
} : {
  version: 2,
  scope,
  date,
  operationId: order.operationId,
  deviceId: order.deviceId,
  clientUpdatedAt: order.clientUpdatedAt,
  action: 'manual_set',
  recipeId,
});

const planScopeType = (scope: SyncScope): 'user' | 'house' => scope.kind === 'house' ? 'house' : 'user';

const entityScopeFor = (scope: SyncScope, key: string): boolean => key.startsWith(`${scopeKey(scope)}:`);

const entityIdFromKey = (key: string): string => key.slice(key.lastIndexOf(':') + 1);

const entityKey = (scope: SyncScope, entityType: SyncMutation['entityType'], entityId: string): string =>
  `${scopeKey(scope)}:${entityType}:${entityId}`;

const isPostgresUniqueViolation = (value: unknown): boolean => typeof value === 'object' && value !== null
  && 'code' in value && (value as { code?: unknown }).code === '23505';

export const resolveScopeForCurrentMembership = (
  userId: string,
  entityType: SyncMutation['entityType'],
  currentHouseId: string | null,
  requestedScope?: SyncMutation['syncScope'],
): SyncScope => {
  const isShared = isSharedEntityType(entityType);
  if (requestedScope === undefined) {
    return isShared && currentHouseId !== null ? { kind: 'house', id: currentHouseId } : userScope(userId);
  }
  if (requestedScope === `account:${userId}`) {
    if (isShared && currentHouseId !== null) throw new SyncScopeInvalidError();
    return userScope(userId);
  }
  if (requestedScope.startsWith('house:')) {
    if (!isShared) throw new SyncScopeInvalidError();
    if (currentHouseId === null || requestedScope !== `house:${currentHouseId}`) {
      throw new SyncMembershipRequiredError();
    }
    return { kind: 'house', id: currentHouseId };
  }
  throw new SyncMembershipRequiredError();
};

const resolveEntityScope = async (
  userId: string,
  entityType: SyncMutation['entityType'],
  options: ResolvedSyncRepositoryOptions,
  requestedScope?: SyncMutation['syncScope'],
): Promise<SyncScope | null> => {
  const currentScope = options.scopeResolverConfigured ? await options.scopeResolver(userId) : null;
  return resolveScopeForCurrentMembership(
    userId,
    entityType,
    currentScope?.kind === 'house' ? currentScope.id : null,
    requestedScope,
  );
};

const resolveReadScopes = async (
  userId: string,
  options: ResolvedSyncRepositoryOptions,
  requestedScope?: SyncMutation['syncScope'],
): Promise<ResolvedReadScopes> => {
  const activeScope = options.scopeResolverConfigured ? await options.scopeResolver(userId) : null;
  const currentHouse = activeScope?.kind === 'house' ? activeScope : null;
  if (requestedScope === `account:${userId}`) return { scopes: [userScope(userId)], currentHouse, mode: 'account' };
  if (requestedScope?.startsWith('account:')) throw new SyncMembershipRequiredError();
  if (requestedScope?.startsWith('house:')) {
    if (currentHouse?.kind !== 'house' || requestedScope !== `house:${currentHouse.id}`) throw new SyncMembershipRequiredError();
    return { scopes: [currentHouse], currentHouse, mode: 'house' };
  }
  return currentHouse === null
    ? { scopes: [userScope(userId)], currentHouse: null, mode: 'account' }
    : { scopes: [userScope(userId), currentHouse], currentHouse, mode: 'composite' };
};

interface PreparedMutation {
  mutation: SyncMutation;
  serverUpdatedAt: Date;
}

const resolveOptions = (options: SyncRepositoryOptions): ResolvedSyncRepositoryOptions => ({
  clock: options.clock ?? (() => new Date()),
  logger: options.logger ?? { warn: (message) => console.warn(message) },
  maxClientClockSkewMs: options.maxClientClockSkewMs ?? DEFAULT_MAX_CLIENT_CLOCK_SKEW_MS,
  mealPlanV2Enabled: options.mealPlanV2Enabled ?? false,
  scopeResolver: options.scopeResolver ?? (async () => null),
  scopeResolverConfigured: options.scopeResolver !== undefined,
});

const prepareMutation = (mutation: SyncMutation, options: ResolvedSyncRepositoryOptions): PreparedMutation => {
  const validMutation = assertStoredSyncMutation(mutation);
  if (validMutation.entityType === 'ai_consent' && validMutation.operation === 'upsert'
    && isAiConsent(validMutation.payload) && (validMutation.payload.dinnerProvider !== undefined
      || validMutation.payload.chatProvider !== undefined)) {
    throw new AiConsentRequiredError();
  }
  const serverUpdatedAt = options.clock();
  const clientUpdatedAt = new Date(validMutation.clientUpdatedAt);
  const isFutureSkewed = clientUpdatedAt.getTime() > serverUpdatedAt.getTime() + options.maxClientClockSkewMs;
  if (isFutureSkewed) options.logger.warn('Sync client timestamp exceeded the configured clock skew tolerance');

  return {
    mutation: isFutureSkewed
      ? { ...validMutation, clientUpdatedAt: serverUpdatedAt.toISOString() }
      : validMutation,
    serverUpdatedAt,
  };
};

const toChange = (item: StoredSyncItem): SyncChange => ({
  mutationId: item.mutationId,
  deviceId: item.deviceId,
  entityType: item.entityType,
  entityId: item.entityId,
  operation: item.deleted ? 'delete' : 'upsert',
  payload: item.deleted ? null : item.payload,
  clientUpdatedAt: item.clientUpdatedAt.toISOString(),
  syncScope: item.syncScope,
  serverSequence: item.serverSequence,
});

const mealPlanProjectionSnapshot = (item: StoredSyncItem): MealPlanMigrationProjectionSnapshot => ({
  entityType: 'meal_plan_entry',
  entityId: item.entityId,
  deviceId: item.deviceId,
  payload: structuredClone(item.payload),
  deleted: item.deleted,
  clientUpdatedAt: item.clientUpdatedAt.toISOString(),
  serverUpdatedAt: item.serverUpdatedAt.toISOString(),
  mutationId: item.mutationId,
  ...(item.syncScope === undefined ? {} : { syncScope: item.syncScope }),
  serverSequence: item.serverSequence,
});

type ReadScopeMode = 'account' | 'house' | 'composite';

interface ResolvedReadScopes {
  scopes: SyncScope[];
  currentHouse: SyncScope | null;
  mode: ReadScopeMode;
}

const scopeLabel = (scope: SyncScope): SyncMutationScope => `${scope.kind === 'house' ? 'house' : 'account'}:${scope.id}`;
const dinnerEntryKey = (scope: SyncScope, entryId: string): string => `${scopeKey(scope)}:${entryId}`;
const pantryScopeLockKey = (scope: SyncScope): string => `ikuck:pantry:${scopeKey(scope)}`;
const consumptionProcessedMutationId = (operationId: string): string => `dinner-consumption:${operationId}`;

const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== 'object' || item === null) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
};

const jsonSnapshot = (value: unknown): unknown => value === null
  ? null
  : JSON.parse(JSON.stringify(value)) as unknown;

const mealPlanMigrationQuarantineFingerprint = (value: {
  sourceAccountId: string;
  targetHouseId: string;
  planDate: string;
  reasonCode: string;
  rawSourceState: unknown | null;
  rawSourceProjection: unknown | null;
  rawTargetState: unknown | null;
  rawTargetProjection: unknown | null;
}): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

const createMealPlanImportBinding = (
  sourceAccountId: string,
  source: 'guest' | 'account',
  sourceId: string,
  localRevision: string,
  command: PlanCommand,
): MealPlanImportBinding => {
  if ((source !== 'guest' && source !== 'account')
    || typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 128
    || typeof localRevision !== 'string' || localRevision.length < 1 || localRevision.length > 128) {
    throw new PlanCommandValidationError();
  }
  return {
    sourceAccountId,
    source,
    sourceId,
    localRevision,
    targetScope: command.scope,
    commandDigest: planCommandDigest(command),
  };
};

const planImportRequestDigest = (binding: MealPlanImportBinding): string => createHash('sha256')
  .update(canonicalJson(binding))
  .digest('hex');

const verifiedAutomaticMigrationCommand = (
  receipt: StoredMealPlanReceipt | undefined,
  userId: string,
  sourceState: PlanState,
  sourceProjection: StoredSyncItem,
): PlanCommand | null => {
  if (receipt === undefined || sourceState.kind !== 'automatic') return null;
  let command: PlanCommand;
  try {
    command = assertPlanCommand(receipt.command);
  } catch {
    return null;
  }
  const digest = planCommandDigest(command);
  const provesReceipt = receipt.binding === null
    ? receipt.requestDigest === digest && receipt.commandDigest === digest
    : receipt.binding.sourceAccountId === userId
      && receipt.binding.targetScope === `account:${userId}`
      && receipt.binding.commandDigest === digest
      && receipt.requestDigest === planImportRequestDigest(receipt.binding)
      && receipt.commandDigest === digest;
  const resultState = receipt.result.current;
  if (!provesReceipt
    || command.scope !== `account:${userId}`
    || command.date !== sourceState.date
    || command.operationId !== sourceProjection.mutationId
    || command.deviceId !== sourceProjection.deviceId
    || (command.action !== 'auto_create' && command.action !== 'explicit_regenerate')
    || receipt.result.outcome !== 'applied'
    || receipt.result.operationId !== command.operationId
    || resultState === null
    || canonicalJson(resultState) !== canonicalJson(sourceState)
    || sourceProjection.entityType !== 'meal_plan_entry'
    || sourceProjection.entityId !== sourceState.date
    || sourceProjection.deleted
    || sourceProjection.syncScope !== `account:${userId}`) return null;
  return structuredClone(command);
};

const planReceiptKey = (scope: SyncScope, actorId: string, operationId: string): string =>
  JSON.stringify([scope.kind, scope.id, actorId, operationId]);

const planImportProvenanceKey = (scope: SyncScope, actorId: string, binding: MealPlanImportBinding): string =>
  JSON.stringify([scope.kind, scope.id, actorId, binding.source, binding.sourceId, binding.localRevision]);

const mealPlanImportReceipt = (stored: StoredMealPlanReceipt): MealPlanImportReceipt => {
  if (stored.binding === null) throw new PlanOperationIdReusedError();
  return { ...structuredClone(stored.result), ...structuredClone(stored.binding) };
};

const dinnerConsumptionRequestDigest = (request: DinnerConsumptionRequest): string => createHash('sha256')
  .update(canonicalJson({
    command: {
      operationId: request.command.operationId,
      entryId: request.command.entryId,
      servings: request.command.servings,
      ingredients: request.command.ingredients,
    },
    entry: request.entry,
    cookEvent: request.cookEvent ?? null,
  }))
  .digest('hex');

const pantrySnapshotFromStoredItems = (items: readonly StoredSyncItem[]): DinnerConsumptionResult['pantrySnapshot'] => {
  const lots = items.map(storedPantryLot).filter((lot): lot is PantryLot => lot !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
  const pantryItems = new Map<string, { id: string; label: string; known: boolean }>();
  for (const lot of lots) {
    if (!pantryItems.has(lot.ingredientId)) pantryItems.set(lot.ingredientId, {
      id: lot.ingredientId,
      label: lot.label,
      known: lot.known,
    });
  }
  const stapleIds = items.filter((item) => item.entityType === 'staple_preference' && !item.deleted
    && typeof item.payload === 'object' && item.payload !== null
    && (item.payload as { enabled?: unknown }).enabled === true)
    .map((item) => item.entityId).sort();
  return { pantryItems: [...pantryItems.values()], stapleIds, pantryLots: lots };
};

const wins = (incoming: PreparedMutation, existing: StoredSyncItem): boolean => {
  const incomingTime = new Date(incoming.mutation.clientUpdatedAt).getTime();
  const existingTime = existing.clientUpdatedAt.getTime();
  if (incomingTime !== existingTime) return incomingTime > existingTime;

  const incomingServerTime = incoming.serverUpdatedAt.getTime();
  const existingServerTime = existing.serverUpdatedAt.getTime();
  if (incomingServerTime !== existingServerTime) return incomingServerTime > existingServerTime;
  if (incoming.mutation.deviceId !== existing.deviceId) return incoming.mutation.deviceId > existing.deviceId;
  return incoming.mutation.mutationId > existing.mutationId;
};

export const createMemorySyncRepository = (repositoryOptions: SyncRepositoryOptions = {}): SyncRepository & {
  readEntity: SyncRepository['readEntity'];
} => {
  const options = resolveOptions(repositoryOptions);
  const entities = new Map<string, StoredSyncItem>();
  const processed = new Set<string>();
  const dinnerReceiptsByOperation = new Map<string, { receipt: DinnerConsumptionReceipt; requestDigest: string }>();
  const dinnerOperationByEntry = new Map<string, string>();
  const planReceipts = new Map<string, StoredMealPlanReceipt>();
  const planImportReceiptsByProvenance = new Map<string, StoredMealPlanReceipt>();
  const planManualOrders = new Map<string, ManualPlanOrder>();
  const mealPlanRecoveryConflicts = new Map<string, StoredMealPlanMigrationConflict>();
  const mealPlanRecoveryBySource = new Map<string, string>();
  const mealPlanRecoveryQuarantines = new Map<string, StoredMealPlanMigrationQuarantine>();
  const houseMigrationPending = new Map<string, { houseId: string; createdAt: Date }>();
  const withPantryLock = createKeyedLock();
  const withMealPlanLock = createKeyedLock();
  let sequence = 0;

  const mergeMemoryPantry = (
    userId: string,
    houseId: string,
    incomingLots: readonly PantryLot[],
    incomingStaples: readonly string[],
    sourceRows: readonly [string, StoredSyncItem][],
    markerIds: readonly string[],
    sourcePrefix: string,
  ): PantryMergeSummary => {
    const houseScope: SyncScope = { kind: 'house', id: houseId };
    const accountSourceUserId = sourcePrefix.startsWith('user:') ? userId : null;
    const sourceRowsAfterExactDedup = sourceRows.map(([key, item]) => {
      const marker = userSourceLotMarkerForItem(userId, item);
      return marker !== null && processed.has(`${scopeKey(houseScope)}:${marker}`)
        ? [key, { ...item, deleted: true }] as [string, StoredSyncItem]
        : [key, item] as [string, StoredSyncItem];
    });
    const houseRows = [...entities.entries()].filter(([key]) => entityScopeFor(houseScope, key));
    const housePantryRows = houseRows.filter(([, item]) => pantryTypes.has(item.entityType));
    const existingLots = housePantryRows
      .filter(([, item]) => pantryItemTypes.has(item.entityType))
      .map(([, item]) => storedPantryLot(item))
      .filter((lot): lot is PantryLot => lot !== null);
    const existingStaples = housePantryRows
      .filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted
        && typeof item.payload === 'object' && item.payload !== null
        && (item.payload as { enabled?: unknown }).enabled === true)
      .map(([, item]) => item.entityId);
    const supersededExistingIds = new Set<string>();
    const houseProcessedPrefix = `${scopeKey(houseScope)}:`;
    const houseProcessedMarkers = [...processed]
      .filter((processedKey) => processedKey.startsWith(houseProcessedPrefix))
      .map((processedKey) => processedKey.slice(houseProcessedPrefix.length));
    let existingLotsForMerge = existingLots;
    const sourceRowsForMerge = sourceRowsAfterExactDedup.map(([key, item]) => {
      const sourceLot = storedPantryLot(item);
      const accountPriorRevision = accountSourceUserId === null ? null
        : latestAccountSourceLotRevision(houseProcessedMarkers, userId, item.entityType, item.entityId);
      if (accountPriorRevision !== null) {
        if (!accountSourceRevisionWins(item, accountPriorRevision)) {
          return [key, { ...item, deleted: true }] as [string, StoredSyncItem];
        }
        if (!accountPriorRevision.deleted && accountPriorRevision.lot !== null) {
          const canonical = existingLotsForMerge.find((lot) => sameLotGroup(lot, accountPriorRevision.lot!));
          if (canonical !== undefined) {
            const remaining = removeLotContribution(canonical, accountPriorRevision.lot);
            existingLotsForMerge = remaining === null
              ? existingLotsForMerge.filter((lot) => lot.id !== canonical.id)
              : existingLotsForMerge.map((lot) => lot.id === canonical.id ? remaining : lot);
          }
        }
        return [key, item] as [string, StoredSyncItem];
      }
      const priorRevision = latestUserSourceLotRevision(houseProcessedMarkers, userId, item.deviceId, item.entityType, item.entityId);
      if (priorRevision !== null) {
        if (sourceLot !== null && lotRevisionTime(sourceLot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) {
          return [key, { ...item, deleted: true }] as [string, StoredSyncItem];
        }
        const canonical = existingLotsForMerge.find((lot) => sameLotGroup(lot, priorRevision));
        if (canonical !== undefined) {
          const remaining = removeLotContribution(canonical, priorRevision);
          existingLotsForMerge = remaining === null
            ? existingLotsForMerge.filter((lot) => lot.id !== canonical.id)
            : existingLotsForMerge.map((lot) => lot.id === canonical.id ? remaining : lot);
        }
        return [key, item] as [string, StoredSyncItem];
      }
      return [key, item] as [string, StoredSyncItem];
    });
    existingLotsForMerge = existingLotsForMerge.filter((lot) => !supersededExistingIds.has(lot.id));
    const sourceLots = sourceRowsForMerge
      .filter(([, item]) => pantryItemTypes.has(item.entityType))
      .map(([, item]) => storedPantryLot(item))
      .filter((lot): lot is PantryLot => lot !== null);
    const sourceStaples = sourceRowsForMerge
      .filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted
        && typeof item.payload === 'object' && item.payload !== null
        && (item.payload as { enabled?: unknown }).enabled === true)
      .map(([, item]) => item.entityId);
    const sourceDeviceId = sourcePrefix.startsWith('guest:') ? sourcePrefix.slice('guest:'.length) : null;
    const revisionAwareIncomingLots = latestLotsById(incomingLots).filter((lot) => {
      const previous = existingLots.find((candidate) => candidate.id === lot.id);
      const priorRevision = sourceDeviceId === null ? null
        : latestUserSourceLotRevision(houseProcessedMarkers, userId, sourceDeviceId, 'pantry_lot', lot.id);
      const hasPriorRevision = sourceDeviceId !== null && houseProcessedMarkers
        .some((processedMarker) => processedMarker.startsWith(userSourceLotMarkerPrefix(userId, sourceDeviceId, 'pantry_lot', lot.id)));
      if (!hasPriorRevision) return true;
      if (priorRevision !== null) {
        if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) return false;
        const priorCandidate = existingLotsForMerge.find((candidate) => sameLotGroup(candidate, priorRevision));
        if (priorCandidate !== undefined) {
          const adjusted = removeLotContribution(priorCandidate, priorRevision);
          existingLotsForMerge = adjusted === null
            ? existingLotsForMerge.filter((candidate) => candidate.id !== priorCandidate.id)
            : existingLotsForMerge.map((candidate) => candidate.id === priorCandidate.id ? adjusted : candidate);
        } else if (previous !== undefined) {
          supersededExistingIds.add(previous.id);
          existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
        }
        return true;
      }
      if (previous === undefined) return true;
      if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(previous.updatedAt)) return false;
      supersededExistingIds.add(previous.id);
      existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
      return true;
    });
    const incomingForMerge = rekeyCollidingLots(existingLotsForMerge, [...sourceLots, ...revisionAwareIncomingLots], sourcePrefix);
    const mergedLots = mergePantryLots(existingLotsForMerge, incomingForMerge);
    const stapleIds = [...new Set([...existingStaples, ...sourceStaples, ...incomingStaples])];
    const now = options.clock();
    const currentLotsById = new Map(housePantryRows
      .filter(([, item]) => item.entityType === 'pantry_lot' && !item.deleted)
      .map(([key, item]) => [entityIdFromKey(key), item]));
    const currentStaples = housePantryRows.filter(([, item]) => item.entityType === 'staple_preference' && !item.deleted);
    const lotsUnchanged = currentLotsById.size === mergedLots.lots.length
      && mergedLots.lots.every((lot) => entityMatches(currentLotsById.get(lot.id), 'pantry_lot', lot.id, lot));
    const staplesUnchanged = currentStaples.length === stapleIds.length
      && stapleIds.every((id) => entityMatches(
        currentStaples.find(([key]) => entityIdFromKey(key) === id)?.[1],
        'staple_preference',
        id,
        { enabled: true },
      ));

    if (!lotsUnchanged || !staplesUnchanged) {
      for (const [key] of houseRows.filter(([, item]) => pantryTypes.has(item.entityType))) entities.delete(key);
      const finalKeys = new Set([
        ...mergedLots.lots.map((lot) => `pantry_lot:${lot.id}`),
        ...stapleIds.map((id) => `staple_preference:${id}`),
      ]);
      for (const [, previous] of housePantryRows) {
        const previousKey = `${previous.entityType}:${previous.entityId}`;
        if (finalKeys.has(previousKey)) continue;
        const item = entityForTombstone(previous.entityType, previous.entityId, now, houseId);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, previous.entityType, previous.entityId), item);
      }
      for (const lot of mergedLots.lots) {
        const item = entityForMergedLot(lot, now, houseId);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, 'pantry_lot', lot.id), item);
      }
      for (const stapleId of stapleIds) {
        const item = entityForMergedStaple(stapleId, now, houseId);
        item.serverSequence = ++sequence;
        entities.set(entityKey(houseScope, 'staple_preference', stapleId), item);
      }
    }

    for (const [key] of sourceRows) entities.delete(key);
    const accountRevisionMarkers = accountSourceUserId === null ? [] : sourceRows
      .map(([, item]) => accountSourceLotRevisionMarkerForItem(
        userId,
        item,
        latestAccountSourceLotRevision(houseProcessedMarkers, userId, item.entityType, item.entityId),
      ))
      .filter((marker): marker is string => marker !== null);
    const userSourceMarkers = [
      ...sourceRows.map(([, item]) => userSourceLotMarkerForItem(userId, item)),
      ...(sourceDeviceId === null ? [] : revisionAwareIncomingLots.map((lot) => userSourceLotMarkerForLot(
        userId, sourceDeviceId, 'pantry_lot', lot.id, lot,
      ))),
    ].filter((marker): marker is string => marker !== null);
    for (const markerId of [...markerIds, ...accountRevisionMarkers, ...userSourceMarkers]) {
      processed.add(`${scopeKey(houseScope)}:${markerId}`);
    }
    void userId;
    return {
      ...mergedLots.summary,
      importedStaples: incomingStaples.filter((id) => !existingStaples.includes(id)).length
        + sourceStaples.filter((id) => !existingStaples.includes(id)).length,
    };
  };

  const resolveMemoryPlanScope = async (userId: string, requestedScope: SyncMutationScope): Promise<SyncScope> => {
    const activeHouse = options.scopeResolverConfigured ? await options.scopeResolver(userId) : null;
    if (requestedScope === `account:${userId}`) {
      if (activeHouse !== null) throw new PlanScopeInvalidError();
      return userScope(userId);
    }
    if (requestedScope.startsWith('account:')) throw new PlanScopeInvalidError();
    if (activeHouse === null) throw new SyncMembershipRequiredError();
    if (activeHouse.kind !== 'house') throw new SyncMembershipRequiredError();
    const requestedHouseId = requestedScope.slice('house:'.length);
    if (activeHouse.id !== requestedHouseId) throw new PlanScopeInvalidError();
    return activeHouse;
  };

  const withConsentLock = createKeyedLock();

  const runMemoryMealPlanCommandInScope = async (
    userId: string,
    command: PlanCommand,
    scope: SyncScope,
    importBinding: MealPlanImportBinding | null = null,
  ): Promise<{ result: PlanResult; importReceipt?: MealPlanImportReceipt }> => {
    const scopeLabelValue = scopeLabel(scope);
    if (importBinding !== null && importBinding.targetScope !== scopeLabelValue) throw new PlanScopeInvalidError();
    const commandDigest = planCommandDigest(command);
    const binding = importBinding === null ? null : { ...importBinding, commandDigest };
    const requestDigest = binding === null ? commandDigest : planImportRequestDigest(binding);
    const receiptKey = planReceiptKey(scope, userId, command.operationId);
    const previousReceipt = planReceipts.get(receiptKey);
    if (previousReceipt !== undefined) {
      if (previousReceipt.requestDigest !== requestDigest) throw new PlanOperationIdReusedError();
      return binding === null
        ? { result: structuredClone(previousReceipt.result) }
        : { result: structuredClone(previousReceipt.result), importReceipt: mealPlanImportReceipt(previousReceipt) };
    }
    const provenanceKey = binding === null ? null : planImportProvenanceKey(scope, userId, binding);
    const previousImportReceipt = provenanceKey === null ? undefined : planImportReceiptsByProvenance.get(provenanceKey);
    if (previousImportReceipt !== undefined) {
      if (previousImportReceipt.requestDigest !== requestDigest) throw new PlanOperationIdReusedError();
      return { result: structuredClone(previousImportReceipt.result), importReceipt: mealPlanImportReceipt(previousImportReceipt) };
    }

    const planKey = `${scopeKey(scope)}:${command.date}`;
    const key = entityKey(scope, 'meal_plan_entry', command.date);
    const current = planStateFromSyncItem(entities.get(key) ?? null);
    const now = options.clock();
    const originalClientTime = Date.parse(command.clientUpdatedAt);
    const normalizedClientUpdatedAt = originalClientTime > now.getTime() + options.maxClientClockSkewMs
      ? now.toISOString()
      : new Date(originalClientTime).toISOString();
    if (normalizedClientUpdatedAt !== new Date(originalClientTime).toISOString()) {
      options.logger.warn('Meal-plan client timestamp exceeded the configured clock skew tolerance');
    }
    const serverUpdatedAt = now.toISOString();
    const decision = decidePlanCommand(
      current,
      planManualOrders.get(planKey) ?? null,
      command,
      normalizedClientUpdatedAt,
      serverUpdatedAt,
    );
    let resolvedState = current;
    if (decision.applies) {
      const nextState = createPlanState(command.date, randomUUID(), ++sequence, decision.kind ?? '', decision.recipeId);
      const item: StoredSyncItem = {
        entityType: 'meal_plan_entry',
        entityId: command.date,
        deviceId: command.deviceId,
        payload: nextState,
        deleted: false,
        clientUpdatedAt: new Date(normalizedClientUpdatedAt),
        serverUpdatedAt: now,
        mutationId: command.operationId,
        syncScope: scopeLabelValue,
        serverSequence: nextState.serverSequence,
      };
      entities.set(key, item);
      if (decision.nextManualOrder !== undefined) planManualOrders.set(planKey, decision.nextManualOrder);
      resolvedState = nextState;
    }
    const result: PlanResult = {
      version: 2,
      operationId: command.operationId,
      outcome: decision.applies ? 'applied' : 'conflict',
      current: resolvedState,
    };
    const storedReceipt: StoredMealPlanReceipt = {
      requestDigest,
      commandDigest,
      command: structuredClone(command),
      binding: binding === null ? null : structuredClone(binding),
      result: structuredClone(result),
    };
    planReceipts.set(receiptKey, storedReceipt);
    if (provenanceKey !== null) planImportReceiptsByProvenance.set(provenanceKey, storedReceipt);
    return binding === null
      ? { result }
      : { result, importReceipt: mealPlanImportReceipt(storedReceipt) };
  };

  const runMemoryMealPlanCommand = async (
    userId: string,
    command: PlanCommand,
    importBinding: MealPlanImportBinding | null = null,
  ): Promise<{ result: PlanResult; importReceipt?: MealPlanImportReceipt }> => {
    const initialScope = await resolveMemoryPlanScope(userId, command.scope);
    return withMealPlanLock(scopeKey(initialScope), async () => {
      const scope = await resolveMemoryPlanScope(userId, command.scope);
      if (scopeKey(scope) !== scopeKey(initialScope)) throw new PlanScopeInvalidError();
      return runMemoryMealPlanCommandInScope(userId, command, scope, importBinding);
    });
  };
  return {
    isMealPlanV2Enabled: async () => true,
    applyMealPlanCommand: async (userId, rawCommand) =>
      (await runMemoryMealPlanCommand(userId, assertPlanCommand(rawCommand))).result,
    importMealPlanCommand: async (userId, source, sourceId, localRevision, rawCommand) => {
      const command = assertPlanCommand(rawCommand);
      const binding = createMealPlanImportBinding(userId, source, sourceId, localRevision, command);
      const committed = await runMemoryMealPlanCommand(userId, command, binding);
      if (committed.importReceipt === undefined) throw new PlanOperationIdReusedError();
      return committed.importReceipt;
    },
    readMealPlanStates: async (userId, requestedScope, dates) => {
      const initialScope = await resolveMemoryPlanScope(userId, requestedScope);
      return withMealPlanLock(scopeKey(initialScope), async () => {
        const scope = await resolveMemoryPlanScope(userId, requestedScope);
        if (scopeKey(scope) !== scopeKey(initialScope)) throw new PlanScopeInvalidError();
        const pending = houseMigrationPending.get(userId);
        if (pending !== undefined) throw new HouseMigrationPendingError();
        if (scope.kind === 'house' && dates.length > 0) {
          const quarantined = [...mealPlanRecoveryQuarantines.values()].some((quarantine) =>
            quarantine.sourceAccountId === userId
              && quarantine.targetHouseId === scope.id
              && dates.includes(quarantine.planDate),
          );
          if (quarantined) throw new PlanMigrationQuarantinedError();
        }
        return {
          version: 2,
          states: dates.map((date) => ({
            date,
            state: planStateFromSyncItem(entities.get(entityKey(scope, 'meal_plan_entry', date)) ?? null),
          })),
        };
      });
    },
    readMealPlanRecovery: async (userId) => {
      const initialScope = options.scopeResolverConfigured ? await options.scopeResolver(userId) : null;
      if (initialScope?.kind !== 'house') throw new SyncMembershipRequiredError();
      return withMealPlanLock(scopeKey(initialScope), async () => {
        const currentScope = await options.scopeResolver(userId);
        if (currentScope?.kind !== 'house' || scopeKey(currentScope) !== scopeKey(initialScope)) {
          throw new SyncMembershipRequiredError();
        }
        const conflicts = [...mealPlanRecoveryConflicts.values()]
          .filter((conflict) => conflict.status === 'pending' && conflict.targetHouseId === currentScope.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.planDate.localeCompare(right.planDate))
          .map((conflict) => structuredClone(publicMealPlanMigrationConflict(conflict)));
        const quarantines = [...mealPlanRecoveryQuarantines.values()]
          .filter((quarantine) => quarantine.sourceAccountId === userId && quarantine.targetHouseId === currentScope.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.planDate.localeCompare(right.planDate))
          .map((quarantine): MealPlanMigrationQuarantineView => ({
            planDate: quarantine.planDate,
            reasonCode: quarantine.reasonCode,
            sourceSnapshot: {
              state: quarantine.rawSourceState as PlanState | null,
              projection: quarantine.rawSourceProjection as MealPlanMigrationProjectionSnapshot | null,
            },
            targetSnapshot: {
              state: quarantine.rawTargetState as PlanState | null,
              projection: quarantine.rawTargetProjection as MealPlanMigrationProjectionSnapshot | null,
            },
            observed: { manualTuple: null, command: null },
            createdAt: quarantine.createdAt,
          }));
        return [...conflicts, ...quarantines].sort(
          (left, right) => left.createdAt.localeCompare(right.createdAt) || left.planDate.localeCompare(right.planDate),
        );
      });
    },
    resolveMealPlanRecovery: async (userId, conflictId, resolution) => {
      const command = assertPlanCommand(resolution.command);
      if (command.action !== 'manual_set' && command.action !== 'manual_delete') throw new PlanCommandValidationError();
      const initialScope = options.scopeResolverConfigured ? await options.scopeResolver(userId) : null;
      if (initialScope?.kind !== 'house') throw new SyncMembershipRequiredError();
      return withMealPlanLock(scopeKey(initialScope), async () => {
        const currentScope = await options.scopeResolver(userId);
        if (currentScope?.kind !== 'house' || scopeKey(currentScope) !== scopeKey(initialScope)) {
          throw new SyncMembershipRequiredError();
        }
        const conflict = mealPlanRecoveryConflicts.get(conflictId);
        if (conflict === undefined || conflict.targetHouseId !== currentScope.id) throw new PlanRecoveryNotFoundError();
        if (command.scope !== `house:${currentScope.id}` || command.date !== conflict.planDate) throw new PlanCommandValidationError();
        const digest = planRecoveryResolutionDigest({ ...resolution, command });
        if (conflict.status === 'resolved') {
          if (conflict.resolutionDigest !== digest || conflict.resolutionResult === null) {
            throw new PlanRecoveryResolutionReusedError();
          }
          return structuredClone(conflict.resolutionResult);
        }
        if (resolution.expectedSourceRevision !== conflict.sourceRevision) throw new PlanRecoveryRevisionConflictError();
        const currentState = planStateFromSyncItem(entities.get(entityKey(currentScope, 'meal_plan_entry', conflict.planDate)) ?? null);
        if (currentState === null || currentState.revision !== resolution.expectedTargetRevision) {
          throw new PlanRecoveryRevisionConflictError();
        }
        const resolvedAt = options.clock().toISOString();
        const result = (await runMemoryMealPlanCommandInScope(userId, command, currentScope)).result;
        if (result.outcome === 'applied') {
          mealPlanRecoveryConflicts.set(conflictId, {
            ...conflict,
            status: 'resolved',
            resolutionDigest: digest,
            resolutionCommand: structuredClone(command),
            resolutionResult: structuredClone(result),
            resolvedByUserId: userId,
            resolvedAt,
          });
        }
        return result;
      });
    },
    updateAiConsent: async (userId, update) => withConsentLock(userId, async () => {
      const scope = userScope(userId);
      const key = entityKey(scope, 'ai_consent', 'profile');
      const existing = entities.get(key) ?? null;
      const current = currentConsentFromItem(existing);
      const currentRevision = consentRevisionFromItem(existing, current);
      assertCurrentConsentRevision(update, currentRevision);
      const now = nextConsentTimestamp(options.clock, currentRevision);
      const consent = applyAiConsentUpdate(current, update, now.toISOString());
      const mutationId = randomUUID();
      const item: StoredSyncItem = {
        entityType: 'ai_consent',
        entityId: 'profile',
        deviceId: 'api-ai-recipes',
        payload: consent,
        deleted: false,
        clientUpdatedAt: now,
        serverUpdatedAt: now,
        mutationId,
        syncScope: `account:${userId}`,
        serverSequence: ++sequence,
      };
      processed.add(`${scopeKey(scope)}:${mutationId}`);
      entities.set(key, item);
      return consent;
    }),
    withAiConsentDispatch: async (userId, requirement, dispatch, signal) => withConsentLock(userId, async () => {
      if (signal?.aborted) throw new DispatchAbortedError();
      const item = entities.get(entityKey(userScope(userId), 'ai_consent', 'profile')) ?? null;
      const current = currentConsentFromItem(item);
      if (current === null || !current.enabled
        || (requirement.kind === 'home' && current.homeProvider !== requirement.provider)
        || (requirement.kind === 'dinner' && current.dinnerProvider !== requirement.provider)
        || (requirement.kind === 'chat' && (current.chatProvider !== requirement.provider || current.chatPolicyVersion !== requirement.policyVersion))) {
        throw new AiConsentRequiredError();
      }
      return dispatch(current);
    }),
    consumeDinner: async (userId, request) => {
      assertDinnerConsumptionRequest(request);
      const requestedScope = request.command.scope as Exclude<DinnerConsumptionCommand['scope'], 'guest'>;
      const initialScope = await resolveEntityScope(userId, 'pantry_lot', options, requestedScope);
      if (initialScope === null) throw new SyncMembershipRequiredError();
      return withPantryLock(scopeKey(initialScope), async () => {
        const scope = await resolveEntityScope(userId, 'pantry_lot', options, requestedScope);
        if (scope === null || scopeKey(scope) !== scopeKey(initialScope)) throw new SyncMembershipRequiredError();
        const requestDigest = dinnerConsumptionRequestDigest(request);
        const priorOperationId = dinnerOperationByEntry.get(dinnerEntryKey(scope, request.command.entryId));
        const prior = dinnerReceiptsByOperation.get(request.command.operationId)
          ?? (priorOperationId === undefined ? undefined : dinnerReceiptsByOperation.get(priorOperationId));
        if (prior !== undefined) {
          if (prior.receipt.operationId !== request.command.operationId
            || prior.receipt.entryId !== request.command.entryId
            || prior.receipt.scope !== scopeLabel(scope)
            || prior.requestDigest !== requestDigest) throw new DinnerConsumptionConflictError();
          const entryItem = entities.get(entityKey(scope, 'dinner_entry', request.command.entryId));
          if (entryItem === undefined || entryItem.deleted || !isDinnerEntry(entryItem.payload)) throw new DinnerConsumptionConflictError();
          const eventItem = entities.get(entityKey(scope, 'cook_event', request.command.entryId));
          const cookEvent = eventItem !== undefined && !eventItem.deleted && eventItem.payload !== null
            ? eventItem.payload as CookEvent : undefined;
          const currentItems = [...entities.entries()].filter(([key]) => entityScopeFor(scope, key)).map(([, item]) => item);
          return {
            duplicate: true,
            entry: entryItem.payload,
            ...(cookEvent === undefined ? {} : { cookEvent }),
            pantrySnapshot: pantrySnapshotFromStoredItems(currentItems),
            receipt: prior.receipt,
            plan: prior.receipt.plan,
          };
        }

        const entryKey = entityKey(scope, 'dinner_entry', request.command.entryId);
        const cookEventKey = entityKey(scope, 'cook_event', request.command.entryId);
        if (entities.has(entryKey) || entities.has(cookEventKey)) throw new DinnerConsumptionConflictError();
        const scopeItems = [...entities.entries()].filter(([key]) => entityScopeFor(scope, key));
        const pantryItems = scopeItems.filter(([, item]) => pantryTypes.has(item.entityType)).map(([, item]) => item);
        const lots = pantryItems.map(storedPantryLot).filter((lot): lot is PantryLot => lot !== null);
        const now = options.clock();
        const committedAt = now.toISOString();
        const plan = planPantryConsumption({ lots, command: request.command, updatedAt: committedAt });
        const digest = requestDigest;
        const changedItems: StoredSyncItem[] = [];
        const addChange = (
          entityType: SyncMutation['entityType'], entityId: string, payload: unknown | null, deleted: boolean,
        ): void => {
          const item: StoredSyncItem = {
            entityType,
            entityId,
            deviceId: 'api-dinner-consumption',
            payload,
            deleted,
            clientUpdatedAt: now,
            serverUpdatedAt: now,
            mutationId: randomUUID(),
            syncScope: scopeLabel(scope),
            serverSequence: ++sequence,
          };
          changedItems.push(item);
        };
        for (const lotId of plan.deleteLotIds) {
          const source = pantryItems.find((item) => storedPantryLot(item)?.id === lotId);
          if (source !== undefined) addChange(source.entityType, source.entityId, null, true);
        }
        for (const lot of plan.upsertLots) addChange('pantry_lot', lot.id, lot, false);
        const savedEntry: DinnerEntry = { ...request.entry, authorId: userId };
        addChange('dinner_entry', savedEntry.id, savedEntry, false);
        if (request.cookEvent !== undefined) addChange('cook_event', request.cookEvent.id, request.cookEvent, false);
        const receipt: DinnerConsumptionReceipt = {
          operationId: request.command.operationId,
          entryId: request.command.entryId,
          scope: scopeLabel(scope),
          committedAt,
          plan,
        };
        for (const item of changedItems) entities.set(entityKey(scope, item.entityType, item.entityId), item);
        const processedId = consumptionProcessedMutationId(request.command.operationId);
        processed.add(`${scopeKey(scope)}:${processedId}`);
        dinnerReceiptsByOperation.set(request.command.operationId, { receipt, requestDigest: digest });
        dinnerOperationByEntry.set(dinnerEntryKey(scope, request.command.entryId), request.command.operationId);
        const currentItems = [...entities.entries()].filter(([key]) => entityScopeFor(scope, key)).map(([, item]) => item);
        return {
          duplicate: false,
          entry: savedEntry,
          ...(request.cookEvent === undefined ? {} : { cookEvent: request.cookEvent }),
          pantrySnapshot: pantrySnapshotFromStoredItems(currentItems),
          receipt,
          plan,
        };
      });
    },
    applyMutation: async (userId, mutation) => {
      if (mutation.entityType === 'meal_plan_entry') throw new PlanCommandRequiredError();
      const apply = async (resolvedScope?: SyncScope | null) => {
        const prepared = prepareMutation(mutation, options);
        const scope = resolvedScope ?? await resolveEntityScope(userId, prepared.mutation.entityType, options, prepared.mutation.syncScope);
        if (scope === null) throw new SyncMembershipRequiredError();
        const processedKey = `${scopeKey(scope)}:${prepared.mutation.mutationId}`;
        if (processed.has(processedKey)) return { applied: false, change: null };
        const key = entityKey(scope, prepared.mutation.entityType, prepared.mutation.entityId);
        const existing = entities.get(key);
        if (prepared.mutation.entityType === 'ai_consent') {
          processed.add(processedKey);
          if (prepared.mutation.operation === 'upsert' && isAiConsent(prepared.mutation.payload)
            && prepared.mutation.payload.enabled) return { applied: false, change: null };

          const current = currentConsentFromItem(existing ?? null);
          const revision = consentRevisionFromItem(existing ?? null, current);
          const now = nextConsentTimestamp(options.clock, revision);
          const consent = applyAiConsentUpdate(current, { enabled: false }, now.toISOString());
          const item: StoredSyncItem = {
            entityType: 'ai_consent',
            entityId: 'profile',
            deviceId: prepared.mutation.deviceId,
            payload: consent,
            deleted: false,
            clientUpdatedAt: now,
            serverUpdatedAt: now,
            mutationId: prepared.mutation.mutationId,
            syncScope: `account:${userId}`,
            serverSequence: ++sequence,
          };
          entities.set(key, item);
          return { applied: true, change: toChange(item) };
        }
        const normalizedMutation = normalizeDiaryMutation(userId, prepared.mutation, existing ?? null);
        const normalizedPrepared = { ...prepared, mutation: normalizedMutation };
        processed.add(processedKey);
        const winsExisting = existing === undefined || wins(normalizedPrepared, existing);
        const staleRecipeLinkMutation = existing !== undefined && !winsExisting
          ? mergeStaleDinnerRecipeLinks(normalizedMutation, existing)
          : null;
        if (!winsExisting && staleRecipeLinkMutation === null) return { applied: false, change: null };
        const mutationToApply = staleRecipeLinkMutation ?? normalizedMutation;
        const item: StoredSyncItem = {
          entityType: mutationToApply.entityType,
          entityId: mutationToApply.entityId,
          deviceId: mutationToApply.deviceId,
          payload: mutationToApply.payload,
          deleted: mutationToApply.operation === 'delete',
          clientUpdatedAt: new Date(mutationToApply.clientUpdatedAt),
          serverUpdatedAt: prepared.serverUpdatedAt,
          mutationId: mutationToApply.mutationId,
          syncScope: scope.kind === 'house' ? `house:${scope.id}` : `account:${scope.id}`,
          serverSequence: ++sequence,
        };
        entities.set(key, item);
        return { applied: true, change: toChange(item) };
      };
      if (pantryItemTypes.has(mutation.entityType)) {
        const requested = await resolveEntityScope(userId, mutation.entityType, options, mutation.syncScope);
        if (requested === null) throw new SyncMembershipRequiredError();
        return withPantryLock(scopeKey(requested), async () => {
          const current = await resolveEntityScope(userId, mutation.entityType, options, mutation.syncScope);
          if (current === null || scopeKey(current) !== scopeKey(requested)) throw new SyncMembershipRequiredError();
          return apply(current);
        });
      }
      return mutation.entityType === 'ai_consent' ? withConsentLock(userId, apply) : apply();
    },
    readChanges: async (userId, cursor, limit, requestedScope, supportedEntityTypes) => {
      const resolved = await resolveReadScopes(userId, options, requestedScope);
      if (resolved.mode === 'account' && resolved.currentHouse !== null
        && supportedEntityTypes?.some(isSharedEntityType) === true) throw new SyncScopeInvalidError();
      if (resolved.mode === 'house' && supportedEntityTypes?.some((type) => !isSharedEntityType(type)) === true) {
        throw new SyncScopeInvalidError();
      }
      const pending = houseMigrationPending.get(userId);
      if (pending !== undefined) {
        if (requestedScope === `account:${userId}`) {
          if (supportedEntityTypes?.some(isSharedEntityType) === true) throw new HouseMigrationPendingError();
        } else {
          throw new HouseMigrationPendingError();
        }
      }
      if (resolved.currentHouse !== null && supportedEntityTypes?.includes('meal_plan_entry') === true) {
        const currentHouse = resolved.currentHouse;
        const quarantined = [...mealPlanRecoveryQuarantines.values()].some((quarantine) =>
          quarantine.sourceAccountId === userId && quarantine.targetHouseId === currentHouse.id,
        );
        if (quarantined) throw new PlanMigrationQuarantinedError();
      }
      const keys = new Set(resolved.scopes.map(scopeKey));
      const isolateHouseMealPlan = requestedScope?.startsWith('house:') === true
        && supportedEntityTypes?.includes('meal_plan_entry') === true;
      return [...entities.entries()]
        .filter(([key, item]) => [...keys].some((scope) => key.startsWith(`${scope}:`))
          && (resolved.currentHouse === null
            || (resolved.mode === 'account' && !isSharedEntityType(item.entityType))
            || (resolved.mode === 'house' && isSharedEntityType(item.entityType))
            || (resolved.mode === 'composite'
              && ((item.syncScope === `account:${userId}` && !isSharedEntityType(item.entityType))
                || (item.syncScope === `house:${resolved.currentHouse.id}` && isSharedEntityType(item.entityType)))))
          && item.serverSequence > cursor
          && (supportedEntityTypes === undefined || supportedEntityTypes.includes(item.entityType))
          && (item.entityType !== 'meal_plan_entry' || planStateFromSyncItem(item) !== null)
          && (!isolateHouseMealPlan || item.entityType !== 'meal_plan_entry' || item.syncScope === requestedScope))
        .map(([, item]) => item)
        .sort((left, right) => left.serverSequence - right.serverSequence)
        .slice(0, limit)
        .map(toChange);
    },
    readAll: async (userId) => {
      const resolved = await resolveReadScopes(userId, options);
      const pending = houseMigrationPending.get(userId);
      if (pending !== undefined) throw new HouseMigrationPendingError();
      const keys = new Set(resolved.scopes.map(scopeKey));
      return [...entities.entries()]
        .filter(([key, item]) => [...keys].some((scope) => key.startsWith(`${scope}:`))
          && (resolved.currentHouse === null
            || (item.syncScope === `account:${userId}` && !isSharedEntityType(item.entityType))
            || (item.syncScope === `house:${resolved.currentHouse.id}` && isSharedEntityType(item.entityType))))
        .map(([, item]) => item)
        .sort((left, right) => left.serverSequence - right.serverSequence)
        .map(toChange);
    },
    readEntity: async (userId, entityType, entityId) => {
      const scope = await resolveEntityScope(userId, entityType, options);
      if (scope === null) return null;
      if (entityType === 'meal_plan_entry') {
        const pending = houseMigrationPending.get(userId);
        if (pending !== undefined) throw new HouseMigrationPendingError();
      }
      return entities.get(entityKey(scope, entityType, entityId)) ?? null;
    },
    mergeUserPantryToHouse: async (userId, houseId) => {
      const sourceScope = userScope(userId);
      const sourceRows = [...entities.entries()].filter(([key, item]) => entityScopeFor(sourceScope, key) && pantryTypes.has(item.entityType));
      return mergeMemoryPantry(
        userId,
        houseId,
        [],
        [],
        sourceRows,
        sourceRows.flatMap(([, item]) => [
          item.mutationId,
          guestMarkerForItem(item),
        ].filter((marker): marker is string => marker !== null)),
        `user:${userId}`,
      );
    },
    mergeGuestPantryToHouse: async (userId, houseId, input) => {
      const houseScope: SyncScope = { kind: 'house', id: houseId };
      const lotMarkers = input.lots.map((lot) => guestMarkerForLot(input.deviceId, lot));
      const pendingLots = input.lots.filter((lot, index) => !processed.has(`${scopeKey(houseScope)}:${lotMarkers[index]}`));
      const stapleMarkers = input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:{"enabled":true}`);
      const pendingStaples = input.stapleIds.filter((id, index) => !processed.has(`${scopeKey(houseScope)}:${stapleMarkers[index]}`));
      return mergeMemoryPantry(
        userId,
        houseId,
        pendingLots,
        pendingStaples,
        [],
        [
          ...lotMarkers.filter((marker, index) => pendingLots.some((lot) => lot.id === input.lots[index]?.id)),
          ...stapleMarkers.filter((marker, index) => pendingStaples.includes(input.stapleIds[index]!)),
        ],
        `guest:${input.deviceId}`,
      );
    },
    mergeGuestDietProfileToHouse: async (userId, houseId, mutation) => {
      const valid = validateGuestDietProfileMutation(mutation);
      if (options.scopeResolverConfigured) {
        const currentScope = await options.scopeResolver(userId);
        if (currentScope?.kind !== 'house' || currentScope.id !== houseId) throw new SyncMembershipRequiredError();
      }
      const prepared = prepareMutation(valid, options);
      const houseScope: SyncScope = { kind: 'house', id: houseId };
      const processedKey = `${scopeKey(houseScope)}:${valid.mutationId}`;
      if (processed.has(processedKey)) return false;
      const key = entityKey(houseScope, 'diet_profile', 'profile');
      const existing = entities.get(key);
      const guestProfile = valid.payload as DietProfile;
      const merged = existing !== undefined && !existing.deleted
        ? mergeDietProfiles(existing.payload, guestProfile) ?? guestProfile
        : guestProfile;
      processed.add(processedKey);
      entities.set(key, {
        entityType: 'diet_profile',
        entityId: 'profile',
        deviceId: valid.deviceId,
        payload: merged,
        deleted: false,
        clientUpdatedAt: new Date(prepared.mutation.clientUpdatedAt),
        serverUpdatedAt: prepared.serverUpdatedAt,
        mutationId: valid.mutationId,
        syncScope: `house:${houseId}`,
        serverSequence: ++sequence,
      });
      return true;
    },
    migrateUserSharedDataToHouse: async (userId, houseId, pendingAccountMutations = []) => {
      if (options.scopeResolverConfigured) {
        const activeScope = await options.scopeResolver(userId);
        if (activeScope?.kind !== 'house' || activeScope.id !== houseId) throw new SyncMembershipRequiredError();
      }
      const entitiesBefore = new Map(entities);
      const processedBefore = new Set(processed);
      const dinnerReceiptsBefore = new Map(dinnerReceiptsByOperation);
      const dinnerEntriesBefore = new Map(dinnerOperationByEntry);
      const planManualOrdersBefore = new Map(planManualOrders);
      const recoveryConflictsBefore = new Map(mealPlanRecoveryConflicts);
      const recoveryBySourceBefore = new Map(mealPlanRecoveryBySource);
      const recoveryQuarantinesBefore = new Map(mealPlanRecoveryQuarantines);
      const sequenceBefore = sequence;
      try {
        const sourceScope = userScope(userId);
        // Stage offline account mutations in their original namespace, then run
        // the existing semantic migration (pantry re-key, conservative diet).
        // Never replay them as ordinary house-scoped LWW upserts.
        for (const mutation of validatePendingAccountMutations(userId, pendingAccountMutations)) {
        const prepared = prepareMutation(mutation, options);
        const processedKey = `${scopeKey(sourceScope)}:${mutation.mutationId}`;
        if (processed.has(processedKey)) continue;
        const key = entityKey(sourceScope, mutation.entityType, mutation.entityId);
        const existing = entities.get(key);
        const normalized = normalizeDiaryMutation(userId, prepared.mutation, existing ?? null);
        const normalizedPrepared = { ...prepared, mutation: normalized };
        processed.add(processedKey);
        if (existing !== undefined && !wins(normalizedPrepared, existing)) continue;
        entities.set(key, {
          entityType: normalized.entityType,
          entityId: normalized.entityId,
          deviceId: normalized.deviceId,
          payload: normalized.payload,
          deleted: normalized.operation === 'delete',
          clientUpdatedAt: new Date(normalized.clientUpdatedAt),
          serverUpdatedAt: prepared.serverUpdatedAt,
          mutationId: normalized.mutationId,
          syncScope: `account:${userId}`,
          serverSequence: ++sequence,
        });
      }
      const personalPrefix = `${scopeKey(sourceScope)}:`;
      const houseScope: SyncScope = { kind: 'house', id: houseId };
      const pantrySourceRows = [...entities.entries()].filter(([key, item]) => (
        entityScopeFor(sourceScope, key) && pantryTypes.has(item.entityType)
      ));
      mergeMemoryPantry(
        userId,
        houseId,
        [],
        [],
        pantrySourceRows,
        pantrySourceRows.flatMap(([, item]) => [
          item.mutationId,
          guestMarkerForItem(item),
        ].filter((marker): marker is string => marker !== null)),
        `user:${userId}`,
      );
      await withMealPlanLock(scopeKey(sourceScope), async () => withMealPlanLock(scopeKey(houseScope), async () => {
        if (options.scopeResolverConfigured) {
          const activeScope = await options.scopeResolver(userId);
          if (activeScope?.kind !== 'house' || activeScope.id !== houseId) throw new SyncMembershipRequiredError();
        }
        const accountPlanPrefix = `${scopeKey(sourceScope)}:meal_plan_entry:`;
        const accountPlanRows = [...entities.entries()].filter(([key, item]) =>
          key.startsWith(accountPlanPrefix) && item.entityType === 'meal_plan_entry');
        for (const [sourceKey, sourceItem] of accountPlanRows) {
          const sourceState = planStateFromSyncItem(sourceItem);
          if (sourceState === null) continue;
          const sourcePlanKey = `${scopeKey(sourceScope)}:${sourceState.date}`;
          const sourceManualOrder = planManualOrders.get(sourcePlanKey) ?? null;
          if ((sourceState.kind === 'manual' || sourceState.kind === 'deleted') && sourceManualOrder === null) continue;

          const targetKey = entityKey(houseScope, 'meal_plan_entry', sourceState.date);
          const targetItem = entities.get(targetKey);
          const currentState = planStateFromSyncItem(targetItem ?? null);
          const targetPlanKey = `${scopeKey(houseScope)}:${sourceState.date}`;
          const targetManualOrder = planManualOrders.get(targetPlanKey) ?? null;
          const quarantineMigrationSource = (reasonCode: string): void => {
            const rawSourceState = structuredClone(sourceState);
            const rawSourceProjection = mealPlanProjectionSnapshot(sourceItem);
            const rawTargetState = currentState === null ? null : structuredClone(currentState);
            const rawTargetProjection = targetItem === undefined ? null : mealPlanProjectionSnapshot(targetItem);
            const evidence = {
              sourceAccountId: userId,
              targetHouseId: houseId,
              planDate: sourceState.date,
              reasonCode,
              rawSourceState,
              rawSourceProjection,
              rawTargetState,
              rawTargetProjection,
            };
            const fingerprint = mealPlanMigrationQuarantineFingerprint(evidence);
            if (!mealPlanRecoveryQuarantines.has(fingerprint)) {
              mealPlanRecoveryQuarantines.set(fingerprint, {
                id: randomUUID(),
                ...evidence,
                fingerprint,
                createdAt: options.clock().toISOString(),
              });
            }
            entities.delete(sourceKey);
            planManualOrders.delete(sourcePlanKey);
          };
          // A pending retry must complete the migration of this account's data:
          // quarantine only applies to fresh migrations, not to a retry already in flight.
          const isPendingRetry = houseMigrationPending.has(userId);
          if (sourceState.kind === 'automatic'
            && (sourceState.date !== sourceItem.entityId || sourceItem.syncScope !== `account:${userId}`)) {
            quarantineMigrationSource('source_projection_inconsistent');
            continue;
          }
          if (targetItem !== undefined && currentState === null) {
            if (sourceState.kind === 'automatic') quarantineMigrationSource('target_projection_inconsistent');
            continue;
          }
          if (currentState !== null && (currentState.kind === 'manual' || currentState.kind === 'deleted')
            && targetManualOrder === null && sourceState.kind !== 'automatic') continue;

          const sourceIsManual = sourceState.kind === 'manual' || sourceState.kind === 'deleted';
          // Non-automatic account data cannot be bound to a verified migration command:
          // quarantine the raw evidence and remove the account rows atomically.
          if (sourceIsManual && sourceManualOrder === null) {
            quarantineMigrationSource('manual_tuple_missing');
            continue;
          }
          if (sourceIsManual && !isPendingRetry) {
            if (currentState === null) {
              quarantineMigrationSource('source_projection_inconsistent');
              continue;
            }
            if (targetItem !== undefined && targetManualOrder !== null
              && compareManualPlanOrders(sourceManualOrder!, targetManualOrder) <= 0) {
              quarantineMigrationSource('target_projection_inconsistent');
              continue;
            }
          }
          const appliesState = currentState === null || (sourceIsManual && sourceManualOrder !== null
            && (targetManualOrder === null || compareManualPlanOrders(sourceManualOrder, targetManualOrder) > 0));
          const losingManualChoice = !appliesState && sourceIsManual && sourceManualOrder !== null
            && currentState !== null && targetManualOrder !== null
            && compareManualPlanOrders(sourceManualOrder, targetManualOrder) <= 0;
          const losingAutomaticProposal = !appliesState && currentState !== null && sourceState.kind === 'automatic';
          if (losingManualChoice || losingAutomaticProposal) {
            const sourceNow = entities.get(sourceKey);
            const sourceNowState = planStateFromSyncItem(sourceNow ?? null);
            if (sourceNow === undefined || sourceNowState?.revision !== sourceState.revision
              || sourceNow.mutationId !== sourceItem.mutationId || sourceNow.serverSequence !== sourceItem.serverSequence) {
              throw new PlanRecoveryRevisionConflictError();
            }
            const originalCommand = losingManualChoice
              ? manualPlanCommandFromMigration(
                `account:${userId}`,
                sourceState.date,
                sourceState.kind as 'manual' | 'deleted',
                sourceState.recipeId,
                sourceManualOrder!,
              )
              : verifiedAutomaticMigrationCommand(
                planReceipts.get(planReceiptKey(sourceScope, userId, sourceItem.mutationId)),
                userId,
                sourceState,
                sourceItem,
              );
            if (originalCommand === null) {
              quarantineMigrationSource('automatic_command_unverified');
              continue;
            }
            const recoveryKey = mealPlanMigrationConflictKey(houseId, userId, sourceState.date, sourceState.revision);
            const priorId = mealPlanRecoveryBySource.get(recoveryKey);
            const prior = priorId === undefined ? undefined : mealPlanRecoveryConflicts.get(priorId);
            if (prior !== undefined) {
              if (planCommandDigest(prior.originalCommand) !== planCommandDigest(originalCommand)) {
                throw new PlanRecoveryResolutionReusedError();
              }
            } else {
              const createdAt = options.clock().toISOString();
              const conflict: StoredMealPlanMigrationConflict = {
                id: randomUUID(),
                sourceAccountId: userId,
                targetHouseId: houseId,
                planDate: sourceState.date,
                sourceRevision: sourceState.revision,
                sourceProjectionMutationId: sourceItem.mutationId,
                sourceDeviceId: sourceItem.deviceId,
                sourceClientUpdatedAt: sourceItem.clientUpdatedAt.toISOString(),
                sourceServerUpdatedAt: sourceItem.serverUpdatedAt.toISOString(),
                sourceState: structuredClone(sourceState),
                sourceProjection: mealPlanProjectionSnapshot(sourceItem),
                targetRevisionAtStaging: currentState.revision,
                targetStateAtStaging: structuredClone(currentState),
                originalCommand,
                createdAt,
                status: 'pending',
                resolutionDigest: null,
                resolutionCommand: null,
                resolutionResult: null,
                resolvedByUserId: null,
                resolvedAt: null,
              };
              mealPlanRecoveryConflicts.set(conflict.id, conflict);
              mealPlanRecoveryBySource.set(recoveryKey, conflict.id);
            }
            entities.delete(sourceKey);
            planManualOrders.delete(sourcePlanKey);
            continue;
          }
          if (!appliesState) continue;

          const now = options.clock();
          const serverSequence = ++sequence;
          const nextState = createPlanState(sourceState.date, randomUUID(), serverSequence, sourceState.kind, sourceState.recipeId);
          const nextItem: StoredSyncItem = {
            ...sourceItem,
            entityType: 'meal_plan_entry',
            entityId: sourceState.date,
            payload: nextState,
            deleted: false,
            serverUpdatedAt: now,
            syncScope: `house:${houseId}`,
            serverSequence,
          };
          entities.set(targetKey, nextItem);
          if (sourceManualOrder !== null) planManualOrders.set(targetPlanKey, sourceManualOrder);
          entities.delete(sourceKey);
          planManualOrders.delete(sourcePlanKey);
        }
      }));
      for (const [key, personalItem] of [...entities.entries()]) {
        if (!key.startsWith(personalPrefix)
          || pantryTypes.has(personalItem.entityType)
          || personalItem.entityType === 'meal_plan_entry'
          || !AUTO_MIGRATED_ENTITY_TYPES.has(personalItem.entityType)) continue;
        const targetKey = entityKey(houseScope, personalItem.entityType, personalItem.entityId);
        const existing = entities.get(targetKey);
        const incoming: PreparedMutation = {
          mutation: {
            mutationId: personalItem.mutationId,
            deviceId: personalItem.deviceId,
            entityType: personalItem.entityType,
            entityId: personalItem.entityId,
            operation: personalItem.deleted ? 'delete' : 'upsert',
            payload: personalItem.payload,
            clientUpdatedAt: personalItem.clientUpdatedAt.toISOString(),
          },
          serverUpdatedAt: personalItem.serverUpdatedAt,
        };
        const mergedDietProfile = personalItem.entityType === 'diet_profile'
          && existing !== undefined
          && !personalItem.deleted
          && !existing.deleted
          ? mergeDietProfiles(existing.payload, personalItem.payload)
          : null;
        if (mergedDietProfile !== null) {
          const winner: StoredSyncItem = wins(incoming, existing!) ? personalItem : existing!;
          entities.set(targetKey, {
            ...winner,
            payload: mergedDietProfile,
            deleted: false,
            syncScope: `house:${houseId}`,
            serverSequence: ++sequence,
          });
        } else if ((existing === undefined || wins(incoming, existing))
          && !shouldPreserveLiveHouseDietProfile(personalItem.entityType, personalItem.deleted, existing ?? null)) {
          entities.set(targetKey, {
            ...personalItem,
            syncScope: `house:${houseId}`,
            serverSequence: ++sequence,
          });
        }
        entities.delete(key);
      }
      const accountScope = scopeLabel(sourceScope);
      const houseLabel = scopeLabel(houseScope);
      for (const [operationId, stored] of dinnerReceiptsByOperation) {
        if (stored.receipt.scope !== accountScope) continue;
        const moved: DinnerConsumptionReceipt = { ...stored.receipt, scope: houseLabel };
        dinnerReceiptsByOperation.set(operationId, { ...stored, receipt: moved });
        dinnerOperationByEntry.delete(dinnerEntryKey(sourceScope, stored.receipt.entryId));
        dinnerOperationByEntry.set(dinnerEntryKey(houseScope, stored.receipt.entryId), operationId);
        const processedId = consumptionProcessedMutationId(operationId);
        processed.delete(`${scopeKey(sourceScope)}:${processedId}`);
        processed.add(`${scopeKey(houseScope)}:${processedId}`);
      }
      } catch (error) {
        entities.clear();
        for (const [key, item] of entitiesBefore) entities.set(key, item);
        processed.clear();
        for (const marker of processedBefore) processed.add(marker);
        dinnerReceiptsByOperation.clear();
        for (const [operationId, receipt] of dinnerReceiptsBefore) dinnerReceiptsByOperation.set(operationId, receipt);
        dinnerOperationByEntry.clear();
        for (const [entryId, operationId] of dinnerEntriesBefore) dinnerOperationByEntry.set(entryId, operationId);
        planManualOrders.clear();
        for (const [key, order] of planManualOrdersBefore) planManualOrders.set(key, order);
        mealPlanRecoveryConflicts.clear();
        for (const [key, conflict] of recoveryConflictsBefore) mealPlanRecoveryConflicts.set(key, conflict);
        mealPlanRecoveryBySource.clear();
        for (const [key, conflictId] of recoveryBySourceBefore) mealPlanRecoveryBySource.set(key, conflictId);
        mealPlanRecoveryQuarantines.clear();
        for (const [key, quarantine] of recoveryQuarantinesBefore) mealPlanRecoveryQuarantines.set(key, quarantine);
        sequence = sequenceBefore;
        throw error;
      }
    },
    readHouseMigrationPending: async (userId) => {
      const pending = houseMigrationPending.get(userId);
      return pending === undefined ? null : { houseId: pending.houseId };
    },
    setHouseMigrationPending: async (userId, houseId) => {
      houseMigrationPending.set(userId, { houseId, createdAt: options.clock() });
    },
    clearHouseMigrationPending: async (userId) => {
      houseMigrationPending.delete(userId);
    },
  };
};

const fromDatabaseItem = (item: typeof syncItems.$inferSelect): StoredSyncItem => ({
  entityType: item.entityType as SyncMutation['entityType'],
  entityId: item.entityId,
  deviceId: item.deviceId,
  payload: item.payload,
  deleted: item.deleted,
  clientUpdatedAt: item.clientUpdatedAt,
  serverUpdatedAt: item.updatedAt,
  mutationId: item.mutationId,
  syncScope: scopeLabel({ kind: item.scopeType, id: item.scopeId } as SyncScope),
  serverSequence: item.serverSequence,
});

const fromDatabaseMealPlanMigrationConflict = (
  row: typeof mealPlanMigrationConflicts.$inferSelect,
): StoredMealPlanMigrationConflict => ({
  id: row.id,
  sourceAccountId: row.sourceAccountId,
  targetHouseId: row.houseId,
  planDate: row.planDate,
  sourceRevision: row.sourceRevision,
  sourceProjectionMutationId: row.sourceProjectionMutationId,
  sourceDeviceId: row.sourceDeviceId,
  sourceClientUpdatedAt: row.sourceClientUpdatedAt.toISOString(),
  sourceServerUpdatedAt: row.sourceServerUpdatedAt.toISOString(),
  sourceState: row.sourceState ?? null,
  sourceProjection: row.sourceProjection as MealPlanMigrationProjectionSnapshot | null,
  targetRevisionAtStaging: row.targetRevision,
  targetStateAtStaging: row.targetState,
  originalCommand: row.originalCommand,
  createdAt: row.createdAt.toISOString(),
  status: row.status as 'pending' | 'resolved',
  resolutionDigest: row.resolutionDigest,
  resolutionCommand: row.resolutionCommand,
  resolutionResult: row.resolutionResult,
  resolvedByUserId: row.resolvedByUserId,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

export const createDrizzleSyncRepository = (
  database: ApplicationDatabase['db'],
  repositoryOptions: SyncRepositoryOptions = {},
): SyncRepository => {
  const options = resolveOptions(repositoryOptions);
  type SyncDatabaseTransaction = Parameters<Parameters<typeof database.transaction>[0]>[0];

  const resolveTransactionScope = async (
    transaction: SyncDatabaseTransaction,
    userId: string,
    mutation: Pick<SyncMutation, 'entityType' | 'syncScope'>,
  ): Promise<SyncScope> => {
    if (!isSharedEntityType(mutation.entityType)) {
      return resolveScopeForCurrentMembership(userId, mutation.entityType, null, mutation.syncScope);
    }

    // Serialize scope selection with house creation/member-add so a stale account write cannot race migration.
    await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    const houseId = membership?.houseId ?? null;
    const scope = resolveScopeForCurrentMembership(userId, mutation.entityType, houseId, mutation.syncScope);
    if (scope.kind === 'house') {
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${scope.id} FOR UPDATE`);
      const [currentMembership] = await transaction.select({ id: houseMemberships.id })
        .from(houseMemberships)
        .where(and(
          eq(houseMemberships.userId, userId),
          eq(houseMemberships.houseId, scope.id),
        ))
        .limit(1);
      if (currentMembership === undefined) throw new SyncMembershipRequiredError();
    }
    return scope;
  };

  const mergeDatabasePantryInTransaction = async (
    transaction: SyncDatabaseTransaction,
    userId: string,
    houseId: string,
    input: { lots: PantryLot[]; stapleIds: string[]; deviceId?: string; includePersonalRows: boolean },
  ): Promise<PantryMergeSummary> => {
    // Match deletion and membership writes: user first, then house. Inserts
    // below take a foreign-key lock on the user even if this function did not.
    await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
    await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
    const membershipRows = await transaction.execute(sql`SELECT id FROM ${houseMemberships} WHERE user_id = ${userId} AND house_id = ${houseId} FOR UPDATE`);
    if (membershipRows.length === 0) throw new SyncMembershipRequiredError();
    if (input.includePersonalRows) {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pantryScopeLockKey(userScope(userId))}, 0))`);
    }
    const houseRows = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'house'),
      eq(syncItems.scopeId, houseId),
      inArray(syncItems.entityType, [...pantryTypes]),
    ));
    const sourceRows = input.includePersonalRows
      ? await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'user'),
        eq(syncItems.scopeId, userId),
        inArray(syncItems.entityType, [...pantryTypes]),
      ))
      : [];
    const sourceItems = sourceRows.map(fromDatabaseItem);
    const sourceAliasMarkers = sourceItems
      .map((item) => guestMarkerForItem(item))
      .filter((marker): marker is string => marker !== null);
    const sourceUserLotMarkers = sourceItems
      .map((item) => userSourceLotMarkerForItem(userId, item))
      .filter((marker): marker is string => marker !== null);
    const sourceMutationIds = sourceRows.map((row) => row.mutationId);
    const sourceProcessedRows = sourceMutationIds.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        inArray(processedSyncMutations.mutationId, sourceMutationIds),
      ));
    const sourceProcessed = new Set(sourceProcessedRows.map((row) => row.mutationId));
    const guestLotMarkers = input.deviceId === undefined
      ? []
      : input.lots.map((lot) => guestMarkerForLot(input.deviceId!, lot));
    const userSourceInputLotMarkers = input.deviceId === undefined ? [] : input.lots.map((lot) => userSourceLotMarkerForLot(
      userId, input.deviceId!, 'pantry_lot', lot.id, lot,
    ));
    const guestStapleMarkers = input.deviceId === undefined
      ? []
      : input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:{"enabled":true}`);
    const guestMarkers = [
      ...guestLotMarkers, ...userSourceInputLotMarkers, ...guestStapleMarkers, ...sourceAliasMarkers, ...sourceUserLotMarkers,
    ];
    const guestProcessedRows = guestMarkers.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        inArray(processedSyncMutations.mutationId, guestMarkers),
      ));
    const sourceMarkerPrefixes = [
      ...sourceItems.map(guestMarkerPrefixForItem),
      ...sourceItems.map((item) => pantryItemTypes.has(item.entityType)
        ? userSourceLotMarkerPrefix(userId, item.deviceId, item.entityType, item.entityId) : null),
      ...sourceItems.map((item) => pantryItemTypes.has(item.entityType)
        ? accountSourceLotMarkerPrefix(userId, item.entityType, item.entityId) : null),
    ].filter((prefix): prefix is string => prefix !== null);
    const inputMarkerPrefixes = input.deviceId === undefined ? [] : [
      ...input.lots.map((lot) => userSourceLotMarkerPrefix(userId, input.deviceId!, 'pantry_lot', lot.id)),
      ...input.stapleIds.map((id) => `guest:${input.deviceId}:staple_preference:${id}:`),
    ];
    const priorMarkerPrefixes = [...new Set([...sourceMarkerPrefixes, ...inputMarkerPrefixes])];
    const priorSourceProcessedRows = priorMarkerPrefixes.length === 0 ? [] : await transaction.select({ mutationId: processedSyncMutations.mutationId })
      .from(processedSyncMutations)
      .where(and(
        eq(processedSyncMutations.scopeType, 'house'),
        eq(processedSyncMutations.scopeId, houseId),
        or(...priorMarkerPrefixes.map((prefix) => like(processedSyncMutations.mutationId, `${prefix}%`))),
      ));
    const guestProcessed = new Set([
      ...guestProcessedRows.map((row) => row.mutationId),
      ...priorSourceProcessedRows.map((row) => row.mutationId),
    ]);
    const incomingLots = input.deviceId === undefined ? input.lots
      : input.lots.filter((_, index) => !guestProcessed.has(userSourceInputLotMarkers[index]!));
    const incomingStaples = input.stapleIds.filter((_, index) => !guestProcessed.has(guestStapleMarkers[index]!));
    const housePantryRows = houseRows.map(fromDatabaseItem);
    const existingLots = housePantryRows
      .filter((row) => pantryItemTypes.has(row.entityType))
      .map(storedPantryLot)
      .filter((lot): lot is PantryLot => lot !== null);
    const existingStaples = housePantryRows
      .filter((row) => row.entityType === 'staple_preference' && !row.deleted
        && typeof row.payload === 'object' && row.payload !== null
        && (row.payload as { enabled?: unknown }).enabled === true)
      .map((row) => row.entityId);
    const supersededExistingIds = new Set<string>();
    let existingLotsForMerge = existingLots;
    const sourceRowsToMerge = sourceRows.filter((row) => {
      if (sourceProcessed.has(row.mutationId)) return false;
      const item = fromDatabaseItem(row);
      const marker = userSourceLotMarkerForItem(userId, item);
      if (marker !== null && guestProcessed.has(marker)) return false;
      const sourceLot = storedPantryLot(item);
      const accountPriorRevision = input.includePersonalRows
        ? latestAccountSourceLotRevision([...guestProcessed], userId, item.entityType, item.entityId)
        : null;
      if (accountPriorRevision !== null) {
        if (!accountSourceRevisionWins(item, accountPriorRevision)) return false;
        if (!accountPriorRevision.deleted && accountPriorRevision.lot !== null) {
          const canonical = existingLotsForMerge.find((lot) => sameLotGroup(lot, accountPriorRevision.lot!));
          if (canonical !== undefined) {
            const remaining = removeLotContribution(canonical, accountPriorRevision.lot);
            existingLotsForMerge = remaining === null
              ? existingLotsForMerge.filter((lot) => lot.id !== canonical.id)
              : existingLotsForMerge.map((lot) => lot.id === canonical.id ? remaining : lot);
          }
        }
        return true;
      }
      const priorRevision = latestUserSourceLotRevision(
        [...guestProcessed], userId, item.deviceId, item.entityType, item.entityId,
      );
      if (priorRevision !== null) {
        if (sourceLot !== null && lotRevisionTime(sourceLot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) return false;
        const canonical = existingLotsForMerge.find((lot) => sameLotGroup(lot, priorRevision));
        if (canonical !== undefined) {
          const remaining = removeLotContribution(canonical, priorRevision);
          existingLotsForMerge = remaining === null
            ? existingLotsForMerge.filter((lot) => lot.id !== canonical.id)
            : existingLotsForMerge.map((lot) => lot.id === canonical.id ? remaining : lot);
        }
      }
      return true;
    });
    existingLotsForMerge = existingLotsForMerge.filter((lot) => !supersededExistingIds.has(lot.id));
    const sourceLots = sourceRowsToMerge
      .map((row) => storedPantryLot(fromDatabaseItem(row)))
      .filter((lot): lot is PantryLot => lot !== null);
    const sourceStaples = sourceRowsToMerge
      .filter((row) => row.entityType === 'staple_preference' && !row.deleted
        && typeof row.payload === 'object' && row.payload !== null
        && (row.payload as { enabled?: unknown }).enabled === true)
      .map((row) => row.entityId);
    const sourceDeviceId = input.deviceId === undefined ? null : input.deviceId;
    const revisionAwareIncomingLots = latestLotsById(incomingLots).filter((lot) => {
      const previous = existingLots.find((candidate) => candidate.id === lot.id);
      const priorRevision = sourceDeviceId === null ? null
        : latestUserSourceLotRevision([...guestProcessed], userId, sourceDeviceId, 'pantry_lot', lot.id);
      const hasPriorRevision = sourceDeviceId !== null && [...guestProcessed]
        .some((processedMarker) => processedMarker.startsWith(userSourceLotMarkerPrefix(userId, sourceDeviceId, 'pantry_lot', lot.id)));
      if (!hasPriorRevision) return true;
      if (priorRevision !== null) {
        if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(priorRevision.updatedAt)) return false;
        const priorCandidate = existingLotsForMerge.find((candidate) => sameLotGroup(candidate, priorRevision));
        if (priorCandidate !== undefined) {
          const adjusted = removeLotContribution(priorCandidate, priorRevision);
          existingLotsForMerge = adjusted === null
            ? existingLotsForMerge.filter((candidate) => candidate.id !== priorCandidate.id)
            : existingLotsForMerge.map((candidate) => candidate.id === priorCandidate.id ? adjusted : candidate);
        } else if (previous !== undefined) {
          supersededExistingIds.add(previous.id);
          existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
        }
        return true;
      }
      if (previous === undefined) return true;
      if (lotRevisionTime(lot.updatedAt) <= lotRevisionTime(previous.updatedAt)) return false;
      supersededExistingIds.add(previous.id);
      existingLotsForMerge = existingLotsForMerge.filter((candidate) => candidate.id !== previous.id);
      return true;
    });
    const sourcePrefix = input.deviceId === undefined ? `user:${userId}` : `guest:${input.deviceId}`;
    const incomingForMerge = rekeyCollidingLots(existingLotsForMerge, [...sourceLots, ...revisionAwareIncomingLots], sourcePrefix);
    const mergedLots = mergePantryLots(existingLotsForMerge, incomingForMerge);
    const stapleIds = [...new Set([...existingStaples, ...sourceStaples, ...incomingStaples])];
    const now = options.clock();
    const currentLotsById = new Map(houseRows
      .filter((row) => row.entityType === 'pantry_lot' && !row.deleted)
      .map((row) => [row.entityId, row]));
    const currentStaples = houseRows.filter((row) => row.entityType === 'staple_preference' && !row.deleted);
    const lotsUnchanged = currentLotsById.size === mergedLots.lots.length
      && mergedLots.lots.every((lot) => entityMatches(currentLotsById.get(lot.id) === undefined
        ? undefined
        : fromDatabaseItem(currentLotsById.get(lot.id)!), 'pantry_lot', lot.id, lot));
    const staplesUnchanged = currentStaples.length === stapleIds.length
      && stapleIds.every((id) => entityMatches(
        currentStaples.find((row) => row.entityId === id) === undefined
          ? undefined
          : fromDatabaseItem(currentStaples.find((row) => row.entityId === id)!),
        'staple_preference',
        id,
        { enabled: true },
      ));

    if (!lotsUnchanged || !staplesUnchanged) {
      const finalKeys = new Set([
        ...mergedLots.lots.map((lot) => `pantry_lot:${lot.id}`),
        ...stapleIds.map((id) => `staple_preference:${id}`),
      ]);
      const tombstoneValues = houseRows
        .filter((row) => pantryTypes.has(row.entityType as SyncMutation['entityType']) && !finalKeys.has(`${row.entityType}:${row.entityId}`))
        .map((row) => ({
          userId,
          scopeType: 'house' as const,
          scopeId: houseId,
          entityType: row.entityType as SyncMutation['entityType'],
          entityId: row.entityId,
          deviceId: 'house-pantry-merge',
          payload: null,
          deleted: true,
          clientUpdatedAt: now,
          updatedAt: now,
          mutationId: `house-pantry-merge:delete:${row.entityType}:${row.entityId}`,
        }));
      await transaction.delete(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        inArray(syncItems.entityType, [...pantryTypes]),
      ));
      const lotValues = mergedLots.lots.map((lot) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'pantry_lot' as const,
        entityId: lot.id,
        deviceId: 'house-pantry-merge',
        payload: lot,
        deleted: false,
        clientUpdatedAt: new Date(lot.updatedAt),
        updatedAt: now,
        mutationId: `house-pantry-merge:pantry_lot:${lot.id}`,
      }));
      const stapleValues = stapleIds.map((stapleId) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'staple_preference' as const,
        entityId: stapleId,
        deviceId: 'house-pantry-merge',
        payload: { enabled: true },
        deleted: false,
        clientUpdatedAt: now,
        updatedAt: now,
        mutationId: `house-pantry-merge:staple_preference:${stapleId}`,
      }));
      const values = [...lotValues, ...stapleValues, ...tombstoneValues];
      if (values.length > 0) await transaction.insert(syncItems).values(values);
    }

    const accountRevisionMarkers = input.includePersonalRows ? sourceRows
      .map((row) => {
        const item = fromDatabaseItem(row);
        return accountSourceLotRevisionMarkerForItem(
          userId,
          item,
          latestAccountSourceLotRevision([...guestProcessed], userId, item.entityType, item.entityId),
        );
      })
      .filter((marker): marker is string => marker !== null) : [];
    const userSourceMarkers = [
      ...sourceItems.map((item) => userSourceLotMarkerForItem(userId, item)),
      ...(sourceDeviceId === null ? [] : revisionAwareIncomingLots.map((lot) => userSourceLotMarkerForLot(
        userId, sourceDeviceId, 'pantry_lot', lot.id, lot,
      ))),
    ].filter((marker): marker is string => marker !== null);
    const markerIds = [
      ...sourceMutationIds, ...sourceAliasMarkers, ...guestLotMarkers, ...guestStapleMarkers,
      ...accountRevisionMarkers, ...userSourceMarkers,
    ].filter((mutationId) => !sourceProcessed.has(mutationId) && !guestProcessed.has(mutationId));
    if (markerIds.length > 0) {
      await transaction.insert(processedSyncMutations).values(markerIds.map((mutationId) => ({
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        mutationId,
      }))).onConflictDoNothing();
    }
    for (const sourceRow of sourceRows) {
      await transaction.delete(syncItems).where(and(
        eq(syncItems.id, sourceRow.id),
        eq(syncItems.mutationId, sourceRow.mutationId),
        eq(syncItems.clientUpdatedAt, sourceRow.clientUpdatedAt),
      ));
    }

    return {
      ...mergedLots.summary,
      importedStaples: incomingStaples.filter((id) => !existingStaples.includes(id)).length
        + sourceStaples.filter((id) => !existingStaples.includes(id)).length,
    };
  };

  const mergeDatabasePantry = async (
    userId: string,
    houseId: string,
    input: { lots: PantryLot[]; stapleIds: string[]; deviceId?: string; includePersonalRows: boolean },
  ): Promise<PantryMergeSummary> => database.transaction((transaction) => (
    mergeDatabasePantryInTransaction(transaction, userId, houseId, input)
  ));

  const reserveDispatchConnection = (signal?: AbortSignal): Promise<ReservedPostgresConnection> => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishWithError(new DispatchAbortedError());
    const timer = setTimeout(() => finishWithError(new DispatchCapacityError('queue_timeout')), 5_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    void database.$client.reserve().then((connection) => {
      if (settled) {
        connection.release();
        return;
      }
      settled = true;
      cleanup();
      resolve(connection);
    }, (error: unknown) => {
      finishWithError(error instanceof Error ? error : new Error('PostgreSQL dispatch connection unavailable'));
    });
  });

  const withDatabaseAiConsentDispatchLock = async <T>(
    userId: string,
    signal: AbortSignal | undefined,
    operation: (connection: ReservedPostgresConnection) => Promise<T>,
  ): Promise<T> => {
    const releaseCapacity = await dispatchGateFor(database.$client).acquire(signal);
    try {
      const connection = await reserveDispatchConnection(signal);
      const lockKey = aiConsentLockKey(userId);
      let locked = false;
      try {
        await connection`SELECT set_config('lock_timeout', '30000ms', false)`;
        await connection`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
        locked = true;
        return await operation(connection);
      } finally {
        try {
          if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
          await connection`RESET lock_timeout`;
        } finally {
          connection.release();
        }
      }
    } finally {
      releaseCapacity();
    }
  };

  const reservePlanSequence = async (transaction: SyncDatabaseTransaction): Promise<number> => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('ikuck:sync-server-sequence-commit-order', 0))`);
    const rows = await transaction.execute(sql`SELECT nextval('sync_server_sequence') AS server_sequence`);
    const rawSequence = (rows[0] as { server_sequence?: string | number } | undefined)?.server_sequence;
    const serverSequence = Number(rawSequence);
    if (!Number.isSafeInteger(serverSequence) || serverSequence < 1) throw new Error('Unable to reserve a meal-plan server sequence');
    await transaction.execute(sql`SELECT set_config('ikuck.sync_server_sequence', ${String(serverSequence)}, true)`);
    return serverSequence;
  };

  const migrateUserMealPlanToHouse = async (
    transaction: SyncDatabaseTransaction,
    userId: string,
    houseId: string,
  ): Promise<void> => {
    const houseScope: SyncScope = { kind: 'house', id: houseId };
    const housePlanLockKey = `ikuck:meal-plan:${scopeKey(houseScope)}`;
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${housePlanLockKey}, 0))`);
    const accountStates = await transaction.select().from(mealPlanStates).where(and(
      eq(mealPlanStates.scopeType, 'user'),
      eq(mealPlanStates.scopeId, userId),
    )).for('update');

    for (const accountState of accountStates) {
      const [accountProjection] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'user'),
        eq(syncItems.scopeId, userId),
        eq(syncItems.entityType, 'meal_plan_entry'),
        eq(syncItems.entityId, accountState.planDate),
      )).limit(1).for('update');
      const [houseState] = await transaction.select().from(mealPlanStates).where(and(
        eq(mealPlanStates.scopeType, 'house'),
        eq(mealPlanStates.scopeId, houseId),
        eq(mealPlanStates.planDate, accountState.planDate),
      )).limit(1).for('update');
      const [houseProjection] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        eq(syncItems.entityType, 'meal_plan_entry'),
        eq(syncItems.entityId, accountState.planDate),
      )).limit(1).for('update');

      const sourceProjection = accountProjection === undefined ? null : fromDatabaseItem(accountProjection);
      const sourceProjectionState = sourceProjection === null ? null : planStateFromSyncItem(sourceProjection);
      const sourceState = accountProjection === undefined
        ? null
        : planStateFromDatabaseRow(accountState, accountProjection.serverSequence);
      const sourcePairConsistent = sourceProjection !== null && sourceProjectionState !== null
        && !sourceProjection.deleted
        && sourceProjection.entityId === accountState.planDate
        && sourceProjection.syncScope === `account:${userId}`
        && canonicalJson(sourceProjectionState) === canonicalJson(sourceState);
      const targetProjection = houseProjection === undefined ? null : fromDatabaseItem(houseProjection);
      const targetProjectionState = targetProjection === null ? null : planStateFromSyncItem(targetProjection);
      const targetPairExists = houseState !== undefined || houseProjection !== undefined;
      const targetState = houseState === undefined || houseProjection === undefined
        ? null
        : planStateFromDatabaseRow(houseState, houseProjection.serverSequence);
      const targetPairConsistent = !targetPairExists || (houseState !== undefined && targetProjection !== null
        && targetProjectionState !== null && !targetProjection.deleted
        && targetProjection.entityId === accountState.planDate
        && targetProjection.syncScope === `house:${houseId}`
        && canonicalJson(targetProjectionState) === canonicalJson(targetState));
      const sourceOrder = manualPlanOrderFromStateRow(accountState);
      const targetOrder = manualPlanOrderFromStateRow(houseState);
      const quarantineSource = async (reasonCode: string): Promise<void> => {
        const rawSourceState = jsonSnapshot(accountState);
        const rawSourceProjection = sourceProjection === null ? null : mealPlanProjectionSnapshot(sourceProjection);
        const rawTargetState = houseState === undefined ? null : jsonSnapshot(houseState);
        const rawTargetProjection = targetProjection === null ? null : mealPlanProjectionSnapshot(targetProjection);
        const evidence = {
          sourceAccountId: userId,
          targetHouseId: houseId,
          planDate: accountState.planDate,
          reasonCode,
          rawSourceState,
          rawSourceProjection,
          rawTargetState,
          rawTargetProjection,
        };
        const fingerprint = mealPlanMigrationQuarantineFingerprint(evidence);
        await transaction.insert(mealPlanMigrationQuarantines).values({
          houseId,
          sourceAccountId: userId,
          planDate: accountState.planDate,
          reasonCode,
          fingerprint,
          rawSourceState,
          rawSourceProjection,
          rawTargetState,
          rawTargetProjection,
        }).onConflictDoNothing();
        const deletedState = await transaction.delete(mealPlanStates).where(and(
          eq(mealPlanStates.scopeType, 'user'),
          eq(mealPlanStates.scopeId, userId),
          eq(mealPlanStates.planDate, accountState.planDate),
          eq(mealPlanStates.revision, accountState.revision),
        )).returning({ planDate: mealPlanStates.planDate });
        if (deletedState.length !== 1) throw new PlanRecoveryRevisionConflictError();
        if (accountProjection !== undefined) {
          const deletedProjection = await transaction.delete(syncItems).where(and(
            eq(syncItems.id, accountProjection.id),
            eq(syncItems.mutationId, accountProjection.mutationId),
            eq(syncItems.clientUpdatedAt, accountProjection.clientUpdatedAt),
          )).returning({ id: syncItems.id });
          if (deletedProjection.length !== 1) throw new PlanRecoveryRevisionConflictError();
        }
      };
      if (!sourcePairConsistent) {
        await quarantineSource('source_projection_inconsistent');
        continue;
      }
      if (!targetPairConsistent) {
        await quarantineSource('target_projection_inconsistent');
        continue;
      }
      if ((accountState.kind === 'manual' || accountState.kind === 'deleted') && sourceOrder === null) {
        await quarantineSource('manual_tuple_missing');
        continue;
      }
      if (houseState !== undefined && (houseState.kind === 'manual' || houseState.kind === 'deleted')
        && targetOrder === null && accountState.kind !== 'automatic') continue;

      const current = targetState;
      const sourceIsManualState = accountState.kind === 'manual' || accountState.kind === 'deleted';
      const appliesState = current === null || (sourceIsManualState && sourceOrder !== null
        && (targetOrder === null || compareManualPlanOrders(sourceOrder, targetOrder) > 0));
      const losingManualChoice = !appliesState && sourceIsManualState && sourceOrder !== null
        && current !== null && targetOrder !== null
        && compareManualPlanOrders(sourceOrder, targetOrder) <= 0;
      const losingAutomaticProposal = !appliesState && current !== null && accountState.kind === 'automatic';
      if (losingManualChoice || losingAutomaticProposal) {
        if (sourceProjection === null || sourceProjectionState === null || accountProjection === undefined
          || sourceProjectionState.revision !== accountState.revision
          || sourceProjection.mutationId !== accountProjection.mutationId) {
          throw new PlanRecoveryRevisionConflictError();
        }
        const originalCommand = losingManualChoice
          ? manualPlanCommandFromMigration(
            `account:${userId}`,
            accountState.planDate,
            accountState.kind as 'manual' | 'deleted',
            accountState.recipeId,
            sourceOrder!,
          )
          : await (async (): Promise<PlanCommand | null> => {
            const [receipt] = await transaction.select().from(mealPlanReceipts).where(and(
              eq(mealPlanReceipts.scopeType, 'user'),
              eq(mealPlanReceipts.scopeId, userId),
              eq(mealPlanReceipts.actorId, userId),
              eq(mealPlanReceipts.operationId, accountProjection.mutationId),
            )).limit(1).for('update');
            if (receipt === undefined || receipt.commandJson === null) return null;
            let command: PlanCommand;
            try {
              command = assertPlanCommand(receipt.commandJson);
            } catch {
              return null;
            }
            const digest = planCommandDigest(command);
            let receiptDigestValid = false;
            if (receipt.importSource === null) {
              receiptDigestValid = receipt.importSourceId === null && receipt.importLocalRevision === null
                && receipt.commandHash === null && receipt.requestHash === digest;
            } else if ((receipt.importSource === 'guest' || receipt.importSource === 'account')
              && receipt.importSourceId !== null && receipt.importLocalRevision !== null
              && receipt.commandHash === digest) {
              const binding: MealPlanImportBinding = {
                sourceAccountId: userId,
                source: receipt.importSource,
                sourceId: receipt.importSourceId,
                localRevision: receipt.importLocalRevision,
                targetScope: `account:${userId}`,
                commandDigest: digest,
              };
              receiptDigestValid = receipt.requestHash === planImportRequestDigest(binding);
            }
            const resultState = receipt.resultJson.current;
            if (!receiptDigestValid
              || command.scope !== `account:${userId}`
              || command.date !== accountState.planDate
              || command.operationId !== accountProjection.mutationId
              || command.deviceId !== accountProjection.deviceId
              || (command.action !== 'auto_create' && command.action !== 'explicit_regenerate')
              || receipt.resultJson.outcome !== 'applied'
              || receipt.resultJson.operationId !== command.operationId
              || resultState === null
              || canonicalJson(resultState) !== canonicalJson(sourceProjectionState)) return null;
            return command;
          })();
        if (originalCommand === null) {
          await quarantineSource('automatic_command_unverified');
          continue;
        }
        const [priorConflict] = await transaction.select().from(mealPlanMigrationConflicts).where(and(
          eq(mealPlanMigrationConflicts.houseId, houseId),
          eq(mealPlanMigrationConflicts.sourceAccountId, userId),
          eq(mealPlanMigrationConflicts.planDate, accountState.planDate),
          eq(mealPlanMigrationConflicts.sourceRevision, accountState.revision),
        )).limit(1).for('update');
        if (priorConflict !== undefined) {
          if (planCommandDigest(priorConflict.originalCommand) !== planCommandDigest(originalCommand)) {
            throw new PlanRecoveryResolutionReusedError();
          }
        } else {
          const createdAt = options.clock();
          await transaction.insert(mealPlanMigrationConflicts).values({
            houseId,
            sourceAccountId: userId,
            planDate: accountState.planDate,
            sourceRevision: accountState.revision,
            sourceProjectionMutationId: accountProjection.mutationId,
            sourceDeviceId: accountProjection.deviceId,
            sourceClientUpdatedAt: accountProjection.clientUpdatedAt,
            sourceServerUpdatedAt: accountProjection.updatedAt,
            sourceState: sourceProjectionState!,
            sourceProjection: mealPlanProjectionSnapshot(sourceProjection!),
            targetRevision: current.revision,
            targetState: current,
            originalCommand,
            status: 'pending',
            resolutionDigest: null,
            resolutionCommand: null,
            resolutionResult: null,
            resolvedByUserId: null,
            resolvedAt: null,
            createdAt,
          });
        }
        const deletedState = await transaction.delete(mealPlanStates).where(and(
          eq(mealPlanStates.scopeType, 'user'),
          eq(mealPlanStates.scopeId, userId),
          eq(mealPlanStates.planDate, accountState.planDate),
          eq(mealPlanStates.revision, accountState.revision),
        )).returning({ planDate: mealPlanStates.planDate });
        if (deletedState.length !== 1) throw new PlanRecoveryRevisionConflictError();
        const deletedProjection = await transaction.delete(syncItems).where(and(
          eq(syncItems.id, accountProjection.id),
          eq(syncItems.mutationId, accountProjection.mutationId),
          eq(syncItems.clientUpdatedAt, accountProjection.clientUpdatedAt),
        )).returning({ id: syncItems.id });
        if (deletedProjection.length !== 1) throw new PlanRecoveryRevisionConflictError();
        continue;
      }
      if (!appliesState) continue;

      const now = options.clock();
      const serverSequence = await reservePlanSequence(transaction);
      const nextState = createPlanState(accountState.planDate, randomUUID(), serverSequence, accountState.kind, accountState.recipeId);
      const orderForHouse = sourceOrder;
      const manualValues = orderForHouse === null
        ? { manualClientAt: null, manualServerAt: null, manualDeviceId: null, manualOperationId: null }
        : {
          manualClientAt: new Date(orderForHouse.clientUpdatedAt),
          manualServerAt: new Date(orderForHouse.serverUpdatedAt),
          manualDeviceId: orderForHouse.deviceId,
          manualOperationId: orderForHouse.operationId,
        };
      const stateValues = {
        scopeType: 'house' as const,
        scopeId: houseId,
        userScopeId: null,
        houseScopeId: houseId,
        planDate: accountState.planDate,
        revision: nextState.revision,
        kind: nextState.kind,
        recipeId: nextState.recipeId,
        ...manualValues,
      };
      await transaction.insert(mealPlanStates).values(stateValues).onConflictDoUpdate({
        target: [mealPlanStates.scopeType, mealPlanStates.scopeId, mealPlanStates.planDate],
        set: {
          userScopeId: null,
          houseScopeId: houseId,
          revision: stateValues.revision,
          kind: stateValues.kind,
          recipeId: stateValues.recipeId,
          ...manualValues,
        },
      });

      const deviceId = accountProjection?.deviceId ?? orderForHouse?.deviceId ?? 'meal-plan-account-migration';
      const clientUpdatedAt = accountProjection?.clientUpdatedAt ?? (orderForHouse === null ? now : new Date(orderForHouse.clientUpdatedAt));
      const mutationId = accountProjection?.mutationId ?? orderForHouse?.operationId ?? `meal-plan-migration:${randomUUID()}`;
      const projectionValues = {
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'meal_plan_entry' as const,
        entityId: accountState.planDate,
        deviceId,
        payload: nextState,
        deleted: false,
        clientUpdatedAt,
        mutationId,
        serverSequence,
        updatedAt: now,
      };
      if (houseProjection === undefined) {
        await transaction.insert(syncItems).values(projectionValues);
      } else {
        const updatedProjection = await transaction.update(syncItems)
          .set(projectionValues)
          .where(eq(syncItems.id, houseProjection.id))
          .returning({ id: syncItems.id });
        if (updatedProjection.length !== 1) throw new Error('Meal-plan house projection disappeared during migration');
      }

      const deletedState = await transaction.delete(mealPlanStates).where(and(
        eq(mealPlanStates.scopeType, 'user'),
        eq(mealPlanStates.scopeId, userId),
        eq(mealPlanStates.planDate, accountState.planDate),
        eq(mealPlanStates.revision, accountState.revision),
      )).returning({ planDate: mealPlanStates.planDate });
      if (deletedState.length !== 1) throw new PlanRecoveryRevisionConflictError();
      if (accountProjection !== undefined) {
        const deletedProjection = await transaction.delete(syncItems).where(and(
          eq(syncItems.id, accountProjection.id),
          eq(syncItems.mutationId, accountProjection.mutationId),
          eq(syncItems.clientUpdatedAt, accountProjection.clientUpdatedAt),
        )).returning({ id: syncItems.id });
        if (deletedProjection.length !== 1) throw new PlanRecoveryRevisionConflictError();
      }
    }
  };

  const resolveMealPlanScopeInTransaction = async (
    transaction: SyncDatabaseTransaction,
    userId: string,
    requestedScope: SyncMutationScope,
  ): Promise<SyncScope> => {
    await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    if (requestedScope === `account:${userId}`) {
      if (membership !== undefined) throw new PlanScopeInvalidError();
      return userScope(userId);
    }
    if (requestedScope.startsWith('account:')) throw new PlanScopeInvalidError();
    if (membership === undefined) throw new SyncMembershipRequiredError();
    const requestedHouseId = requestedScope.slice('house:'.length);
    if (membership.houseId !== requestedHouseId) throw new PlanScopeInvalidError();
    await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${requestedHouseId} FOR UPDATE`);
    const [currentMembership] = await transaction.select({ id: houseMemberships.id })
      .from(houseMemberships)
      .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, requestedHouseId)))
      .limit(1);
    if (currentMembership === undefined) throw new SyncMembershipRequiredError();
    return { kind: 'house', id: requestedHouseId };
  };

  const isMealPlanV2Enabled = async (): Promise<boolean> => {
    if (!options.mealPlanV2Enabled) return false;
    try {
      const rows = await database.execute(sql`SELECT
        to_regclass('public.meal_plan_states') IS NOT NULL
          AND to_regclass('public.meal_plan_receipts') IS NOT NULL
          AND to_regclass('public.meal_plan_migration_conflicts') IS NOT NULL
          AND (
            SELECT count(*) = 4 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'meal_plan_receipts'
              AND column_name IN ('import_source', 'import_source_id', 'import_local_revision', 'command_hash')
          )
          AND EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'meal_plan_receipts'
              AND indexname = 'meal_plan_receipts_import_source_unique'
          )
          AND EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'sync_items_commit_order'
              AND tgrelid = to_regclass('public.sync_items')
              AND NOT tgisinternal
          )
          AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('public.houses')
              AND attname = 'time_zone_revision'
              AND NOT attisdropped
          ) AS ready`);
      return (rows[0] as { ready?: unknown } | undefined)?.ready === true;
    } catch {
      return false;
    }
  };

  const runDrizzleMealPlanCommand = async (
    transaction: SyncDatabaseTransaction,
    userId: string,
    command: PlanCommand,
    importBinding: MealPlanImportBinding | null = null,
  ): Promise<{ result: PlanResult; importReceipt?: MealPlanImportReceipt }> => {
    await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
    const scope = await resolveMealPlanScopeInTransaction(transaction, userId, command.scope);
    const lockKey = `ikuck:meal-plan:${scopeKey(scope)}`;
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const commandDigest = planCommandDigest(command);
    const binding = importBinding === null ? null : { ...importBinding, commandDigest };
    if (binding !== null && binding.targetScope !== scopeLabel(scope)) throw new PlanScopeInvalidError();
    const requestDigest = binding === null ? commandDigest : planImportRequestDigest(binding);
    const persistedBindingFrom = (row: typeof mealPlanReceipts.$inferSelect): MealPlanImportBinding | null => {
      if (row.importSource === null) {
        if (row.importSourceId !== null || row.importLocalRevision !== null || row.commandHash !== null) {
          throw new PlanOperationIdReusedError();
        }
        return null;
      }
      if ((row.importSource !== 'guest' && row.importSource !== 'account')
        || row.importSourceId === null || row.importLocalRevision === null || row.commandHash === null) {
        throw new PlanOperationIdReusedError();
      }
      return {
        sourceAccountId: userId,
        source: row.importSource,
        sourceId: row.importSourceId,
        localRevision: row.importLocalRevision,
        targetScope: scopeLabel(scope),
        commandDigest: row.commandHash,
      };
    };
    const readReceipt = (row: typeof mealPlanReceipts.$inferSelect) => {
      const persistedBinding = persistedBindingFrom(row);
      if (row.requestHash !== requestDigest || row.commandHash !== (binding?.commandDigest ?? null)
        || canonicalJson(persistedBinding) !== canonicalJson(binding)) {
        throw new PlanOperationIdReusedError();
      }
      if (row.commandJson !== null) {
        let persistedCommand: PlanCommand;
        try {
          persistedCommand = assertPlanCommand(row.commandJson);
        } catch {
          throw new PlanOperationIdReusedError();
        }
        if (canonicalJson(persistedCommand) !== canonicalJson(command)
          || planCommandDigest(persistedCommand) !== (row.commandHash ?? row.requestHash)) {
          throw new PlanOperationIdReusedError();
        }
      }
      const stored: StoredMealPlanReceipt = {
        requestDigest: row.requestHash,
        commandDigest: row.commandHash ?? commandDigest,
        command: row.commandJson === null ? structuredClone(command) : row.commandJson,
        binding: persistedBinding,
        result: row.resultJson,
      };
      return binding === null
        ? { result: structuredClone(stored.result) }
        : { result: structuredClone(stored.result), importReceipt: mealPlanImportReceipt(stored) };
    };
    const [priorReceipt] = await transaction.select().from(mealPlanReceipts).where(and(
      eq(mealPlanReceipts.scopeType, planScopeType(scope)),
      eq(mealPlanReceipts.scopeId, scope.id),
      eq(mealPlanReceipts.actorId, userId),
      eq(mealPlanReceipts.operationId, command.operationId),
    )).limit(1).for('update');
    if (priorReceipt !== undefined) return readReceipt(priorReceipt);

    if (binding !== null) {
      const [priorImportReceipt] = await transaction.select().from(mealPlanReceipts).where(and(
        eq(mealPlanReceipts.scopeType, planScopeType(scope)),
        eq(mealPlanReceipts.scopeId, scope.id),
        eq(mealPlanReceipts.actorId, userId),
        eq(mealPlanReceipts.importSource, binding.source),
        eq(mealPlanReceipts.importSourceId, binding.sourceId),
        eq(mealPlanReceipts.importLocalRevision, binding.localRevision),
      )).limit(1).for('update');
      if (priorImportReceipt !== undefined) return readReceipt(priorImportReceipt);
    }

    const [stateRow] = await transaction.select().from(mealPlanStates).where(and(
      eq(mealPlanStates.scopeType, planScopeType(scope)),
      eq(mealPlanStates.scopeId, scope.id),
      eq(mealPlanStates.planDate, command.date),
    )).limit(1).for('update');
    const [projectionRow] = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, planScopeType(scope)),
      eq(syncItems.scopeId, scope.id),
      eq(syncItems.entityType, 'meal_plan_entry'),
      eq(syncItems.entityId, command.date),
    )).limit(1).for('update');
    if (stateRow !== undefined && projectionRow === undefined) throw new Error('Meal-plan canonical state has no sync projection');
    const current: PlanState | null = stateRow === undefined || projectionRow === undefined
      ? null
      : createPlanState(stateRow.planDate, stateRow.revision, projectionRow.serverSequence, stateRow.kind, stateRow.recipeId);
    const manualOrder: ManualPlanOrder | null = stateRow?.manualClientAt === null || stateRow?.manualClientAt === undefined
      ? null
      : {
        clientUpdatedAt: stateRow.manualClientAt.toISOString(),
        serverUpdatedAt: stateRow.manualServerAt!.toISOString(),
        deviceId: stateRow.manualDeviceId!,
        operationId: stateRow.manualOperationId!,
      };
    const now = options.clock();
    const originalClientTime = Date.parse(command.clientUpdatedAt);
    const normalizedClientUpdatedAt = originalClientTime > now.getTime() + options.maxClientClockSkewMs
      ? now.toISOString()
      : new Date(originalClientTime).toISOString();
    if (normalizedClientUpdatedAt !== new Date(originalClientTime).toISOString()) {
      options.logger.warn('Meal-plan client timestamp exceeded the configured clock skew tolerance');
    }
    const decision = decidePlanCommand(current, manualOrder, command, normalizedClientUpdatedAt, now.toISOString());
    let resolvedState = current;
    if (decision.applies) {
      const serverSequence = await reservePlanSequence(transaction);
      const nextState = createPlanState(command.date, randomUUID(), serverSequence, decision.kind ?? '', decision.recipeId);
      const manual = decision.nextManualOrder ?? manualOrder;
      const scopeColumns = scope.kind === 'house'
        ? { userScopeId: null, houseScopeId: scope.id }
        : { userScopeId: scope.id, houseScopeId: null };
      const canonicalValues = {
        scopeType: planScopeType(scope),
        scopeId: scope.id,
        ...scopeColumns,
        planDate: command.date,
        revision: nextState.revision,
        kind: nextState.kind,
        recipeId: nextState.recipeId,
        manualClientAt: manual === null ? null : new Date(manual.clientUpdatedAt),
        manualServerAt: manual === null ? null : new Date(manual.serverUpdatedAt),
        manualDeviceId: manual?.deviceId ?? null,
        manualOperationId: manual?.operationId ?? null,
      };
      await transaction.insert(mealPlanStates).values(canonicalValues).onConflictDoUpdate({
        target: [mealPlanStates.scopeType, mealPlanStates.scopeId, mealPlanStates.planDate],
        set: {
          revision: canonicalValues.revision,
          kind: canonicalValues.kind,
          recipeId: canonicalValues.recipeId,
          manualClientAt: canonicalValues.manualClientAt,
          manualServerAt: canonicalValues.manualServerAt,
          manualDeviceId: canonicalValues.manualDeviceId,
          manualOperationId: canonicalValues.manualOperationId,
        },
      });
      const projectionValues = {
        userId,
        scopeType: planScopeType(scope),
        scopeId: scope.id,
        entityType: 'meal_plan_entry' as const,
        entityId: command.date,
        deviceId: command.deviceId,
        payload: nextState,
        deleted: false,
        clientUpdatedAt: new Date(normalizedClientUpdatedAt),
        mutationId: command.operationId,
        serverSequence,
        updatedAt: now,
      };
      if (projectionRow === undefined) {
        await transaction.insert(syncItems).values(projectionValues);
      } else {
        const updatedProjection = await transaction.update(syncItems)
          .set(projectionValues)
          .where(eq(syncItems.id, projectionRow.id))
          .returning({ id: syncItems.id });
        if (updatedProjection.length !== 1) throw new Error('Meal-plan sync projection disappeared during command');
      }
      resolvedState = nextState;
    }
    const result: PlanResult = {
      version: 2,
      operationId: command.operationId,
      outcome: decision.applies ? 'applied' : 'conflict',
      current: resolvedState,
    };
    const scopeColumns = scope.kind === 'house'
      ? { userScopeId: null, houseScopeId: scope.id }
      : { userScopeId: scope.id, houseScopeId: null };
    const storedReceipt: StoredMealPlanReceipt = {
      requestDigest,
      commandDigest,
      command: structuredClone(command),
      binding: binding === null ? null : structuredClone(binding),
      result: structuredClone(result),
    };
    await transaction.insert(mealPlanReceipts).values({
      scopeType: planScopeType(scope),
      scopeId: scope.id,
      ...scopeColumns,
      actorId: userId,
      operationId: command.operationId,
      requestHash: requestDigest,
      importSource: binding?.source ?? null,
      importSourceId: binding?.sourceId ?? null,
      importLocalRevision: binding?.localRevision ?? null,
      commandHash: binding?.commandDigest ?? null,
      commandJson: command,
      resultJson: result,
    });
    return binding === null
      ? { result }
      : { result, importReceipt: mealPlanImportReceipt(storedReceipt) };
  };

  return {
    isMealPlanV2Enabled,
    applyMealPlanCommand: async (userId, rawCommand) => {
      const command = assertPlanCommand(rawCommand);
      return database.transaction(async (transaction) =>
        (await runDrizzleMealPlanCommand(transaction, userId, command)).result);
    },
    importMealPlanCommand: async (userId, source, sourceId, localRevision, rawCommand) => {
      const command = assertPlanCommand(rawCommand);
      const binding = createMealPlanImportBinding(userId, source, sourceId, localRevision, command);
      const committed = await database.transaction(async (transaction) =>
        runDrizzleMealPlanCommand(transaction, userId, command, binding));
      if (committed.importReceipt === undefined) throw new PlanOperationIdReusedError();
      return committed.importReceipt;
    },
    readMealPlanStates: async (userId, requestedScope, dates) => database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
      const scope = await resolveMealPlanScopeInTransaction(transaction, userId, requestedScope);
      const lockKey = `ikuck:meal-plan:${scopeKey(scope)}`;
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [pending] = await transaction.select().from(houseMigrationPending).where(eq(houseMigrationPending.userId, userId)).limit(1);
      if (pending !== undefined) throw new HouseMigrationPendingError();
      if (dates.length === 0) return { version: 2, states: [] };
      if (scope.kind === 'house') {
        const quarantined = await transaction.select({ planDate: mealPlanMigrationQuarantines.planDate }).from(mealPlanMigrationQuarantines).where(and(
          eq(mealPlanMigrationQuarantines.houseId, scope.id),
          eq(mealPlanMigrationQuarantines.sourceAccountId, userId),
          inArray(mealPlanMigrationQuarantines.planDate, [...dates]),
        ));
        if (quarantined.length > 0) throw new PlanMigrationQuarantinedError();
      }
      const stateRows = await transaction.select().from(mealPlanStates).where(and(
        eq(mealPlanStates.scopeType, planScopeType(scope)),
        eq(mealPlanStates.scopeId, scope.id),
        inArray(mealPlanStates.planDate, [...dates]),
      ));
      const projectionRows = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, planScopeType(scope)),
        eq(syncItems.scopeId, scope.id),
        eq(syncItems.entityType, 'meal_plan_entry'),
        inArray(syncItems.entityId, [...dates]),
        eq(syncItems.deleted, false),
      ));
      const stateByDate = new Map(stateRows.map((row) => [row.planDate, row]));
      const sequenceByDate = new Map(projectionRows.map((row) => [row.entityId, row.serverSequence]));
      return {
        version: 2,
        states: dates.map((date) => {
          const row = stateByDate.get(date);
          if (row === undefined) return { date, state: null };
          const serverSequence = sequenceByDate.get(date);
          if (serverSequence === undefined) throw new Error('Meal-plan canonical state has no sync projection');
          return {
            date,
            state: createPlanState(row.planDate, row.revision, serverSequence, row.kind, row.recipeId),
          };
        }),
      };
    }),
    readMealPlanRecovery: async (userId) => database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
      const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
        .from(houseMemberships).where(eq(houseMemberships.userId, userId)).limit(1);
      if (membership === undefined) throw new SyncMembershipRequiredError();
      let scope = await resolveMealPlanScopeInTransaction(transaction, userId, `house:${membership.houseId}`);
      const lockKey = `ikuck:meal-plan:${scopeKey(scope)}`;
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      scope = await resolveMealPlanScopeInTransaction(transaction, userId, `house:${membership.houseId}`);
      const [conflictRows, quarantineRows] = await Promise.all([
        transaction.select().from(mealPlanMigrationConflicts).where(and(
          eq(mealPlanMigrationConflicts.houseId, scope.id),
          eq(mealPlanMigrationConflicts.status, 'pending'),
        )).orderBy(asc(mealPlanMigrationConflicts.createdAt), asc(mealPlanMigrationConflicts.planDate)),
        transaction.select().from(mealPlanMigrationQuarantines).where(and(
          eq(mealPlanMigrationQuarantines.houseId, scope.id),
          eq(mealPlanMigrationQuarantines.sourceAccountId, userId),
        )).orderBy(asc(mealPlanMigrationQuarantines.createdAt), asc(mealPlanMigrationQuarantines.planDate)),
      ]);
      const conflicts = conflictRows.map((row) => structuredClone(publicMealPlanMigrationConflict(
        fromDatabaseMealPlanMigrationConflict(row),
      )));
      const quarantines = quarantineRows.map((row): MealPlanMigrationQuarantineView => ({
        planDate: row.planDate,
        reasonCode: row.reasonCode,
        sourceSnapshot: {
          state: row.rawSourceState as PlanState | null,
          projection: row.rawSourceProjection as MealPlanMigrationProjectionSnapshot | null,
        },
        targetSnapshot: {
          state: row.rawTargetState as PlanState | null,
          projection: row.rawTargetProjection as MealPlanMigrationProjectionSnapshot | null,
        },
        observed: { manualTuple: null, command: null },
        createdAt: row.createdAt.toISOString(),
      }));
      return [...conflicts, ...quarantines].sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.planDate.localeCompare(right.planDate),
      );
    }),
    resolveMealPlanRecovery: async (userId, conflictId, resolution) => database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
      const [candidate] = await transaction.select({ houseId: mealPlanMigrationConflicts.houseId })
        .from(mealPlanMigrationConflicts).where(eq(mealPlanMigrationConflicts.id, conflictId)).limit(1);
      if (candidate === undefined) throw new PlanRecoveryNotFoundError();
      let scope = await resolveMealPlanScopeInTransaction(transaction, userId, `house:${candidate.houseId}`);
      const lockKey = `ikuck:meal-plan:${scopeKey(scope)}`;
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      scope = await resolveMealPlanScopeInTransaction(transaction, userId, `house:${candidate.houseId}`);
      const [row] = await transaction.select().from(mealPlanMigrationConflicts)
        .where(eq(mealPlanMigrationConflicts.id, conflictId)).limit(1).for('update');
      if (row === undefined || row.houseId !== scope.id) throw new PlanRecoveryNotFoundError();
      const conflict = fromDatabaseMealPlanMigrationConflict(row);
      const command = assertPlanCommand(resolution.command);
      if ((command.action !== 'manual_set' && command.action !== 'manual_delete')
        || command.scope !== `house:${scope.id}` || command.date !== conflict.planDate) {
        throw new PlanCommandValidationError();
      }
      const digest = planRecoveryResolutionDigest({ ...resolution, command });
      if (conflict.status === 'resolved') {
        if (conflict.resolutionDigest !== digest || conflict.resolutionResult === null) {
          throw new PlanRecoveryResolutionReusedError();
        }
        return structuredClone(conflict.resolutionResult);
      }
      if (resolution.expectedSourceRevision !== conflict.sourceRevision) throw new PlanRecoveryRevisionConflictError();
      const [stateRow] = await transaction.select().from(mealPlanStates).where(and(
        eq(mealPlanStates.scopeType, 'house'),
        eq(mealPlanStates.scopeId, scope.id),
        eq(mealPlanStates.planDate, conflict.planDate),
      )).limit(1).for('update');
      const [projectionRow] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, scope.id),
        eq(syncItems.entityType, 'meal_plan_entry'),
        eq(syncItems.entityId, conflict.planDate),
        eq(syncItems.deleted, false),
      )).limit(1).for('update');
      if (stateRow === undefined || projectionRow === undefined
        || stateRow.revision !== resolution.expectedTargetRevision) {
        throw new PlanRecoveryRevisionConflictError();
      }
      const result = (await runDrizzleMealPlanCommand(transaction, userId, command)).result;
      if (result.outcome === 'applied') {
        const resolvedAt = options.clock();
        const updated = await transaction.update(mealPlanMigrationConflicts).set({
          status: 'resolved',
          resolutionDigest: digest,
          resolutionCommand: command,
          resolutionResult: result,
          resolvedByUserId: userId,
          resolvedAt,
        }).where(and(
          eq(mealPlanMigrationConflicts.id, conflictId),
          eq(mealPlanMigrationConflicts.status, 'pending'),
          eq(mealPlanMigrationConflicts.sourceRevision, resolution.expectedSourceRevision),
        )).returning({ id: mealPlanMigrationConflicts.id });
        if (updated.length !== 1) throw new PlanRecoveryRevisionConflictError();
      }
      return result;
    }),
    updateAiConsent: async (userId, update) => database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${aiConsentLockKey(userId)}, 0))`);
      await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
      const [existingRow] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'user'),
        eq(syncItems.scopeId, userId),
        eq(syncItems.entityType, 'ai_consent'),
        eq(syncItems.entityId, 'profile'),
      )).limit(1).for('update');
      const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
      const current = currentConsentFromItem(existing);
      const currentRevision = consentRevisionFromItem(existing, current);
      assertCurrentConsentRevision(update, currentRevision);
      const now = nextConsentTimestamp(options.clock, currentRevision);
      const consent = applyAiConsentUpdate(current, update, now.toISOString());
      const mutationId = randomUUID();
      const values = {
        userId,
        scopeType: 'user' as const,
        scopeId: userId,
        entityType: 'ai_consent' as const,
        entityId: 'profile',
        deviceId: 'api-ai-recipes',
        payload: consent,
        deleted: false,
        clientUpdatedAt: now,
        updatedAt: now,
        mutationId,
      };
      await transaction.insert(processedSyncMutations).values({
        userId,
        scopeType: 'user',
        scopeId: userId,
        mutationId,
      });
      if (existingRow === undefined) await transaction.insert(syncItems).values(values);
      else await transaction.update(syncItems).set({
        ...values,
        serverSequence: sql`nextval('sync_server_sequence')`,
      }).where(eq(syncItems.id, existingRow.id));
      return consent;
    }),
    withAiConsentDispatch: async (userId, requirement, dispatch, signal) => withDatabaseAiConsentDispatchLock(userId, signal, async (connection) => {
      const rows = await connection`SELECT payload, deleted FROM sync_items
        WHERE scope_type = 'user' AND scope_id = ${userId}
          AND entity_type = 'ai_consent' AND entity_id = 'profile'
        LIMIT 1`;
      const row = rows[0] as { payload: unknown; deleted: boolean } | undefined;
      const current = row !== undefined && !row.deleted && isAiConsent(row.payload) ? row.payload : null;
      if (current === null || !current.enabled
        || (requirement.kind === 'home' && current.homeProvider !== requirement.provider)
        || (requirement.kind === 'dinner' && current.dinnerProvider !== requirement.provider)
        || (requirement.kind === 'chat' && (current.chatProvider !== requirement.provider || current.chatPolicyVersion !== requirement.policyVersion))) {
        throw new AiConsentRequiredError();
      }
      return dispatch(current);
    }),
    consumeDinner: async (userId, request) => {
      assertDinnerConsumptionRequest(request);
      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
          const scope = await resolveTransactionScope(transaction, userId, {
            entityType: 'pantry_lot',
            syncScope: request.command.scope as SyncMutationScope,
          });
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pantryScopeLockKey(scope)}, 0))`);
          const requestDigest = dinnerConsumptionRequestDigest(request);
          const [operationReceipt] = await transaction.select().from(dinnerConsumptionReceipts)
            .where(eq(dinnerConsumptionReceipts.operationId, request.command.operationId)).limit(1).for('update');
          const [entryReceipt] = await transaction.select().from(dinnerConsumptionReceipts).where(and(
            eq(dinnerConsumptionReceipts.scopeType, scope.kind),
            eq(dinnerConsumptionReceipts.scopeId, scope.id),
            eq(dinnerConsumptionReceipts.entryId, request.command.entryId),
          )).limit(1).for('update');

          if (operationReceipt !== undefined || entryReceipt !== undefined) {
            if (operationReceipt === undefined || entryReceipt === undefined
              || operationReceipt.operationId !== entryReceipt.operationId
              || operationReceipt.entryId !== request.command.entryId
              || operationReceipt.scopeType !== scope.kind || operationReceipt.scopeId !== scope.id
              || operationReceipt.requestDigest !== requestDigest) throw new DinnerConsumptionConflictError();
            const [entryRow] = await transaction.select().from(syncItems).where(and(
              eq(syncItems.scopeType, scope.kind),
              eq(syncItems.scopeId, scope.id),
              eq(syncItems.entityType, 'dinner_entry'),
              eq(syncItems.entityId, request.command.entryId),
            )).limit(1);
            if (entryRow === undefined || entryRow.deleted || !isDinnerEntry(entryRow.payload)) throw new DinnerConsumptionConflictError();
            const [eventRow] = await transaction.select().from(syncItems).where(and(
              eq(syncItems.scopeType, scope.kind),
              eq(syncItems.scopeId, scope.id),
              eq(syncItems.entityType, 'cook_event'),
              eq(syncItems.entityId, request.command.entryId),
            )).limit(1);
            const cookEvent = eventRow !== undefined && !eventRow.deleted && isCookEvent(eventRow.payload)
              ? eventRow.payload : undefined;
            const currentPantryRows = await transaction.select().from(syncItems).where(and(
              eq(syncItems.scopeType, scope.kind),
              eq(syncItems.scopeId, scope.id),
              inArray(syncItems.entityType, [...pantryTypes]),
            ));
            const receipt: DinnerConsumptionReceipt = {
              operationId: operationReceipt.operationId,
              entryId: operationReceipt.entryId,
              scope: scopeLabel(scope),
              committedAt: operationReceipt.committedAt.toISOString(),
              plan: operationReceipt.plan,
            };
            return {
              duplicate: true,
              entry: entryRow.payload,
              ...(cookEvent === undefined ? {} : { cookEvent }),
              pantrySnapshot: pantrySnapshotFromStoredItems(currentPantryRows.map(fromDatabaseItem)),
              receipt,
              plan: receipt.plan,
            };
          }

          const processedMutationId = consumptionProcessedMutationId(request.command.operationId);
          const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
            .from(processedSyncMutations).where(and(
              eq(processedSyncMutations.scopeType, scope.kind),
              eq(processedSyncMutations.scopeId, scope.id),
              eq(processedSyncMutations.mutationId, processedMutationId),
            )).limit(1);
          if (alreadyProcessed !== undefined) throw new DinnerConsumptionConflictError();
          const [existingEntry] = await transaction.select({ id: syncItems.id }).from(syncItems).where(and(
            eq(syncItems.scopeType, scope.kind),
            eq(syncItems.scopeId, scope.id),
            eq(syncItems.entityType, 'dinner_entry'),
            eq(syncItems.entityId, request.command.entryId),
          )).limit(1).for('update');
          const [existingCookEvent] = await transaction.select({ id: syncItems.id }).from(syncItems).where(and(
            eq(syncItems.scopeType, scope.kind),
            eq(syncItems.scopeId, scope.id),
            eq(syncItems.entityType, 'cook_event'),
            eq(syncItems.entityId, request.command.entryId),
          )).limit(1).for('update');
          if (existingEntry !== undefined || existingCookEvent !== undefined) throw new DinnerConsumptionConflictError();

          const pantryRows = await transaction.select().from(syncItems).where(and(
            eq(syncItems.scopeType, scope.kind),
            eq(syncItems.scopeId, scope.id),
            inArray(syncItems.entityType, [...pantryTypes]),
          ));
          const pantryItems = pantryRows.map(fromDatabaseItem);
          const lots = pantryItems.map(storedPantryLot).filter((lot): lot is PantryLot => lot !== null);
          const now = options.clock();
          const committedAt = now.toISOString();
          const plan = planPantryConsumption({ lots, command: request.command, updatedAt: committedAt });
          const writeChange = async (
            entityType: SyncMutation['entityType'],
            entityId: string,
            payload: unknown | null,
            deleted: boolean,
          ): Promise<void> => {
            const [existing] = await transaction.select().from(syncItems).where(and(
              eq(syncItems.scopeType, scope.kind),
              eq(syncItems.scopeId, scope.id),
              eq(syncItems.entityType, entityType),
              eq(syncItems.entityId, entityId),
            )).limit(1).for('update');
            const values = {
              userId,
              scopeType: scope.kind,
              scopeId: scope.id,
              entityType,
              entityId,
              deviceId: 'api-dinner-consumption',
              payload: deleted ? null : payload,
              deleted,
              clientUpdatedAt: now,
              updatedAt: now,
              mutationId: randomUUID(),
            };
            if (existing === undefined) await transaction.insert(syncItems).values(values);
            else await transaction.update(syncItems).set({
              ...values,
              serverSequence: sql`nextval('sync_server_sequence')`,
            }).where(eq(syncItems.id, existing.id));
          };

          for (const lotId of plan.deleteLotIds) {
            const source = pantryItems.find((item) => storedPantryLot(item)?.id === lotId);
            if (source !== undefined) await writeChange(source.entityType, source.entityId, null, true);
          }
          for (const lot of plan.upsertLots) await writeChange('pantry_lot', lot.id, lot, false);
          const savedEntry: DinnerEntry = { ...request.entry, authorId: userId };
          await writeChange('dinner_entry', savedEntry.id, savedEntry, false);
          if (request.cookEvent !== undefined) await writeChange('cook_event', request.cookEvent.id, request.cookEvent, false);
          await transaction.insert(processedSyncMutations).values({
            userId,
            scopeType: scope.kind,
            scopeId: scope.id,
            mutationId: processedMutationId,
          });
          await transaction.insert(dinnerConsumptionReceipts).values({
            operationId: request.command.operationId,
            entryId: request.command.entryId,
            scopeType: scope.kind,
            scopeId: scope.id,
            requestDigest,
            committedAt: now,
            createdByUserId: userId,
            plan,
          });
          const savedPantryRows = await transaction.select().from(syncItems).where(and(
            eq(syncItems.scopeType, scope.kind),
            eq(syncItems.scopeId, scope.id),
            inArray(syncItems.entityType, [...pantryTypes]),
          ));
          const receipt: DinnerConsumptionReceipt = {
            operationId: request.command.operationId,
            entryId: request.command.entryId,
            scope: scopeLabel(scope),
            committedAt,
            plan,
          };
          return {
            duplicate: false,
            entry: savedEntry,
            ...(request.cookEvent === undefined ? {} : { cookEvent: request.cookEvent }),
            pantrySnapshot: pantrySnapshotFromStoredItems(savedPantryRows.map(fromDatabaseItem)),
            receipt,
            plan,
          };
        });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) throw new DinnerConsumptionConflictError();
        throw error;
      }
    },
    applyMutation: async (userId, mutation) => {
      if (mutation.entityType === 'meal_plan_entry') throw new PlanCommandRequiredError();
      const prepared = prepareMutation(mutation, options);
      const apply = () => database.transaction(async (transaction) => {
        const validMutation = prepared.mutation;
        if (validMutation.entityType === 'ai_consent') {
          await transaction.execute(sql`SET LOCAL lock_timeout = '30s'`);
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${aiConsentLockKey(userId)}, 0))`);
          await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`);
        }
        const scope = await resolveTransactionScope(transaction, userId, validMutation);
        if (pantryItemTypes.has(validMutation.entityType)) {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pantryScopeLockKey(scope)}, 0))`);
        }
        if (validMutation.entityType === 'meal_plan_entry') {
          // Serialize both receipt lookup and LWW read/write, including missing rows.
          // The scope-wide lock also makes concurrent mutation-id replays idempotent.
          const lockKey = `ikuck:meal-plan:${scopeKey(scope)}`;
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        }
        const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
          .from(processedSyncMutations)
          .where(and(
            eq(processedSyncMutations.scopeType, scope.kind),
            eq(processedSyncMutations.scopeId, scope.id),
            eq(processedSyncMutations.mutationId, validMutation.mutationId),
          ))
          .limit(1);
        if (alreadyProcessed !== undefined) return { applied: false, change: null };

        await transaction.insert(processedSyncMutations).values({
          userId,
          scopeType: scope.kind,
          scopeId: scope.id,
          mutationId: validMutation.mutationId,
        });
        if (scope.kind === 'user' && validMutation.entityType === 'dinner_entry') {
          await transaction.execute(sql`SELECT id FROM ${syncItems} WHERE ${syncItems.scopeType} = ${scope.kind}
            AND ${syncItems.scopeId} = ${scope.id} AND ${syncItems.entityType} = ${validMutation.entityType}
            AND ${syncItems.entityId} = ${validMutation.entityId} FOR UPDATE`);
        }
        const [existingRow] = await transaction.select().from(syncItems).where(and(
          eq(syncItems.scopeType, scope.kind),
          eq(syncItems.scopeId, scope.id),
          eq(syncItems.entityType, validMutation.entityType),
          eq(syncItems.entityId, validMutation.entityId),
        )).limit(1);
        const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
        if (validMutation.entityType === 'ai_consent') {
          if (validMutation.operation === 'upsert' && isAiConsent(validMutation.payload)
            && validMutation.payload.enabled) return { applied: false, change: null };

          const current = currentConsentFromItem(existing);
          const revision = consentRevisionFromItem(existing, current);
          const now = nextConsentTimestamp(options.clock, revision);
          const consent = applyAiConsentUpdate(current, { enabled: false }, now.toISOString());
          const values = {
            userId,
            scopeType: 'user' as const,
            scopeId: userId,
            entityType: 'ai_consent' as const,
            entityId: 'profile',
            deviceId: validMutation.deviceId,
            payload: consent,
            deleted: false,
            clientUpdatedAt: now,
            updatedAt: now,
            mutationId: validMutation.mutationId,
          };
          const [saved] = existing === null
            ? await transaction.insert(syncItems).values(values).returning()
            : await transaction.update(syncItems).set({
              ...values,
              serverSequence: sql`nextval('sync_server_sequence')`,
            }).where(eq(syncItems.id, existingRow!.id)).returning();
          return { applied: true, change: toChange(fromDatabaseItem(saved)) };
        }
        const normalizedMutation = normalizeDiaryMutation(userId, validMutation, existing);
        const normalizedPrepared = { ...prepared, mutation: normalizedMutation };
        const winsExisting = existing === null || wins(normalizedPrepared, existing);
        const staleRecipeLinkMutation = existing !== null && !winsExisting
          ? mergeStaleDinnerRecipeLinks(normalizedMutation, existing)
          : null;
        if (!winsExisting && staleRecipeLinkMutation === null) return { applied: false, change: null };
        const mutationToApply = staleRecipeLinkMutation ?? normalizedMutation;

        const values = {
          userId,
          scopeType: scope.kind,
          scopeId: scope.id,
          entityType: mutationToApply.entityType,
          entityId: mutationToApply.entityId,
          deviceId: mutationToApply.deviceId,
          payload: mutationToApply.operation === 'delete' && !isDiaryEntityType(validMutation.entityType) ? null : mutationToApply.payload,
          deleted: mutationToApply.operation === 'delete',
          clientUpdatedAt: new Date(mutationToApply.clientUpdatedAt),
          updatedAt: prepared.serverUpdatedAt,
          mutationId: mutationToApply.mutationId,
        };
        const [saved] = existing === null
          ? await transaction.insert(syncItems).values(values).returning()
          : await transaction.update(syncItems).set({
            ...values,
            serverSequence: sql`nextval('sync_server_sequence')`,
            updatedAt: prepared.serverUpdatedAt,
          }).where(eq(syncItems.id, existingRow!.id)).returning();
        const item = fromDatabaseItem(saved);
        return { applied: true, change: toChange(item) };
      });
      return apply();
    },

  readChanges: async (userId, cursor, limit, requestedScope, supportedEntityTypes) => database.transaction(async (transaction) => {
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    let currentHouse: SyncScope | null = null;
    if (membership !== undefined) {
      const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
      if (houseRows.length > 0) {
        const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
          .from(houseMemberships)
          .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
          .limit(1);
        if (currentMembership !== undefined) currentHouse = { kind: 'house', id: currentMembership.houseId };
      }
    }
    let mode: ReadScopeMode;
    let scopes: SyncScope[];
    if (requestedScope === `account:${userId}`) {
      mode = 'account';
      scopes = [userScope(userId)];
      if (currentHouse !== null && supportedEntityTypes?.some(isSharedEntityType) === true) {
        throw new SyncScopeInvalidError();
      }
    } else if (requestedScope?.startsWith('account:')) {
      throw new SyncMembershipRequiredError();
    } else if (requestedScope?.startsWith('house:')) {
      if (currentHouse === null || requestedScope !== `house:${currentHouse.id}`) throw new SyncMembershipRequiredError();
      if (supportedEntityTypes?.some((type) => !isSharedEntityType(type)) === true) throw new SyncScopeInvalidError();
      mode = 'house';
      scopes = [currentHouse];
    } else if (currentHouse !== null) {
      mode = 'composite';
      scopes = [userScope(userId), currentHouse];
    } else {
      mode = 'account';
      scopes = [userScope(userId)];
    }
    const [pending] = await transaction.select().from(houseMigrationPending).where(eq(houseMigrationPending.userId, userId)).limit(1);
    if (pending !== undefined) {
      if (requestedScope === `account:${userId}`) {
        if (supportedEntityTypes?.some(isSharedEntityType) === true) throw new HouseMigrationPendingError();
      } else {
        throw new HouseMigrationPendingError();
      }
    }
    if (currentHouse !== null && supportedEntityTypes?.includes('meal_plan_entry') === true) {
      const quarantined = await transaction.select({ planDate: mealPlanMigrationQuarantines.planDate }).from(mealPlanMigrationQuarantines).where(and(
        eq(mealPlanMigrationQuarantines.houseId, currentHouse.id),
        eq(mealPlanMigrationQuarantines.sourceAccountId, userId),
      ));
      if (quarantined.length > 0) throw new PlanMigrationQuarantinedError();
    }
    const sharedEntityCondition = inArray(syncItems.entityType, [...HOUSE_SYNC_ENTITY_TYPES]);
    const personalEntityCondition = sql`NOT (${sharedEntityCondition})`;
    const scopeCondition = mode === 'composite'
      ? or(
        and(eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, userId), personalEntityCondition),
        and(eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, currentHouse!.id), sharedEntityCondition),
      )
      : scopes.length === 1
      ? and(eq(syncItems.scopeType, scopes[0]!.kind), eq(syncItems.scopeId, scopes[0]!.id))
      : or(...scopes.map((scope) => and(eq(syncItems.scopeType, scope.kind), eq(syncItems.scopeId, scope.id))));
    const planProjectionCondition = sql`(${syncItems.entityType} <> 'meal_plan_entry' OR (
      ${syncItems.payload}->>'date' = ${syncItems.entityId}
      AND ${syncItems.payload}->>'serverSequence' = ${syncItems.serverSequence}::text
      AND ${syncItems.payload}->>'revision' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND ((${syncItems.payload}->>'kind' = 'deleted' AND ${syncItems.payload}->>'recipeId' IS NULL)
        OR (${syncItems.payload}->>'kind' IN ('automatic', 'manual') AND COALESCE(${syncItems.payload}->>'recipeId', '') <> ''))
    ))`;
    const scopedEntityCondition = mode === 'account' && currentHouse !== null
      ? personalEntityCondition
      : mode === 'house' ? sharedEntityCondition : undefined;
    const rows = await transaction.select().from(syncItems).where(and(
      scopeCondition,
      gt(syncItems.serverSequence, cursor),
      supportedEntityTypes === undefined ? undefined : inArray(syncItems.entityType, [...supportedEntityTypes]),
      planProjectionCondition,
      scopedEntityCondition,
    )).orderBy(asc(syncItems.serverSequence)).limit(limit);
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  }),

  readAll: async (userId) => database.transaction(async (transaction) => {
    let currentHouse: SyncScope | null = null;
    const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
      .from(houseMemberships)
      .where(eq(houseMemberships.userId, userId))
      .limit(1);
    if (membership !== undefined) {
      const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
      if (houseRows.length > 0) {
        const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
          .from(houseMemberships)
          .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
          .limit(1);
        if (currentMembership !== undefined) currentHouse = { kind: 'house', id: currentMembership.houseId };
      }
    }
    const [pending] = await transaction.select().from(houseMigrationPending).where(eq(houseMigrationPending.userId, userId)).limit(1);
    if (pending !== undefined) throw new HouseMigrationPendingError();
    const sharedEntityCondition = inArray(syncItems.entityType, [...HOUSE_SYNC_ENTITY_TYPES]);
    const personalEntityCondition = sql`NOT (${sharedEntityCondition})`;
    const scopeCondition = currentHouse === null
      ? and(eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, userId))
      : or(
        and(eq(syncItems.scopeType, 'user'), eq(syncItems.scopeId, userId), personalEntityCondition),
        and(eq(syncItems.scopeType, 'house'), eq(syncItems.scopeId, currentHouse.id), sharedEntityCondition),
      );
    const rows = await transaction.select().from(syncItems)
      .where(scopeCondition)
      .orderBy(asc(syncItems.serverSequence));
    return rows.map((row) => toChange(fromDatabaseItem(row)));
  }),

  readEntity: async (userId, entityType, entityId) => database.transaction(async (transaction) => {
    if (entityType === 'meal_plan_entry') {
      const [pending] = await transaction.select().from(houseMigrationPending).where(eq(houseMigrationPending.userId, userId)).limit(1);
      if (pending !== undefined) throw new HouseMigrationPendingError();
    }
    let scope: SyncScope = userScope(userId);
    if (isSharedEntityType(entityType)) {
      const [membership] = await transaction.select({ houseId: houseMemberships.houseId })
        .from(houseMemberships)
        .where(eq(houseMemberships.userId, userId))
        .limit(1);
      if (membership !== undefined) {
        const houseRows = await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${membership.houseId} FOR SHARE`);
        if (houseRows.length > 0) {
          const [currentMembership] = await transaction.select({ houseId: houseMemberships.houseId })
            .from(houseMemberships)
            .where(and(eq(houseMemberships.userId, userId), eq(houseMemberships.houseId, membership.houseId)))
            .limit(1);
          if (currentMembership !== undefined) scope = { kind: 'house', id: currentMembership.houseId };
        }
      }
    }
    const [row] = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, scope.kind),
      eq(syncItems.scopeId, scope.id),
      eq(syncItems.entityType, entityType),
      eq(syncItems.entityId, entityId),
    )).limit(1);
    return row === undefined ? null : fromDatabaseItem(row);
  }),

  mergeUserPantryToHouse: (userId, houseId) => mergeDatabasePantry(userId, houseId, {
    lots: [],
    stapleIds: [],
    includePersonalRows: true,
  }),

  mergeGuestPantryToHouse: (userId, houseId, input) => mergeDatabasePantry(userId, houseId, {
    lots: input.lots,
    stapleIds: input.stapleIds,
    deviceId: input.deviceId,
    includePersonalRows: false,
  }),

  mergeGuestDietProfileToHouse: async (userId, houseId, mutation) => {
    const valid = validateGuestDietProfileMutation(mutation);
    const prepared = prepareMutation(valid, options);
    return database.transaction(async (transaction) => {
      // Keep the same user → house → membership lock order as migration and deletion.
      await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
      const members = await transaction.execute(sql`SELECT id FROM ${houseMemberships} WHERE user_id = ${userId} AND house_id = ${houseId} FOR UPDATE`);
      if (members.length === 0) throw new SyncMembershipRequiredError();

      const [alreadyProcessed] = await transaction.select({ id: processedSyncMutations.id })
        .from(processedSyncMutations)
        .where(and(
          eq(processedSyncMutations.scopeType, 'house'),
          eq(processedSyncMutations.scopeId, houseId),
          eq(processedSyncMutations.mutationId, valid.mutationId),
        ))
        .limit(1);
      if (alreadyProcessed !== undefined) return false;
      await transaction.insert(processedSyncMutations).values({
        userId, scopeType: 'house', scopeId: houseId, mutationId: valid.mutationId,
      });

      const [existingRow] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        eq(syncItems.entityType, 'diet_profile'),
        eq(syncItems.entityId, 'profile'),
      )).limit(1).for('update');
      const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
      const guestProfile = valid.payload as DietProfile;
      const merged = existing !== null && !existing.deleted
        ? mergeDietProfiles(existing.payload, guestProfile) ?? guestProfile
        : guestProfile;
      const values = {
        userId,
        scopeType: 'house' as const,
        scopeId: houseId,
        entityType: 'diet_profile' as const,
        entityId: 'profile',
        deviceId: valid.deviceId,
        payload: merged,
        deleted: false,
        clientUpdatedAt: new Date(prepared.mutation.clientUpdatedAt),
        updatedAt: prepared.serverUpdatedAt,
        mutationId: valid.mutationId,
      };
      if (existingRow === undefined) await transaction.insert(syncItems).values(values);
      else await transaction.update(syncItems).set({ ...values, serverSequence: sql`nextval('sync_server_sequence')` }).where(eq(syncItems.id, existingRow.id));
      return true;
    });
  },

  migrateUserSharedDataToHouse: async (userId, houseId, pendingAccountMutations = []) => database.transaction(async (transaction) => {
    const pending = validatePendingAccountMutations(userId, pendingAccountMutations);
    if (pending.length > 0) {
      // Match the migration/deletion lock order before inserting account rows;
      // the whole replay and semantic migration commits or rolls back together.
      await transaction.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR SHARE`);
      await transaction.execute(sql`SELECT id FROM ${houses} WHERE id = ${houseId} FOR UPDATE`);
      const member = await transaction.execute(sql`SELECT id FROM ${houseMemberships} WHERE user_id = ${userId} AND house_id = ${houseId} FOR UPDATE`);
      if (member.length === 0) throw new SyncMembershipRequiredError();
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${pantryScopeLockKey(userScope(userId))}, 0))`);
      for (const mutation of pending) {
        const [processed] = await transaction.select({ id: processedSyncMutations.id }).from(processedSyncMutations).where(and(
          eq(processedSyncMutations.scopeType, 'user'),
          eq(processedSyncMutations.scopeId, userId),
          eq(processedSyncMutations.mutationId, mutation.mutationId),
        )).limit(1);
        if (processed !== undefined) continue;
        const prepared = prepareMutation(mutation, options);
        const [existingRow] = await transaction.select().from(syncItems).where(and(
          eq(syncItems.scopeType, 'user'),
          eq(syncItems.scopeId, userId),
          eq(syncItems.entityType, mutation.entityType),
          eq(syncItems.entityId, mutation.entityId),
        )).limit(1).for('update');
        const existing = existingRow === undefined ? null : fromDatabaseItem(existingRow);
        const normalized = normalizeDiaryMutation(userId, prepared.mutation, existing);
        await transaction.insert(processedSyncMutations).values({ userId, scopeType: 'user', scopeId: userId, mutationId: mutation.mutationId });
        if (existing !== null && !wins({ ...prepared, mutation: normalized }, existing)) continue;
        const values = {
          userId,
          scopeType: 'user' as const,
          scopeId: userId,
          entityType: normalized.entityType,
          entityId: normalized.entityId,
          deviceId: normalized.deviceId,
          payload: normalized.operation === 'delete' && !isDiaryEntityType(normalized.entityType) ? null : normalized.payload,
          deleted: normalized.operation === 'delete',
          clientUpdatedAt: new Date(normalized.clientUpdatedAt),
          updatedAt: prepared.serverUpdatedAt,
          mutationId: normalized.mutationId,
        };
        if (existingRow === undefined) await transaction.insert(syncItems).values(values);
        else await transaction.update(syncItems).set({ ...values, serverSequence: sql`nextval('sync_server_sequence')` }).where(eq(syncItems.id, existingRow.id));
      }
    }
    await mergeDatabasePantryInTransaction(transaction, userId, houseId, {
      lots: [],
      stapleIds: [],
      includePersonalRows: true,
    });
    await migrateUserMealPlanToHouse(transaction, userId, houseId);
    const nonPantryEntityTypes = [...AUTO_MIGRATED_ENTITY_TYPES]
      .filter((entityType) => entityType !== 'meal_plan_entry' && !pantryTypes.has(entityType));
    const personalRows = await transaction.select().from(syncItems).where(and(
      eq(syncItems.scopeType, 'user'),
      eq(syncItems.scopeId, userId),
      inArray(syncItems.entityType, nonPantryEntityTypes),
    )).for('update');
    for (const personalRow of personalRows) {
      const [houseRow] = await transaction.select().from(syncItems).where(and(
        eq(syncItems.scopeType, 'house'),
        eq(syncItems.scopeId, houseId),
        eq(syncItems.entityType, personalRow.entityType),
        eq(syncItems.entityId, personalRow.entityId),
      )).limit(1).for('update');
      const existing = houseRow === undefined ? null : fromDatabaseItem(houseRow);
      const incoming: PreparedMutation = {
        mutation: {
          mutationId: personalRow.mutationId,
          deviceId: personalRow.deviceId,
          entityType: personalRow.entityType as SyncMutation['entityType'],
          entityId: personalRow.entityId,
          operation: personalRow.deleted ? 'delete' : 'upsert',
          payload: personalRow.payload,
          clientUpdatedAt: personalRow.clientUpdatedAt.toISOString(),
        },
        serverUpdatedAt: personalRow.updatedAt,
      };
      const incomingWins = existing === null || wins(incoming, existing);
      const mergedDietProfile = personalRow.entityType === 'diet_profile'
        && existing !== null
        && !personalRow.deleted
        && !existing.deleted
        ? mergeDietProfiles(existing.payload, personalRow.payload)
        : null;
      const preserveLiveHouseDietProfile = shouldPreserveLiveHouseDietProfile(
        personalRow.entityType,
        personalRow.deleted,
        existing,
      );
      if ((incomingWins && !preserveLiveHouseDietProfile) || mergedDietProfile !== null) {
        const winnerRow = incomingWins || houseRow === undefined ? personalRow : houseRow;
        const values = {
          userId: winnerRow.userId,
          scopeType: 'house' as const,
          scopeId: houseId,
          entityType: personalRow.entityType,
          entityId: personalRow.entityId,
          deviceId: winnerRow.deviceId,
          payload: mergedDietProfile ?? (personalRow.deleted ? null : personalRow.payload),
          deleted: mergedDietProfile === null && personalRow.deleted,
          clientUpdatedAt: winnerRow.clientUpdatedAt,
          updatedAt: winnerRow.updatedAt,
          mutationId: winnerRow.mutationId,
        };
        if (houseRow === undefined) {
          await transaction.insert(syncItems).values(values);
        } else {
          await transaction.update(syncItems).set({
            ...values,
            serverSequence: sql`nextval('sync_server_sequence')`,
          }).where(eq(syncItems.id, houseRow.id));
        }
      }
      await transaction.delete(syncItems).where(and(
        eq(syncItems.id, personalRow.id),
        eq(syncItems.mutationId, personalRow.mutationId),
        eq(syncItems.clientUpdatedAt, personalRow.clientUpdatedAt),
      ));
    }

    const personalReceipts = await transaction.select().from(dinnerConsumptionReceipts).where(and(
      eq(dinnerConsumptionReceipts.scopeType, 'user'),
      eq(dinnerConsumptionReceipts.scopeId, userId),
    )).for('update');
    for (const receipt of personalReceipts) {
      const [houseReceipt] = await transaction.select({ operationId: dinnerConsumptionReceipts.operationId })
        .from(dinnerConsumptionReceipts).where(and(
          eq(dinnerConsumptionReceipts.scopeType, 'house'),
          eq(dinnerConsumptionReceipts.scopeId, houseId),
          eq(dinnerConsumptionReceipts.entryId, receipt.entryId),
        )).limit(1);
      const processedMutationId = consumptionProcessedMutationId(receipt.operationId);
      await transaction.insert(processedSyncMutations).values({
        userId,
        scopeType: 'house',
        scopeId: houseId,
        mutationId: processedMutationId,
      }).onConflictDoNothing({ target: [processedSyncMutations.scopeType, processedSyncMutations.scopeId, processedSyncMutations.mutationId] });
      await transaction.delete(processedSyncMutations).where(and(
        eq(processedSyncMutations.scopeType, 'user'),
        eq(processedSyncMutations.scopeId, userId),
        eq(processedSyncMutations.mutationId, processedMutationId),
      ));
      if (houseReceipt === undefined) {
        await transaction.update(dinnerConsumptionReceipts).set({ scopeType: 'house', scopeId: houseId })
          .where(eq(dinnerConsumptionReceipts.operationId, receipt.operationId));
      } else {
        await transaction.delete(dinnerConsumptionReceipts)
          .where(eq(dinnerConsumptionReceipts.operationId, receipt.operationId));
      }
    }
  }),
  readHouseMigrationPending: async (userId) => database.transaction(async (transaction) => {
    const [row] = await transaction.select().from(houseMigrationPending)
      .where(eq(houseMigrationPending.userId, userId)).limit(1);
    return row === undefined ? null : { houseId: row.houseId };
  }),
  setHouseMigrationPending: async (userId, houseId) => database.transaction(async (transaction) => {
    const now = options.clock();
    await transaction.insert(houseMigrationPending).values({
      userId,
      houseId,
      createdAt: now,
    }).onConflictDoNothing({ target: [houseMigrationPending.userId] });
  }),
  clearHouseMigrationPending: async (userId) => database.transaction(async (transaction) => {
    await transaction.delete(houseMigrationPending).where(eq(houseMigrationPending.userId, userId));
  }),
};

};
