import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DIARY_ID_MAX_LENGTH,
  DIARY_INGREDIENT_AMOUNT_MAX_LENGTH,
  DIARY_INGREDIENT_NAME_MAX_LENGTH,
  DIARY_SERVINGS_MAX,
  DIARY_SERVINGS_MIN,
  RECIPE_MAX_INGREDIENTS,
} from '@ikuck/shared/limits';
import type { CookEvent } from '@ikuck/shared/contracts';
import { isDinnerEntry, type DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import { isCookEvent } from '../activity/validation.js';
import type { DinnerConsumptionRequest } from '../pantry/consumptionService.js';
import { createDinnerConsumptionService } from '../pantry/consumptionService.js';
import type { SyncRepository } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface DinnerConsumptionRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
}

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
const nonBlankString = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0);
const ingredientSchema = z.object({
  ingredientId: z.union([z.null(), nonBlankString(DIARY_ID_MAX_LENGTH)]),
  name: nonBlankString(DIARY_INGREDIENT_NAME_MAX_LENGTH),
  amount: z.string().max(DIARY_INGREDIENT_AMOUNT_MAX_LENGTH),
  optional: z.boolean(),
  used: z.boolean(),
}).strict();
const commandSchema = z.object({
  operationId: nonBlankString(DIARY_ID_MAX_LENGTH),
  entryId: nonBlankString(DIARY_ID_MAX_LENGTH),
  scope: z.string().max(136).regex(/^(account|house):[^:]{1,128}$/),
  servings: z.number().int().min(DIARY_SERVINGS_MIN).max(DIARY_SERVINGS_MAX),
  ingredients: z.array(ingredientSchema).max(RECIPE_MAX_INGREDIENTS),
}).strict();
const cookEventSchema = z.custom<CookEvent>((value) => typeof value === 'object' && value !== null
  && !Array.isArray(value)
  && Object.keys(value).length === 8
  && ['id', 'recipeId', 'recipeTitle', 'servings', 'cookedAt', 'note', 'createdAt', 'updatedAt']
    .every((key) => Object.hasOwn(value, key))
  && isCookEvent(value));
const dinnerConsumptionSchema = z.object({
  command: commandSchema,
  entry: z.custom<DinnerEntry>(isDinnerEntry),
  cookEvent: cookEventSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.entry.id !== request.command.entryId || request.entry.servings !== request.command.servings) {
    context.addIssue({ code: 'custom', path: ['entry'], message: 'Dinner and consumption command identifiers must match' });
  }
  if (request.cookEvent !== undefined && (request.cookEvent.id !== request.command.entryId
    || request.cookEvent.servings !== request.command.servings)) {
    context.addIssue({ code: 'custom', path: ['cookEvent'], message: 'Cooking event and dinner identifiers must match' });
  }
});

export const registerDinnerConsumptionRoutes = ({ repository, authService, appOrigin }: DinnerConsumptionRouteDependencies): FastifyPluginAsync => async (app) => {
  const service = createDinnerConsumptionService({ repository });
  app.post('/v1/dinner-consumption', async (request) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const parsed = dinnerConsumptionSchema.safeParse(request.body);
    if (!parsed.success) throw invalidPayload();
    return service.confirm(session.userId, parsed.data as DinnerConsumptionRequest);
  });
};
