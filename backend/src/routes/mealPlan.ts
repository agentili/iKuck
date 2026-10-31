import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { MealPlanCapabilities, PlanCommand, PlanResult, PlanVersion } from '@ikuck/shared/contracts';
import type { AuthRateLimiter } from '../auth/rateLimit.js';
import type { AuthService } from '../auth/service.js';
import type { SyncRepository, MealPlanRecoveryEntry } from '../sync/repository.js';
import {
  PlanCommandValidationError,
  assertPlanCommand,
  parsePlanRead,
} from '../mealPlan/validation.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface MealPlanRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
  rateLimiter?: AuthRateLimiter;
}

const importScopeSchema = z.string().regex(/^(account|house):[^:]{1,128}$/);

const importItemSchema = z.object({
  source: z.enum(['guest', 'account']),
  sourceId: z.string().min(1).max(128),
  localRevision: z.string().min(1).max(128),
  command: z.custom<PlanCommand>((value): value is PlanCommand => {
    try {
      assertPlanCommand(value);
      return true;
    } catch {
      return false;
    }
  }),
}).strict();

const recoveryResolutionSchema = z.object({
  expectedSourceRevision: z.uuid(),
  expectedTargetRevision: z.uuid(),
  command: z.custom<PlanCommand>((value): value is PlanCommand => {
    try {
      assertPlanCommand(value);
      return true;
    } catch {
      return false;
    }
  }),
}).strict();

const importSchema = z.object({
  version: z.literal(2 satisfies PlanVersion),
  scope: importScopeSchema,
  items: z.array(importItemSchema).min(1).max(100),
}).strict();

export interface MealPlanImportItemResult {
  sourceId: string;
  localRevision: string;
  result: PlanResult;
}

export interface MealPlanImportResponse {
  version: PlanVersion;
  results: readonly MealPlanImportItemResult[];
}

export class MealPlanCapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable';
  readonly status = 404;

  constructor() {
    super('Meal-plan capability is unavailable');
    this.name = 'MealPlanCapabilityUnavailableError';
  }
}

const requireMealPlanV2 = async (repository: SyncRepository): Promise<void> => {
  if (!await repository.isMealPlanV2Enabled()) throw new MealPlanCapabilityUnavailableError();
};

export const registerMealPlanRoutes = ({ repository, authService, appOrigin, rateLimiter }: MealPlanRouteDependencies): FastifyPluginAsync => async (app) => {
  app.get('/v1/meal-plan/capabilities', async (request): Promise<MealPlanCapabilities> => {
    await requireVerifiedSession(request, authService);
    await requireMealPlanV2(repository);
    return { version: 2, syncReadVersion: 2 };
  });

  app.post('/v1/meal-plan/read', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await requireMealPlanV2(repository);
    const read = parsePlanRead(request.body);
    return repository.readMealPlanStates(session.userId, read.scope, read.dates);
  });

  app.post('/v1/meal-plan/commands', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await rateLimiter?.enforce('mealPlanCommand', { ip: request.ip, email: session.email, actorId: session.userId });
    await requireMealPlanV2(repository);
    const command: PlanCommand = assertPlanCommand(request.body);
    return repository.applyMealPlanCommand(session.userId, command);
  });

  app.post('/v1/meal-plan/import', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await rateLimiter?.enforce('mealPlanCommand', { ip: request.ip, email: session.email, actorId: session.userId });
    await requireMealPlanV2(repository);
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) throw new PlanCommandValidationError();
    const { scope, items } = parsed.data;
    const results: MealPlanImportItemResult[] = [];
    // Ogni voce è una transazione a sé: un conflitto su una voce non annulla
    // le altre e il lotto resta parzialmente applicato in modo esplicito.
    for (const item of items) {
      if (item.command.scope !== scope) throw new PlanCommandValidationError();
      const receipt = await repository.importMealPlanCommand(session.userId, item.source, item.sourceId, item.localRevision, item.command);
      if (receipt.sourceAccountId !== session.userId
        || receipt.source !== item.source
        || receipt.sourceId !== item.sourceId
        || receipt.localRevision !== item.localRevision
        || receipt.targetScope !== scope
        || receipt.operationId !== item.command.operationId) {
        throw new Error('Meal-plan import repository returned a receipt for another request');
      }
      const result: PlanResult = {
        version: receipt.version,
        operationId: receipt.operationId,
        outcome: receipt.outcome,
        current: receipt.current,
      };
      results.push({ sourceId: receipt.sourceId, localRevision: receipt.localRevision, result });
    }
    return reply.code(200).send({ version: 2, results } satisfies MealPlanImportResponse);
  });

  app.get('/v1/meal-plan/recovery', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await requireMealPlanV2(repository);
    const recovery = await repository.readMealPlanRecovery(session.userId);
    const conflicts = recovery.filter((entry): entry is Extract<MealPlanRecoveryEntry, { sourceRevision: string }> => 'sourceRevision' in entry);
    const quarantined = recovery.filter((entry): entry is Extract<MealPlanRecoveryEntry, { reasonCode: string }> => 'reasonCode' in entry).map(({ planDate, reasonCode, sourceSnapshot, targetSnapshot, observed }) => ({
      planDate,
      reasonCode,
      sourceSnapshot,
      targetSnapshot,
      observed,
    }));
    return { version: 2, conflicts, quarantined };
  });

  app.post('/v1/meal-plan/recovery/:conflictId/resolve', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    await rateLimiter?.enforce('mealPlanCommand', { ip: request.ip, email: session.email, actorId: session.userId });
    await requireMealPlanV2(repository);
    const params = z.object({ conflictId: z.uuid() }).safeParse(request.params);
    const parsed = recoveryResolutionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) throw new PlanCommandValidationError();
    const command = assertPlanCommand(parsed.data.command);
    if ((command.action !== 'manual_set' && command.action !== 'manual_delete')) {
      throw new PlanCommandValidationError();
    }
    return repository.resolveMealPlanRecovery(session.userId, params.data.conflictId, {
      expectedSourceRevision: parsed.data.expectedSourceRevision,
      expectedTargetRevision: parsed.data.expectedTargetRevision,
      command,
    });
  });
};
