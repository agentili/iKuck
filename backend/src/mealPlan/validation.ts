import { z } from 'zod';
import type { PlanCommand, PlanVersion, SyncMutationScope } from '@ikuck/shared/contracts';

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const scopeSchema = z.string().regex(/^(account|house):[^:]{1,128}$/)
  .transform((value) => value as SyncMutationScope);

const baseSchema = z.object({
  version: z.literal(2 satisfies PlanVersion),
  scope: scopeSchema,
  date: z.string().refine(isCalendarDate),
  operationId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  clientUpdatedAt: z.iso.datetime({ offset: true }),
});

export const planCommandSchema = z.discriminatedUnion('action', [
  baseSchema.extend({ action: z.literal('manual_set'), recipeId: z.string().trim().min(1).max(128) }).strict(),
  baseSchema.extend({ action: z.literal('manual_delete') }).strict(),
  baseSchema.extend({ action: z.literal('auto_create'), recipeId: z.string().trim().min(1).max(128), baseRevision: z.null() }).strict(),
  baseSchema.extend({ action: z.literal('explicit_regenerate'), recipeId: z.string().trim().min(1).max(128), baseRevision: z.uuid() }).strict(),
]);

export const planReadSchema = z.object({
  version: z.literal(2),
  scope: scopeSchema,
  dates: z.array(z.string().refine(isCalendarDate)).max(100).refine((dates) => new Set(dates).size === dates.length),
}).strict();

export class PlanCommandValidationError extends Error {
  readonly code = 'INVALID_PLAN_COMMAND';
  readonly status = 400;

  constructor() {
    super('Meal-plan command is invalid');
    this.name = 'PlanCommandValidationError';
  }
}

export class PlanReadValidationError extends Error {
  readonly code = 'INVALID_PLAN_READ';
  readonly status = 400;

  constructor() {
    super('Meal-plan read request is invalid');
    this.name = 'PlanReadValidationError';
  }
}

export class PlanCommandRequiredError extends Error {
  readonly code = 'PLAN_COMMAND_REQUIRED';
  readonly status = 400;

  constructor() {
    super('Meal-plan changes require the versioned command endpoint');
    this.name = 'PlanCommandRequiredError';
  }
}

export class PlanScopeInvalidError extends Error {
  readonly code = 'sync_scope_invalid';
  readonly status = 409;

  constructor() {
    super('The meal-plan scope is no longer current');
    this.name = 'PlanScopeInvalidError';
  }
}

export class PlanOperationIdReusedError extends Error {
  readonly code = 'operation_id_reused';
  readonly status = 409;

  constructor() {
    super('The meal-plan operation ID was already used for different content');
    this.name = 'PlanOperationIdReusedError';
  }
}

export class PlanRecoveryNotFoundError extends Error {
  readonly code = 'plan_recovery_not_found';
  readonly status = 404;

  constructor() {
    super('The meal-plan recovery item is not available');
    this.name = 'PlanRecoveryNotFoundError';
  }
}

export class PlanRecoveryRevisionConflictError extends Error {
  readonly code = 'plan_recovery_revision_conflict';
  readonly status = 409;

  constructor() {
    super('The meal-plan recovery item or target state has changed');
    this.name = 'PlanRecoveryRevisionConflictError';
  }
}

export class PlanRecoveryResolutionReusedError extends Error {
  readonly code = 'plan_recovery_resolution_reused';
  readonly status = 409;

  constructor() {
    super('The recovery item was already resolved with different content');
    this.name = 'PlanRecoveryResolutionReusedError';
  }
}

export const parsePlanCommand = (value: unknown): PlanCommand | null => {
  const parsed = planCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const assertPlanCommand = (value: unknown): PlanCommand => {
  const parsed = parsePlanCommand(value);
  if (parsed === null) throw new PlanCommandValidationError();
  return parsed;
};

export const parsePlanRead = (value: unknown) => {
  const parsed = planReadSchema.safeParse(value);
  if (!parsed.success) throw new PlanReadValidationError();
  return parsed.data;
};
