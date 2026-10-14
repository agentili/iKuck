import type { CookEvent, PantryLot, SyncMutationScope } from '@ikuck/shared/contracts';
import {
  DIARY_ID_MAX_LENGTH,
  DIARY_INGREDIENT_AMOUNT_MAX_LENGTH,
  DIARY_INGREDIENT_NAME_MAX_LENGTH,
  DIARY_SERVINGS_MAX,
  DIARY_SERVINGS_MIN,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import type { DinnerConsumptionCommand } from '@ikuck/shared/pantryConsumption';
import type { PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { isDinnerEntry, type DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { isCookEvent } from '../activity/validation.js';

export interface DinnerConsumptionRequest {
  command: DinnerConsumptionCommand;
  entry: DinnerEntry;
  cookEvent?: CookEvent;
}

export interface DinnerConsumptionReceipt {
  operationId: string;
  entryId: string;
  scope: SyncMutationScope;
  committedAt: string;
  plan: PantryConsumptionPlan;
}

export interface DinnerConsumptionPantrySnapshot {
  pantryItems: Array<{ id: string; label: string; known: boolean }>;
  stapleIds: string[];
  pantryLots: PantryLot[];
}

export interface DinnerConsumptionResult {
  duplicate: boolean;
  entry: DinnerEntry;
  cookEvent?: CookEvent;
  pantrySnapshot: DinnerConsumptionPantrySnapshot;
  receipt: DinnerConsumptionReceipt;
  plan: PantryConsumptionPlan;
}

export interface DinnerConsumptionRepository {
  consumeDinner: (userId: string, request: DinnerConsumptionRequest) => Promise<DinnerConsumptionResult>;
}

export class DinnerConsumptionInputError extends Error {
  readonly code = 'dinner_consumption_invalid';
  readonly status = 400;

  constructor() {
    super('Dinner consumption payload is invalid');
    this.name = 'DinnerConsumptionInputError';
  }
}

export class DinnerConsumptionConflictError extends Error {
  readonly code = 'dinner_consumption_conflict';
  readonly status = 409;

  constructor() {
    super('Dinner consumption conflicts with an existing dinner');
    this.name = 'DinnerConsumptionConflictError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const validCommand = (value: unknown): value is DinnerConsumptionCommand => {
  if (!isRecord(value) || Object.keys(value).length !== 5
    || typeof value.operationId !== 'string' || value.operationId.trim().length === 0 || value.operationId.length > DIARY_ID_MAX_LENGTH
    || typeof value.entryId !== 'string' || value.entryId.trim().length === 0 || value.entryId.length > DIARY_ID_MAX_LENGTH
    || typeof value.scope !== 'string' || !/^(account|house):[^:]+$/.test(value.scope)
    || typeof value.servings !== 'number' || !Number.isInteger(value.servings)
    || value.servings < DIARY_SERVINGS_MIN || value.servings > DIARY_SERVINGS_MAX
    || !Array.isArray(value.ingredients) || value.ingredients.length > RECIPE_MAX_INGREDIENTS) return false;

  return value.ingredients.every((ingredient) => isRecord(ingredient)
    && Object.keys(ingredient).length === 5
    && (ingredient.ingredientId === null || (typeof ingredient.ingredientId === 'string'
      && ingredient.ingredientId.trim().length > 0 && ingredient.ingredientId.length <= DIARY_ID_MAX_LENGTH))
    && typeof ingredient.name === 'string' && ingredient.name.trim().length > 0
    && ingredient.name.length <= DIARY_INGREDIENT_NAME_MAX_LENGTH
    && typeof ingredient.amount === 'string' && ingredient.amount.length <= DIARY_INGREDIENT_AMOUNT_MAX_LENGTH
    && typeof ingredient.optional === 'boolean' && typeof ingredient.used === 'boolean');
};

export function assertDinnerConsumptionRequest(value: unknown): asserts value is DinnerConsumptionRequest {
  if (!isRecord(value) || (Object.keys(value).length !== 2 && Object.keys(value).length !== 3)
    || !validCommand(value.command) || !isDinnerEntry(value.entry)
    || value.command.entryId !== value.entry.id || value.command.servings !== value.entry.servings
    || ('cookEvent' in value && (!isCookEvent(value.cookEvent)
      || value.cookEvent.id !== value.command.entryId || value.cookEvent.servings !== value.command.servings))) {
    throw new DinnerConsumptionInputError();
  }
}

export const createDinnerConsumptionService = ({ repository }: { repository: DinnerConsumptionRepository }) => ({
  confirm: async (userId: string, request: DinnerConsumptionRequest): Promise<DinnerConsumptionResult> => {
    assertDinnerConsumptionRequest(request);
    return repository.consumeDinner(userId, request);
  },
});
