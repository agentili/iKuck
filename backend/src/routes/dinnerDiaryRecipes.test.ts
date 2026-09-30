import { describe, expect, it, vi } from 'vitest';
import type { DinnerEntry, DiaryRecipeDraft, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { AuthService } from '../auth/service.js';
import type { SyncMutation } from '@ikuck/shared/contracts';
import { DIARY_MAX_RECIPES } from '@ikuck/shared/limits';
import { createMemorySyncRepository, type SyncRepository } from '../sync/repository.js';

const appOrigin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin: appOrigin, 'x-csrf-token': 'csrf-token' };
const timestamp = new Date(Date.now() - 10_000).toISOString();
const dinnerEntry = (id = 'entry-1'): DinnerEntry => ({
  id, date: '2026-09-29', text: 'Pasta con zucchine', servings: null, note: null,
  recipes: [], authorId: null, createdAt: timestamp, updatedAt: timestamp,
});
const draft = (draftId: string, title = 'Pasta con zucchine'): DiaryRecipeDraft => ({
  draftId, title, description: 'Pasta con zucchine e ricotta.',
  ingredients: [{ name: 'Pasta', amount: '80 g', ingredientId: null, optional: false, provenance: 'provided' }],
  steps: ['Cuoci la pasta.', 'Aggiungi le zucchine.'], servings: null, durationMinutes: null,
  diets: null, allergens: null, suggestedFields: ['title', 'description', 'ingredients', 'amounts', 'steps', 'diets', 'allergens'],
});

const seedEntry = async (repository: SyncRepository, value = dinnerEntry(), userId = 'user-1', syncScope?: SyncMutation['syncScope']) => repository.applyMutation(userId, {
  mutationId: `seed-${value.id}`, deviceId: 'seed-device', entityType: 'dinner_entry', entityId: value.id,
  operation: 'upsert', payload: value, clientUpdatedAt: value.updatedAt, ...(syncScope === undefined ? {} : { syncScope }),
});

interface TestOptions {
  userId?: string;
  authenticated?: boolean;
  repository?: SyncRepository;
  clock?: () => Date;
}

const createDiaryApp = ({ userId = 'user-1', authenticated = true, repository = createMemorySyncRepository(), clock }: TestOptions = {}) => {
  const authService = {
    authenticate: vi.fn().mockResolvedValue(authenticated ? {
      id: `session-${userId}`, userId, email: `${userId}@example.com`,
      emailVerifiedAt: new Date(timestamp), csrfTokenHash: hashOpaqueToken('csrf-token'), expiresAt: new Date('2026-10-30T12:00:00.000Z'),
    } : null),
  } as unknown as AuthService;
  const app = createApp({
    database: { ping: async () => undefined }, cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin, secureCookies: false },
    dinnerDiary: { repository, authService, appOrigin, ...(clock === undefined ? {} : { clock }) },
  });
  return { app, repository };
};

const confirmRecipe = (app: ReturnType<typeof createApp>, entryId: string, recipeDraft: unknown, requestHeaders = headers) => app.inject({
  method: 'POST', url: `/v1/dinner-entries/${entryId}/confirm-recipe`, headers: requestHeaders, payload: { draft: recipeDraft },
});
const linkRecipe = (app: ReturnType<typeof createApp>, entryId: string, payload: unknown) => app.inject({
  method: 'POST', url: `/v1/dinner-entries/${entryId}/link-recipe`, headers, payload,
});

