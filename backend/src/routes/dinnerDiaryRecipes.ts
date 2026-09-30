import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SyncMutation, SyncMutationScope } from '@ikuck/shared/contracts';
import { DIARY_MAX_RECIPES } from '@ikuck/shared/limits';
import {
  isDiaryRecipeDraft,
  isDinnerEntry,
  isSavedRecipe,
  type DiaryRecipeDraft,
  type DinnerEntry,
  type DinnerRecipeLink,
  type SavedRecipe,
} from '@ikuck/shared/dinnerDiary';
import { AuthServiceError, type AuthService } from '../auth/service.js';
import type { SyncRepository, StoredSyncItem } from '../sync/repository.js';
import { ensureCsrf, ensureSameOrigin, requireVerifiedSession } from './auth.js';

export interface DinnerDiaryRecipeRouteDependencies {
  repository: SyncRepository;
  authService: AuthService;
  appOrigin: string;
  clock?: () => Date;
  createMutationId?: () => string;
}

const entryParamsSchema = z.object({ entryId: z.string().min(1).max(128) }).strict();
const confirmRequestSchema = z.object({ draft: z.custom<DiaryRecipeDraft>(isDiaryRecipeDraft) }).strict();
const diaryRecipeLinkSchema = z.object({
  recipeId: z.string().trim().min(1).max(128),
  source: z.literal('diary'),
}).strict();
const linkRequestSchema = diaryRecipeLinkSchema;

const invalidPayload = (): AuthServiceError => new AuthServiceError('invalid_payload', 400, 'Request payload is invalid');
const missingEntry = (): AuthServiceError => new AuthServiceError('dinner_entry_not_found', 404, 'Dinner entry was not found');
const recipeConflict = (): AuthServiceError => new AuthServiceError('dinner_recipe_conflict', 409, 'Dinner recipe confirmation conflicts with existing data');
const scopeConflict = (): AuthServiceError => new AuthServiceError('dinner_scope_mismatch', 409, 'Dinner entry and recipe must belong to the same data scope');

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw invalidPayload();
  return result.data;
};

const parseEntryId = (params: unknown): string => {
  const result = entryParamsSchema.safeParse(params);
  if (!result.success) throw invalidPayload();
  return result.data.entryId;
};

const recordScope = (record: StoredSyncItem, userId: string): SyncMutationScope => {
  const scope = record.syncScope;
  if (scope === `account:${userId}` || scope?.startsWith('house:')) return scope;
  throw scopeConflict();
};

const recipeContent = (recipe: Pick<DiaryRecipeDraft, 'title' | 'description' | 'ingredients' | 'steps' | 'servings' | 'durationMinutes' | 'diets' | 'allergens' | 'suggestedFields'>) => ({
  title: recipe.title,
  description: recipe.description,
  ingredients: recipe.ingredients.map(({ name, amount, ingredientId, optional, provenance }) => ({ name, amount, ingredientId, optional, provenance })),
  steps: recipe.steps,
  servings: recipe.servings,
  durationMinutes: recipe.durationMinutes,
  diets: recipe.diets === null ? null : [...recipe.diets].sort(),
  allergens: recipe.allergens === null ? null : [...recipe.allergens].sort(),
  suggestedFields: [...recipe.suggestedFields].sort(),
});

const sameRecipeContent = (saved: SavedRecipe, draft: DiaryRecipeDraft): boolean => JSON.stringify(recipeContent(saved)) === JSON.stringify(recipeContent(draft));

const savedRecipeId = (userId: string, syncScope: SyncMutationScope, draftId: string): string =>
  `diary-${createHash('sha256').update(`${userId}\u0000${syncScope}\u0000${draftId}`).digest('hex')}`;

const createMutation = (
  createMutationId: () => string,
  entityType: Extract<SyncMutation['entityType'], 'dinner_entry' | 'saved_recipe'>,
  entityId: string,
  payload: DinnerEntry | SavedRecipe,
  syncScope: SyncMutationScope,
  clientUpdatedAt: string,
): SyncMutation => ({
  mutationId: createMutationId(),
  deviceId: 'api-dinner-diary',
  entityType,
  entityId,
  operation: 'upsert',
  payload,
  clientUpdatedAt,
  syncScope,
});

const readDinnerEntry = async (repository: SyncRepository, userId: string, entryId: string) => {
  const record = await repository.readEntity(userId, 'dinner_entry', entryId);
  if (record === null || record.deleted || !isDinnerEntry(record.payload) || record.payload.id !== entryId) throw missingEntry();
  return { record, entry: record.payload };
};