const byType = <T extends { entityType: string }>(items: T[], entityType: string): T[] => items.filter((item) => item.entityType === entityType);

 describe('dinner recipe confirmation and linking routes', () => {
  it('confirms a draft idempotently and keeps same-title recipe IDs distinct', async () => {
    const repository = createMemorySyncRepository();
    await seedEntry(repository);
    const { app } = createDiaryApp({ repository });
    const firstDraft = draft('draft-a');
    const first = await confirmRecipe(app, 'entry-1', firstDraft);
    expect(first.statusCode).toBe(200);
    const firstResult = first.json() as { entry: DinnerEntry; recipe: SavedRecipe };
    expect(firstResult.recipe.title).toBe(firstDraft.title);
    expect(firstResult.entry.recipes).toHaveLength(1);
    expect(firstResult.entry.recipes[0]).toMatchObject({ recipeId: firstResult.recipe.id, source: 'diary' });

    const retry = await confirmRecipe(app, 'entry-1', firstDraft);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().recipe.id).toBe(firstResult.recipe.id);
    expect(retry.json().entry.recipes).toHaveLength(1);

    const second = await confirmRecipe(app, 'entry-1', draft('draft-b'));
    expect(second.statusCode).toBe(200);
    expect(second.json().recipe.id).not.toBe(firstResult.recipe.id);
    expect(second.json().recipe.title).toBe(firstResult.recipe.title);
    expect(second.json().entry.recipes).toHaveLength(2);
    const changes = await repository.readAll('user-1');
    expect(byType(changes, 'saved_recipe')).toHaveLength(2);
    await app.close();
  });

  it('does not lose concurrent recipe links to the same dinner entry', async () => {
    const repository = createMemorySyncRepository();
    await seedEntry(repository);
    const { app } = createDiaryApp({ repository });

    const responses = await Promise.all([
      confirmRecipe(app, 'entry-1', draft('concurrent-a', 'Pasta con zucchine')),
      confirmRecipe(app, 'entry-1', draft('concurrent-b', 'Insalata mista')),
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    const entry = await repository.readEntity('user-1', 'dinner_entry', 'entry-1');
    expect((entry?.payload as DinnerEntry).recipes).toHaveLength(2);
    expect((await repository.readAll('user-1')).filter((change) => change.entityType === 'saved_recipe')).toHaveLength(2);
    await app.close();
  });

  it('preserves concurrent links when a stale write arrives later', async () => {
    let serverNow = Date.now();
    const base = createMemorySyncRepository({ clock: () => new Date(++serverNow) });
    await seedEntry(base);
    let signalLaterWrite!: () => void;
    const laterWriteStarted = new Promise<void>((resolve) => { signalLaterWrite = resolve; });
    let releaseLaterWrite!: () => void;
    const laterWriteAllowed = new Promise<void>((resolve) => { releaseLaterWrite = resolve; });
    const repository = {
      ...base,
      applyMutation: async (userId: string, mutation: SyncMutation) => {
        const hasLaterLink = mutation.entityType === 'dinner_entry'
          && typeof mutation.payload === 'object' && mutation.payload !== null
          && 'recipes' in mutation.payload && Array.isArray(mutation.payload.recipes)
          && mutation.payload.recipes.some((link) => typeof link === 'object' && link !== null
            && 'title' in link && link.title === 'Insalata mista');
        if (hasLaterLink) {
          signalLaterWrite();
          await laterWriteAllowed;
        }
        return base.applyMutation(userId, mutation);
      },
    } satisfies SyncRepository;
    const routeTime = new Date(Date.now() + 30_000);
    const { app } = createDiaryApp({ repository, clock: () => routeTime });

    const later = confirmRecipe(app, 'entry-1', draft('race-later', 'Insalata mista'));
    await laterWriteStarted;
    const first = await confirmRecipe(app, 'entry-1', draft('race-first', 'Pasta con zucchine'));
    expect(first.statusCode).toBe(200);
    releaseLaterWrite();
    const second = await later;
    expect(second.statusCode).toBe(200);

    const finalEntry = await base.readEntity('user-1', 'dinner_entry', 'entry-1');
    expect((finalEntry?.payload as DinnerEntry).recipes.map((item) => item.title)).toEqual(expect.arrayContaining([
      'Pasta con zucchine',
      'Insalata mista',
    ]));
    await app.close();
  });

  it('rejects concurrent links that would exceed the recipe limit without losing existing links', async () => {
    let serverNow = Date.now();
    const repositoryBase = createMemorySyncRepository({ clock: () => new Date(++serverNow) });
    const previousLinks = Array.from({ length: DIARY_MAX_RECIPES - 1 }, (_, index) => ({
      recipeId: `existing-recipe-${index}`, title: `Ricetta esistente ${index}`, source: 'diary' as const,
    }));
    await seedEntry(repositoryBase, { ...dinnerEntry(), recipes: previousLinks });
    let signalLaterWrite!: () => void;
    const laterWriteStarted = new Promise<void>((resolve) => { signalLaterWrite = resolve; });
    let releaseLaterWrite!: () => void;
    const laterWriteAllowed = new Promise<void>((resolve) => { releaseLaterWrite = resolve; });
    const repository = {
      ...repositoryBase,
      applyMutation: async (userId: string, mutation: SyncMutation) => {
        const hasOverflowingLink = mutation.entityType === 'dinner_entry'
          && typeof mutation.payload === 'object' && mutation.payload !== null
          && 'recipes' in mutation.payload && Array.isArray(mutation.payload.recipes)
          && mutation.payload.recipes.some((link) => typeof link === 'object' && link !== null
            && 'title' in link && link.title === 'Insalata mista');
        if (hasOverflowingLink) {
          signalLaterWrite();
          await laterWriteAllowed;
        }
        return repositoryBase.applyMutation(userId, mutation);
      },
    } satisfies SyncRepository;
    const routeTime = new Date(Date.now() + 30_000);
    const { app } = createDiaryApp({ repository, clock: () => routeTime });

    const later = confirmRecipe(app, 'entry-1', draft('overflow-later', 'Insalata mista'));
    await laterWriteStarted;
    const first = await confirmRecipe(app, 'entry-1', draft('overflow-first', 'Pasta con zucchine'));
    expect(first.statusCode).toBe(200);
    releaseLaterWrite();
    const rejected = await later;
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: 'sync_recipe_limit' });

    const finalEntry = await repositoryBase.readEntity('user-1', 'dinner_entry', 'entry-1');
    expect((finalEntry?.payload as DinnerEntry).recipes).toHaveLength(DIARY_MAX_RECIPES);
    expect((finalEntry?.payload as DinnerEntry).recipes.map((item) => item.title)).toContain('Pasta con zucchine');
    expect((await repositoryBase.readAll('user-1')).filter((change) => change.entityType === 'saved_recipe')).toHaveLength(1);
    await app.close();
  });

  it('recovers an interrupted confirmation without duplicating the entry link', async () => {
    const base = createMemorySyncRepository();
    await seedEntry(base);
    let failRecipeOnce = true;
    const repository = {
      ...base,
      applyMutation: async (userId: string, mutation: SyncMutation) => {
        if (mutation.entityType === 'saved_recipe' && failRecipeOnce) {
          failRecipeOnce = false;
          throw new Error('simulated write failure');
        }
        return base.applyMutation(userId, mutation);
      },
    } satisfies SyncRepository;
    const { app } = createDiaryApp({ repository });
    const recipeDraft = draft('draft-retry');

    const interrupted = await confirmRecipe(app, 'entry-1', recipeDraft);
    expect(interrupted.statusCode).toBe(500);
    const afterFailure = await base.readEntity('user-1', 'dinner_entry', 'entry-1');
    expect((afterFailure?.payload as DinnerEntry).recipes).toHaveLength(1);
    expect(await base.readEntity('user-1', 'saved_recipe', 'recipe-never-used')).toBeNull();

    const recovered = await confirmRecipe(app, 'entry-1', recipeDraft);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().entry.recipes).toHaveLength(1);
    expect((await base.readAll('user-1')).filter((change) => change.entityType === 'saved_recipe')).toHaveLength(1);
    await app.close();
  });

  it('does not resurrect a deleted recipe when a stale confirmation is retried', async () => {
    const repository = createMemorySyncRepository();
    await seedEntry(repository);
    const { app } = createDiaryApp({ repository });
    const recipeDraft = draft('deleted-after-confirmation');
    const confirmed = await confirmRecipe(app, 'entry-1', recipeDraft);
    expect(confirmed.statusCode).toBe(200);
    const recipeId = confirmed.json().recipe.id as string;
    const saved = await repository.readEntity('user-1', 'saved_recipe', recipeId);
    expect(saved).not.toBeNull();
    await repository.applyMutation('user-1', {
      mutationId: 'delete-confirmed-recipe', deviceId: 'test-delete', entityType: 'saved_recipe', entityId: recipeId,
      operation: 'delete', payload: null,
      clientUpdatedAt: new Date(saved!.clientUpdatedAt.getTime() + 1).toISOString(),
    });

    const retried = await confirmRecipe(app, 'entry-1', recipeDraft);

    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toMatchObject({ code: 'dinner_recipe_conflict' });
    await expect(repository.readEntity('user-1', 'dinner_entry', 'entry-1')).resolves.toMatchObject({
      payload: { recipes: [{ recipeId, title: recipeDraft.title, source: 'diary' }] },
    });
    await expect(repository.readEntity('user-1', 'saved_recipe', recipeId)).resolves.toMatchObject({ deleted: true });
    await app.close();
  });

  it('does not copy a personal dinner or recipe into the House scope', async () => {
    const repository = createMemorySyncRepository({ scopeResolver: async () => ({ kind: 'house', id: 'house-1' }) });
    await seedEntry(repository, dinnerEntry('personal-entry'), 'user-1', 'account:user-1');
    const { app } = createDiaryApp({ repository });
    const response = await confirmRecipe(app, 'personal-entry', draft('draft-personal'));
    expect(response.statusCode).toBe(200);
    const personal = await repository.readChanges('user-1', 0, 100, 'account:user-1');
    const house = await repository.readChanges('user-1', 0, 100, 'house:house-1');
    expect(personal.filter((change) => ['dinner_entry', 'saved_recipe'].includes(change.entityType))).toHaveLength(2);
    expect(house.filter((change) => ['dinner_entry', 'saved_recipe'].includes(change.entityType) && change.syncScope === 'house:house-1')).toHaveLength(0);
    expect(house.filter((change) => ['dinner_entry', 'saved_recipe'].includes(change.entityType) && change.syncScope === 'account:user-1')).toHaveLength(2);
    await app.close();
  });

  it('keeps confirmation identities separate between account and House scopes', async () => {
    let joinedHouse = false;
    const repository = createMemorySyncRepository({
      scopeResolver: async () => joinedHouse ? { kind: 'house', id: 'house-1' } : { kind: 'user', id: 'user-1' },
    });
    await seedEntry(repository, dinnerEntry('personal-entry'), 'user-1', 'account:user-1');
    const { app } = createDiaryApp({ repository });
    const sharedDraft = draft('same-draft-id');

    const personal = await confirmRecipe(app, 'personal-entry', sharedDraft);
    expect(personal.statusCode).toBe(200);
    joinedHouse = true;
    await seedEntry(repository, dinnerEntry('house-entry'), 'user-1', 'house:house-1');

    const house = await confirmRecipe(app, 'house-entry', sharedDraft);

    expect(house.statusCode).toBe(200);
    expect(house.json().recipe.id).not.toBe(personal.json().recipe.id);
    expect(house.json().entry.recipes).toHaveLength(1);
    await app.close();
  });

  it('links an existing saved recipe by ID and leaves the recipe untouched on repeat', async () => {
    const repository = createMemorySyncRepository();
    await seedEntry(repository);
    const savedDraft = draft('draft-existing');
    const saved: SavedRecipe = {
      id: 'saved-recipe-1', source: 'diary', authorId: null, createdAt: timestamp, updatedAt: timestamp,
      title: savedDraft.title, description: savedDraft.description, ingredients: savedDraft.ingredients,
      steps: savedDraft.steps, servings: savedDraft.servings, durationMinutes: savedDraft.durationMinutes,
      diets: savedDraft.diets, allergens: savedDraft.allergens, suggestedFields: savedDraft.suggestedFields,
    };
    await repository.applyMutation('user-1', {
      mutationId: 'seed-saved', deviceId: 'seed-device', entityType: 'saved_recipe', entityId: saved.id,
      operation: 'upsert', payload: saved, clientUpdatedAt: saved.updatedAt,
    });
    const { app } = createDiaryApp({ repository });

    const linked = await linkRecipe(app, 'entry-1', { recipeId: saved.id, source: 'diary' });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().entry.recipes).toEqual([{ recipeId: saved.id, title: saved.title, source: 'diary' }]);
    const repeated = await linkRecipe(app, 'entry-1', { recipeId: saved.id, source: 'diary' });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().entry.recipes).toHaveLength(1);
    await app.close();
  });

  it('rejects catalog links until the server can verify catalog visibility', async () => {
    const repository = createMemorySyncRepository();
    await seedEntry(repository);
    const { app } = createDiaryApp({ repository });

    const response = await linkRecipe(app, 'entry-1', {
      recipeId: 'not-in-catalog', source: 'catalog', title: 'Forged recipe title',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
    const storedEntry = await repository.readEntity('user-1', 'dinner_entry', 'entry-1');
    expect((storedEntry?.payload as DinnerEntry).recipes).toEqual([]);
    await app.close();
  });

  it('rejects edits by a different House member before creating a recipe', async () => {
    const repository = createMemorySyncRepository({
      scopeResolver: async () => ({ kind: 'house', id: 'house-1' }),
      roleResolver: async () => 'member',
    });
    await seedEntry(repository, dinnerEntry(), 'author', 'house:house-1');
    const { app } = createDiaryApp({ userId: 'member', repository });

    const response = await confirmRecipe(app, 'entry-1', draft('draft-denied'));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'sync_permission_denied' });
    expect((await repository.readChanges('member', 0, 100, 'house:house-1')).filter((change) => change.entityType === 'saved_recipe')).toHaveLength(0);
    await app.close();
  });
});