const linkIntoEntry = async (
  repository: SyncRepository,
  userId: string,
  entryId: string,
  link: DinnerRecipeLink,
  expectedScope: SyncMutationScope,
  clock: () => Date,
  createMutationId: () => string,
): Promise<DinnerEntry> => {
  let current = await readDinnerEntry(repository, userId, entryId);
  if (recordScope(current.record, userId) !== expectedScope) throw scopeConflict();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existingLink = current.entry.recipes.find((item) => item.recipeId === link.recipeId);
    if (existingLink !== undefined) {
      if (existingLink.source !== link.source) throw recipeConflict();
      return current.entry;
    }
    if (current.entry.recipes.length >= DIARY_MAX_RECIPES) throw invalidPayload();
    const nextMillis = Math.max(clock().getTime(), current.record.clientUpdatedAt.getTime() + 1, Date.parse(current.entry.updatedAt) + 1);
    const updatedAt = new Date(nextMillis).toISOString();
    const updated: DinnerEntry = {
      ...current.entry,
      recipes: [...current.entry.recipes, link],
      updatedAt,
    };
    await repository.applyMutation(userId, createMutation(createMutationId, 'dinner_entry', entryId, updated, expectedScope, updatedAt));
    current = await readDinnerEntry(repository, userId, entryId);
    if (recordScope(current.record, userId) !== expectedScope) throw scopeConflict();
    if (current.entry.recipes.some((item) => item.recipeId === link.recipeId)) {
      const persistedLink = current.entry.recipes.find((item) => item.recipeId === link.recipeId)!;
      if (persistedLink.source !== link.source) throw recipeConflict();
      return current.entry;
    }
  }
  throw recipeConflict();
};

const toSavedRecipe = (draft: DiaryRecipeDraft, userId: string, id: string, now: string): SavedRecipe => ({
  id,
  title: draft.title,
  description: draft.description,
  ingredients: draft.ingredients,
  steps: draft.steps,
  servings: draft.servings,
  durationMinutes: draft.durationMinutes,
  diets: draft.diets,
  allergens: draft.allergens,
  suggestedFields: draft.suggestedFields,
  source: 'diary',
  authorId: userId,
  createdAt: now,
  updatedAt: now,
});

export const registerDinnerDiaryRecipeRoutes = ({
  repository,
  authService,
  appOrigin,
  clock = () => new Date(),
  createMutationId = randomUUID,
}: DinnerDiaryRecipeRouteDependencies): FastifyPluginAsync => async (app) => {
  app.post('/v1/dinner-entries/:entryId/confirm-recipe', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const entryId = parseEntryId(request.params);
    const { draft } = parseBody(confirmRequestSchema, request.body);
    const entryRecord = (await readDinnerEntry(repository, session.userId, entryId)).record;
    const syncScope = recordScope(entryRecord, session.userId);
    const id = savedRecipeId(session.userId, syncScope, draft.draftId);

    const existingRecord = await repository.readEntity(session.userId, 'saved_recipe', id);
    let saved: SavedRecipe;
    if (existingRecord !== null) {
      if (recordScope(existingRecord, session.userId) !== syncScope) throw scopeConflict();
      if (existingRecord.deleted || !isSavedRecipe(existingRecord.payload) || !sameRecipeContent(existingRecord.payload, draft)) throw recipeConflict();
      saved = existingRecord.payload;
    } else {
      saved = toSavedRecipe(draft, session.userId, id, clock().toISOString());
    }

    const link: DinnerRecipeLink = { recipeId: id, title: saved.title, source: 'diary' };
    const entry = await linkIntoEntry(repository, session.userId, entryId, link, syncScope, clock, createMutationId);
    if (existingRecord === null) {
      await repository.applyMutation(session.userId, createMutation(createMutationId, 'saved_recipe', id, saved, syncScope, saved.updatedAt));
    }
    const storedRecipe = await repository.readEntity(session.userId, 'saved_recipe', id);
    if (storedRecipe === null || storedRecipe.deleted || recordScope(storedRecipe, session.userId) !== syncScope
      || !isSavedRecipe(storedRecipe.payload) || !sameRecipeContent(storedRecipe.payload, draft)) throw recipeConflict();
    return reply.code(200).send({ entry, recipe: storedRecipe.payload });
  });

  app.post('/v1/dinner-entries/:entryId/link-recipe', async (request, reply) => {
    ensureSameOrigin(request, appOrigin);
    const { session } = await requireVerifiedSession(request, authService);
    ensureCsrf(request, session.csrfTokenHash);
    const entryId = parseEntryId(request.params);
    const linkRequest = parseBody(linkRequestSchema, request.body);
    const { record: entryRecord } = await readDinnerEntry(repository, session.userId, entryId);
    const syncScope = recordScope(entryRecord, session.userId);
    const currentEntry = entryRecord.payload as DinnerEntry;
    const currentLink = currentEntry.recipes.find((item) => item.recipeId === linkRequest.recipeId);
    if (currentLink !== undefined) {
      if (currentLink.source !== 'diary') throw recipeConflict();
      return reply.code(200).send({ entry: currentEntry });
    }
    const recipeRecord = await repository.readEntity(session.userId, 'saved_recipe', linkRequest.recipeId);
    if (recipeRecord === null || recipeRecord.deleted || !isSavedRecipe(recipeRecord.payload)) throw recipeConflict();
    if (recordScope(recipeRecord, session.userId) !== syncScope) throw scopeConflict();
    const link: DinnerRecipeLink = { recipeId: linkRequest.recipeId, title: recipeRecord.payload.title, source: 'diary' };
    const entry = await linkIntoEntry(repository, session.userId, entryId, link, syncScope, clock, createMutationId);
    return reply.code(200).send({ entry });
  });
};
