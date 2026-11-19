import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AiConsent, DietProfilePayload, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { findRecipeNoveltyConflict, type RecipeReference } from '../ai/recipeNovelty.js';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { GenerationRateLimiter } from '../ai/rateLimit.js';
import { createMemorySyncRepository, type SyncRepository } from '../sync/repository.js';
import type { RecipeGenerationProvider } from '../providers/types.js';
import { parseGeneratedRecipeDraft } from '../ai/validation.js';
import { parseIngredientInput } from '@ikuck/shared/ingredients';
import { AI_RECIPE_MAX_GENERATION_INGREDIENTS } from '@ikuck/shared/limits';

const appOrigin = 'http://127.0.0.1:5173';
const headers = {
  cookie: 'ikuck_session=mock-session-token',
  origin: appOrigin,
  'x-csrf-token': 'csrf-token',
};

const draft: GeneratedRecipeDraft = {
  title: 'Orata al cartoccio',
  description: 'Orata con patate e olive.',
  ingredients: [{ name: 'Orata', amount: '1' }, { name: 'Patate', amount: '300 g' }],
  steps: ['Cuoci l\'orata al cartoccio con le patate.'],
  diets: ['omnivore', 'pescatarian'],
  allergens: ['fish'],
};

const defaultDietProfile: DietProfilePayload = {
  diet: 'omnivore',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

const session = (userId = 'user-1') => ({
  id: `session-${userId}`,
  userId,
  email: `${userId}@example.com`,
  emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
  csrfTokenHash: hashOpaqueToken('csrf-token'),
  expiresAt: new Date('2026-10-12T12:00:00.000Z'),
});

interface RecipeAppOptions {
  userId?: string;
  authenticated?: boolean;
  provider?: RecipeGenerationProvider;
  limiter?: GenerationRateLimiter;
  bypassConsent?: boolean;
}

const createRecipeApp = ({
  userId = 'user-1',
  authenticated = true,
  provider = { generate: vi.fn().mockResolvedValue(draft) },
  limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }) },
  bypassConsent = false,
}: RecipeAppOptions = {}) => {
  const memoryRepo = createMemorySyncRepository();
  const dummyConsent: AiConsent = {
    enabled: true,
    updatedAt: '2026-09-24T00:00:00.000Z',
    homeProvider: 'openai',
  };
  const repository: SyncRepository = bypassConsent
    ? ({ ...memoryRepo, withAiConsentDispatch: async (_userId, _requirement, dispatch) => dispatch(dummyConsent) } as SyncRepository)
    : memoryRepo;
  const authService = {
    authenticate: vi.fn().mockResolvedValue(authenticated ? session(userId) : null),
  } as unknown as AuthService;

  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin, secureCookies: false },
    recipes: { provider, recipeProvider: 'openai', limiter, repository, authService, appOrigin },
    aiRecipes: {
      provider,
      dinnerReconstructionProvider: { reconstruct: async () => [] },
      limiter,
      repository: memoryRepo,
      authService,
      appOrigin,
      recipeProvider: 'openai',
    },
  });
  return { app, repository: memoryRepo, provider, limiter };
};

const generate = (
  app: ReturnType<typeof createApp>,
  input?: { ingredients?: string[]; dietProfile?: DietProfilePayload },
) => app.inject({
  method: 'POST',
  url: '/v1/recipes/generate',
  headers,
  payload: {
    ingredients: input?.ingredients ?? ['Orata', 'Patate'],
    dietProfile: input?.dietProfile ?? defaultDietProfile,
  },
});

const explicitlySave = (app: ReturnType<typeof createApp>, recipe: GeneratedRecipeDraft) => app.inject({
  method: 'POST',
  url: '/v1/ai-recipes/save',
  headers,
  payload: {
    recipe: {
      ...recipe,
      id: 'generated-preview-1',
      source: 'ai',
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    },
  },
});

const writeGeneratedRecipe = async (
  repository: SyncRepository,
  userId: string,
  recipe: {
    id: string;
    title: string;
    ingredients: Array<{ name: string; amount: string }>;
  },
) => {
  await repository.applyMutation(userId, {
    mutationId: 'generated-recipe-1',
    deviceId: 'device-1',
    entityType: 'generated_recipe',
    entityId: recipe.id,
    operation: 'upsert',
    payload: {
      id: recipe.id,
      source: 'ai',
      title: recipe.title,
      description: 'Ricetta già presente nel ricettario.',
      ingredients: recipe.ingredients,
      steps: ['Cuoci tutto insieme.'],
      diets: ['pescatarian'],
      allergens: [],
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    },
    clientUpdatedAt: '2026-09-24T00:00:00.000Z',
  });
};

// ---------- B4: unit test dedup / novelty ----------

describe('recipe novelty dedup', () => {
  it('conflitto su titolo duplicato', () => {
    const candidate: RecipeReference = { title: 'Orata al cartoccio', ingredients: [] };
    const existing: RecipeReference[] = [{ title: 'Orata al cartoccio', ingredients: [] }];
    const conflict = findRecipeNoveltyConflict(candidate, existing);
    expect(conflict).toMatchObject({ reason: 'duplicate_title', title: 'Orata al cartoccio' });
  });

  it('ingredienti troppo simili genera conflitto', () => {
    const candidate: RecipeReference = {
      title: 'Zuppa di ceci',
      ingredients: [{ name: 'Ceci', amount: '240 g' }, { name: 'Pomodoro', amount: '200 g' }],
    };
    const existing: RecipeReference[] = [{
      title: 'Zuppa di legumi',
      ingredients: [{ name: 'Ceci', amount: '300 g' }, { name: 'Pomodoro', amount: '150 g' }],
    }];
    const conflict = findRecipeNoveltyConflict(candidate, existing);
    expect(conflict).not.toBeNull();
    expect(conflict?.reason).toBe('too_similar');
  });

  it('ricetta sufficientemente diversa non genera conflitto', () => {
    const candidate: RecipeReference = {
      title: 'Torta di mele',
      ingredients: [{ name: 'Mele', amount: '4' }, { name: 'Farina', amount: '200 g' }],
    };
    const existing: RecipeReference[] = [{
      title: 'Orata al cartoccio',
      ingredients: [{ name: 'Orata', amount: '1' }, { name: 'Patate', amount: '300 g' }],
    }];
    const conflict = findRecipeNoveltyConflict(candidate, existing);
    expect(conflict).toBeNull();
  });

  it('titoli diversi ma ingredienti identici è troppo simile', () => {
    const candidate: RecipeReference = {
      title: 'Polpette di ceci',
      ingredients: [{ name: 'Ceci', amount: '240 g' }],
    };
    const existing: RecipeReference[] = [{
      title: 'Hamburger di ceci',
      ingredients: [{ name: 'Ceci', amount: '240 g' }],
    }];
    const conflict = findRecipeNoveltyConflict(candidate, existing);
    expect(conflict).not.toBeNull();
    expect(conflict?.reason).toBe('too_similar');
  });
});

// ---------- B5: integration test endpoint ----------

describe('POST /v1/recipes/generate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a local recipe suggestion without dispatching to an LLM when consent is absent', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });
    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate' });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await repository.readAll('user-1')).toHaveLength(0);
    await app.close();
  });

  it('allows the valid local preview to be saved only through the explicit save route', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });

    const generated = await generate(app);
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({ kind: 'candidate' });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(parseGeneratedRecipeDraft(generated.json().recipe)).not.toBeNull();
    expect(await repository.readAll('user-1')).toHaveLength(0);

    const saved = await explicitlySave(app, generated.json().recipe as GeneratedRecipeDraft);
    expect(saved.statusCode).toBe(200);
    expect(await repository.readAll('user-1')).toHaveLength(1);
    await app.close();
  });

  it('passes the active dietary profile to the recipe provider', async () => {
    const profile = {
      diet: 'vegan',
      excludedAllergens: ['milk'],
      nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
    } as const;
    const veganDraft: GeneratedRecipeDraft = {
      title: 'Ceci e riso',
      description: 'Ceci e riso con olio e spezie.',
      ingredients: [{ name: 'Ceci', amount: '150 g' }, { name: 'Riso', amount: '100 g' }],
      steps: ['Cuoci il riso e unisci i ceci.'],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'],
      allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(veganDraft) };
    const { app, repository } = createRecipeApp({ provider, bypassConsent: true });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recipes/generate',
      headers,
      payload: { ingredients: ['Ceci', 'Riso'], dietProfile: profile },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ dietProfile: profile }));
    expect(await repository.readAll('user-1')).toHaveLength(0);

    const saved = await explicitlySave(app, response.json().recipe as GeneratedRecipeDraft);
    expect(saved.statusCode).toBe(200);
    expect(await repository.readAll('user-1')).toHaveLength(1);
    await app.close();
  });

  it('rejects a provider recipe that contains an excluded allergen', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    const response = await generate(app, {
      dietProfile: {
        ...defaultDietProfile,
        diet: 'pescatarian',
        excludedAllergens: ['fish'],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'ai_recipe_incompatible' });
    await app.close();
  });

  it('rejects a provider recipe outside the active vegan profile', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    const response = await generate(app, {
      dietProfile: { ...defaultDietProfile, diet: 'vegan' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'ai_recipe_incompatible' });
    expect(provider.generate).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects a malformed provider draft and returns only a validated local fallback', async () => {
    const malformedDraft = { ...draft, title: 'Titolo '.repeat(40), diets: [] } as GeneratedRecipeDraft;
    const provider = { generate: vi.fn().mockResolvedValue(malformedDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    const response = await generate(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate' });
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(parseGeneratedRecipeDraft(response.json().recipe)).not.toBeNull();
    expect(response.json().recipe.title).not.toBe(malformedDraft.title);
    await app.close();
  });

  it('releases reserved quota when fallback allergen facts are unknown', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({
        quota: { allowed: true, used: 1, remaining: 9999 },
        commit,
        release,
      }),
    };
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, limiter });

    const response = await generate(app, { ingredients: ['Curry'] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'none_available' });
    expect(response.json()).toMatchObject({
      ingredientReview: {
        consideredIngredients: ['Curry'],
        excludedIngredients: [{ name: 'Curry', reason: 'composition_unverified' }],
      },
    });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns no candidate for generic Sugo without consent and releases its quota', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({
        quota: { allowed: true, used: 1, remaining: 9999 },
        commit,
        release,
      }),
    };
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider, limiter });
    const response = await generate(app, {
      ingredients: ['Sugo'],
      dietProfile: {
        diet: 'vegan',
        excludedAllergens: ['celery'],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      },
    });

    expect.soft(response.statusCode).toBe(200);
    expect.soft(response.json()).toMatchObject({ kind: 'none_available' });
    expect.soft(provider.generate).not.toHaveBeenCalled();
    expect.soft(await repository.readAll('user-1')).toHaveLength(0);
    expect.soft(commit).not.toHaveBeenCalled();
    expect.soft(release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('releases reserved quota when dried fruit is the only sulphite-excluded ingredient', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({
        quota: { allowed: true, used: 1, remaining: 9999 },
        commit,
        release,
      }),
    };
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider, limiter });

    try {
      const response = await generate(app, {
        ingredients: ['Uvetta'],
        dietProfile: { ...defaultDietProfile, excludedAllergens: ['sulphites'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'none_available' });
      expect(response.json()).not.toHaveProperty('recipe');
      expect(provider.generate).not.toHaveBeenCalled();
      expect(await repository.readAll('user-1')).toHaveLength(0);
      expect(limiter.reserve).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(['Sugo', 'Olio', 'Pasta', 'Couscous', 'Pangrattato', 'Fagioli'])(
    'rejects Home-normalized %s without consent and releases quota',
    async (input) => {
      const commit = vi.fn().mockResolvedValue(undefined);
      const release = vi.fn().mockResolvedValue(undefined);
      const limiter = {
        consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
        reserve: vi.fn().mockResolvedValue({
          quota: { allowed: true, used: 1, remaining: 9999 }, commit, release,
        }),
      };
      const provider = { generate: vi.fn().mockResolvedValue(draft) };
      const { app, repository } = createRecipeApp({ provider, limiter });
      try {
        const response = await generate(app, {
          ingredients: parseIngredientInput(input).map(({ label }) => label),
          dietProfile: { ...defaultDietProfile, diet: 'vegan', excludedAllergens: ['celery'] },
        });

        expect.soft(response.statusCode).toBe(200);
        expect.soft(response.json()).toMatchObject({ kind: 'none_available' });
        expect.soft(response.json()).not.toHaveProperty('recipe');
        expect.soft(provider.generate).not.toHaveBeenCalled();
        expect.soft(await repository.readAll('user-1')).toHaveLength(0);
        expect.soft(commit).not.toHaveBeenCalled();
        expect.soft(release).toHaveBeenCalledExactlyOnceWith();
      } finally {
        await app.close();
      }
    },
  );

  it('only proposes the safe subset of a Home-normalized mixed pantry', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });
    try {
      const response = await generate(app, {
        ingredients: parseIngredientInput('Sugo, Riso').map(({ label }) => label),
        dietProfile: { ...defaultDietProfile, diet: 'vegan', excludedAllergens: ['celery'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate', recipe: { ingredients: [{ name: 'Riso', amount: 'q.b.' }] },
      });
      expect(provider.generate).not.toHaveBeenCalled();
      expect(await repository.readAll('user-1')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('explains safety exclusions while retaining a compatible ingredient without consent', async () => {
    const ingredients = parseIngredientInput('Grana, Riso, Curry').map(({ label }) => label);
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });

    try {
      const response = await generate(app, {
        ingredients,
        dietProfile: { ...defaultDietProfile, excludedAllergens: ['eggs'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { ingredients: [{ name: 'Riso', amount: 'q.b.' }] },
        ingredientReview: {
          consideredIngredients: ingredients,
          excludedIngredients: [
            { name: 'Parmigiano', reason: 'excluded_allergen', allergens: ['eggs'] },
            { name: 'Curry', reason: 'composition_unverified' },
          ],
        },
      });
      expect(provider.generate).not.toHaveBeenCalled();
      expect(await repository.readAll('user-1')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('releases reserved quota when Grana is excluded for its egg allergen', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({ quota: { allowed: true, used: 1, remaining: 9999 }, commit, release }),
    };
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, limiter });

    try {
      const response = await generate(app, {
        ingredients: parseIngredientInput('Grana').map(({ label }) => label),
        dietProfile: { ...defaultDietProfile, excludedAllergens: ['eggs'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'none_available',
        ingredientReview: {
          excludedIngredients: [{ name: 'Parmigiano', reason: 'excluded_allergen', allergens: ['eggs'] }],
        },
      });
      expect(commit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('falls back to a local candidate when the consented provider is unavailable', async () => {
    const provider = { generate: vi.fn().mockRejectedValue(new Error('provider down')) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });
    const response = await generate(app, { ingredients: ['Orata', 'Patate', 'Curry'] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'candidate',
      ingredientReview: {
        consideredIngredients: ['Orata', 'Patate', 'Curry'],
        excludedIngredients: [{ name: 'Curry', reason: 'composition_unverified' }],
      },
    });
    await app.close();
  });

  it('passes every pantry label, including custom ones, to the consented provider', async () => {
    const ingredients = ['Orata', 'Ingrediente personalizzato'];
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients });

      expect(response.statusCode).toBe(200);
      expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ ingredients }));
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        ingredientReview: { consideredIngredients: ingredients },
      });
    } finally {
      await app.close();
    }
  });

  it('reviews the full 100-label pantry without treating the recipe cap as a pantry limit', async () => {
    const ingredients = Array.from({ length: AI_RECIPE_MAX_GENERATION_INGREDIENTS }, (_value, index) =>
      index % 2 === 0 ? 'Orata' : 'Patate');
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients });

      expect(response.statusCode).toBe(200);
      expect(response.json().ingredientReview.consideredIngredients).toEqual(ingredients);
      expect(response.json().ingredientReview.assessments).toHaveLength(AI_RECIPE_MAX_GENERATION_INGREDIENTS);
      expect(response.json().ingredientReview.assessments.every((assessment: { disposition: string }) => assessment.disposition === 'used')).toBe(true);
      expect(response.json().ingredientReview.excludedIngredients).toEqual([]);
      expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ ingredients }));
    } finally {
      await app.close();
    }
  });

  it('rejects a provider candidate with unverified ingredient composition and falls back safely', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      ...draft,
      ingredients: [{ name: 'Tempeh', amount: '200 g' }],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'],
      allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Riso', 'Tempeh'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { ingredients: [{ name: 'Riso', amount: 'q.b.' }] },
        ingredientReview: {
          consideredIngredients: ['Riso', 'Tempeh'],
          excludedIngredients: [{ name: 'Tempeh', reason: 'composition_unverified' }],
        },
      });
      expect(provider.generate).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('uses a compatible vegan pantry fallback without provider consent', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });

    const response = await generate(app, {
      ingredients: ['Pollo', 'Ceci'],
      dietProfile: { ...defaultDietProfile, diet: 'vegan' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate' });
    expect(response.json().recipe.diets).toContain('vegan');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(await repository.readAll('user-1')).toHaveLength(0);
    await app.close();
  });

  it('finds a compatible fallback in a large mixed pantry without consent', async () => {
    const safe = [
      'Acqua', 'Sale', 'Pepe', 'Riso', 'Ceci', 'Lenticchie', 'Piselli', 'Limone',
      'Rucola', 'Pomodoro', 'Pomodorini', 'Olive', 'Zucchine', 'Peperoni', 'Spinaci',
      'Melanzane', 'Carote', 'Sedano', 'Cipolla', 'Aglio', 'Prezzemolo', 'Basilico', 'Patate',
    ];
    const mixed = [
      ...safe.slice(0, 4), 'Pollo', ...safe.slice(4, 11), 'Tacchino',
      ...safe.slice(11, 18), 'Manzo', ...safe.slice(18),
    ];
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const response = await generate(app, {
        ingredients: parseIngredientInput(mixed.join(', ')).map(({ label }) => label),
        dietProfile: { ...defaultDietProfile, diet: 'vegan' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'candidate' });
      expect(response.json().recipe.ingredients.map(({ name }: { name: string }) => name)).toEqual(safe);
      expect(provider.generate).not.toHaveBeenCalled();
      expect(await repository.readAll('user-1')).toHaveLength(0);
    } finally {
      random.mockRestore();
      await app.close();
    }
  });

  it('returns none_available when the local fallback conflicts with a vegan profile', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider });

    const response = await generate(app, {
      ingredients: ['Pollo'],
      dietProfile: { ...defaultDietProfile, diet: 'vegan' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'none_available' });
    expect(provider.generate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns none_available when the local fallback contains an excluded allergen', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider });

    const response = await generate(app, {
      ingredients: ['Latte'],
      dietProfile: { ...defaultDietProfile, excludedAllergens: ['milk'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'none_available' });
    expect(provider.generate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns none_available when every local candidate conflicts with saved recipes', async () => {
    const { app, repository } = createRecipeApp();
    await writeGeneratedRecipe(repository, 'user-1', {
      id: 'generated-1',
      title: 'Orata al cartoccio',
      ingredients: [{ name: 'Orata', amount: '1' }],
    });
    const response = await generate(app, { ingredients: ['Orata'] });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'none_available' });
    await app.close();
  });

  it('restituisce 200 con candidato quando il provider genera una ricetta nuova', async () => {
    const { app } = createRecipeApp({ bypassConsent: true });
    const response = await generate(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate', recipe: draft });
    await app.close();
  });

  it('restituisce 200 none_available quando la ricetta è già salvata (dedup)', async () => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider, bypassConsent: true });
    await writeGeneratedRecipe(repository, 'user-1', {
      id: 'generated-1',
      title: 'Orata al cartoccio',
      ingredients: [{ name: 'Orata', amount: '1' }],
    });
    const response = await generate(app, { ingredients: ['Orata'] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'none_available' });
    await app.close();
  });

  it.each([
    ['missing', { ingredients: ['Orata'] }],
    ['malformed', {
      ingredients: ['Orata'],
      dietProfile: {
        diet: 'flexitarian',
        excludedAllergens: [],
        nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
      },
    }],
  ])('rejects a %s active diet profile in the request', async (_label, payload) => {
    const { app } = createRecipeApp({ bypassConsent: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recipes/generate',
      headers,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
    await app.close();
  });

  it('restituisce 400 su payload non valido (ingredienti vuoti)', async () => {
    const { app } = createRecipeApp({ bypassConsent: true });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recipes/generate',
      headers,
      payload: { ingredients: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_payload' });
    await app.close();
  });

  it('does not propose a compound seafood label when its allergen is excluded without consent', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({ quota: { allowed: true, used: 1, remaining: 9999 }, commit, release }),
    };
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app } = createRecipeApp({ provider, limiter });

    try {
      const response = await generate(app, {
        ingredients: ['Riso e gamberi'],
        dietProfile: { ...defaultDietProfile, diet: 'vegan', excludedAllergens: ['crustaceans'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'none_available',
        ingredientReview: {
          resultSource: 'none',
          excludedIngredients: [{ name: 'Riso e gamberi', reason: 'excluded_allergen', allergens: ['crustaceans'] }],
        },
      });
      expect(provider.generate).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('rejects a consented provider draft that omits additive seafood facts', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }),
      reserve: vi.fn().mockResolvedValue({ quota: { allowed: true, used: 1, remaining: 9999 }, commit, release }),
    };
    const provider = { generate: vi.fn().mockResolvedValue({
      ...draft,
      title: 'Riso ai gamberi',
      ingredients: [{ name: 'Riso e gamberi', amount: '200 g' }],
      diets: ['omnivore', 'vegan'],
      allergens: [],
    }) };
    const { app } = createRecipeApp({ provider, limiter, bypassConsent: true });

    try {
      const response = await generate(app, {
        ingredients: ['Riso e gamberi'],
        dietProfile: { ...defaultDietProfile, diet: 'vegan', excludedAllergens: ['crustaceans'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'none_available',
        ingredientReview: { resultSource: 'none' },
      });
      expect(response.json()).not.toHaveProperty('recipe');
      expect(provider.generate).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each(['Zucca', 'Mele', 'Quinoa'])('returns the actual provider recipe for simple noncatalog food %s', async (name) => {
    const providerDraft: GeneratedRecipeDraft = {
      title: `Ricetta con ${name}`,
      description: `Una preparazione con ${name}.`,
      ingredients: [{ name, amount: '200 g' }],
      steps: [`Prepara ${name}.`],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'],
      allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: [name] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { title: providerDraft.title, ingredients: providerDraft.ingredients },
        ingredientReview: {
          resultSource: 'provider',
          assessments: [{ inputIndex: 0, name, disposition: 'used', evidence: 'name_facts', recipeIngredientIndexes: [0] }],
          excludedIngredients: [],
        },
      });
      expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ ingredients: [name] }));
    } finally {
      await app.close();
    }
  });

  it('does not infer gluten from Quinoa being displayed in the grain category', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Quinoa semplice', description: 'Quinoa con verdure.',
      ingredients: [{ name: 'Quinoa', amount: '100 g' }], steps: ['Cuoci la quinoa.'],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, {
        ingredients: ['Quinoa'],
        dietProfile: { ...defaultDietProfile, excludedAllergens: ['gluten'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'candidate', recipe: providerDraft });
      expect(response.json().ingredientReview.assessments[0]).toMatchObject({
        disposition: 'used', allergenCoverage: 'complete', possibleAllergens: [],
      });
    } finally {
      await app.close();
    }
  });

  it('allows generic Pasta only as a visibly partial omnivore provider proposal', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Pasta al pomodoro', description: 'Pasta con pomodoro.',
      ingredients: [{ name: 'Pasta', amount: '160 g' }], steps: ['Cuoci la pasta.'],
      diets: ['omnivore'], allergens: ['gluten'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Pasta'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { ...providerDraft, allergens: ['gluten', 'eggs'] },
        ingredientReview: {
          resultSource: 'provider',
          assessments: [{
            inputIndex: 0, name: 'Pasta', disposition: 'used', evidence: 'provider_declared',
            allergenCoverage: 'partial', recipeIngredientIndexes: [0], possibleAllergens: ['eggs'],
          }],
        },
      });
      expect(response.json().ingredientReview.assessments[0].warning).toMatch(/controlla l'etichetta/i);
      expect(response.json().ingredientReview.excludedIngredients).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('preserves generic Pasta risks in the effective recipe and explicit save readback', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Pasta semplice', description: 'Pasta al pomodoro.',
      ingredients: [{ name: 'Pasta', amount: '160 g' }], steps: ['Cuoci la pasta.'],
      diets: ['omnivore'], allergens: ['gluten'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app, repository } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Pasta'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { allergens: ['gluten', 'eggs'] },
        ingredientReview: { assessments: [{ presentAllergens: ['gluten'], possibleAllergens: ['eggs'] }] },
      });
      expect(await repository.readAll('user-1')).toHaveLength(0);

      const saved = await explicitlySave(app, response.json().recipe as GeneratedRecipeDraft);
      expect(saved.statusCode).toBe(200);
      const readback = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
      expect(readback.statusCode).toBe(200);
      expect(readback.json().recipes).toContainEqual(expect.objectContaining({
        id: 'generated-preview-1', allergens: ['gluten', 'eggs'],
      }));
    } finally {
      await app.close();
    }
  });

  it('preserves a provider-positive allergen in the effective recipe and explicit save readback', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Riso', description: 'Riso semplice.',
      ingredients: [{ name: 'Riso', amount: '100 g' }], steps: ['Cuoci il riso.'],
      diets: ['omnivore'], allergens: ['soybeans'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app, repository } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Riso'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'candidate', recipe: { allergens: ['soybeans'] } });
      expect(await repository.readAll('user-1')).toHaveLength(0);

      const saved = await explicitlySave(app, response.json().recipe as GeneratedRecipeDraft);
      expect(saved.statusCode).toBe(200);
      const readback = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
      expect(readback.statusCode).toBe(200);
      expect(readback.json().recipes).toContainEqual(expect.objectContaining({
        id: 'generated-preview-1', allergens: ['soybeans'],
      }));
    } finally {
      await app.close();
    }
  });

  it('rejects a provider vegan claim contradicted by a declared animal allergen', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Riso vegano con latte', description: 'Una proposta contraddittoria.',
      ingredients: [{ name: 'Riso', amount: '100 g' }], steps: ['Cuoci il riso.'],
      diets: ['omnivore', 'vegan'], allergens: ['milk'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app, repository } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, {
        ingredients: ['Riso'],
        dietProfile: { ...defaultDietProfile, diet: 'vegan' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { title: 'Padellata di Riso', diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], allergens: [] },
        ingredientReview: { resultSource: 'local' },
      });
      expect(response.json().recipe.title).not.toBe(providerDraft.title);
      expect(provider.generate).toHaveBeenCalledOnce();
      expect(await repository.readAll('user-1')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    { name: 'Grana', allergens: ['eggs', 'milk'], possibleAllergens: ['eggs'] },
    { name: 'Mortadella', allergens: ['nuts', 'sulphites'], possibleAllergens: ['nuts', 'sulphites'] },
  ])('preserves local $name risks in the effective recipe and explicit save readback', async ({ name, allergens, possibleAllergens }) => {
    const provider = { generate: vi.fn().mockResolvedValue(draft) };
    const { app, repository } = createRecipeApp({ provider });

    try {
      const response = await generate(app, { ingredients: [name] });

      expect(response.statusCode).toBe(200);
      expect(response.json().kind).toBe('candidate');
      expect(response.json().recipe.allergens).toEqual(allergens);
      expect(response.json().ingredientReview.assessments[0].possibleAllergens).toEqual(possibleAllergens);
      expect(provider.generate).not.toHaveBeenCalled();
      expect(await repository.readAll('user-1')).toHaveLength(0);

      const saved = await explicitlySave(app, response.json().recipe as GeneratedRecipeDraft);
      expect(saved.statusCode).toBe(200);
      const readback = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
      expect(readback.statusCode).toBe(200);
      expect(readback.json().recipes).toContainEqual(expect.objectContaining({
        id: 'generated-preview-1', allergens,
      }));
    } finally {
      await app.close();
    }
  });

  it('warns about partial-risk components added to a mapped provider ingredient', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Riso e Mortadella', description: 'Una preparazione semplice.',
      ingredients: [{ name: 'Riso e Mortadella', amount: '180 g' }],
      steps: ['Cuoci il riso con la Mortadella.'], diets: ['omnivore'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Riso'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { allergens: ['nuts', 'sulphites'] },
        ingredientReview: {
          assessments: [{ inputIndex: 0, name: 'Riso', disposition: 'used', recipeIngredientIndexes: [0] }],
          recipeIngredientWarnings: [{
            ingredientIndex: 0, name: 'Riso e Mortadella', allergenCoverage: 'partial',
            possibleAllergens: ['nuts', 'sulphites'],
          }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('attributes a separated compound pantry warning to its matching output component', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Riso, latte e mortadella', description: 'Una preparazione semplice.',
      ingredients: [
        { name: 'Riso', amount: '100 g' },
        { name: 'Latte', amount: '100 ml' },
        { name: 'Mortadella', amount: '80 g' },
      ],
      steps: ['Cuoci gli ingredienti.'], diets: ['omnivore'], allergens: ['milk'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Riso e Latte e Mortadella'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { allergens: ['milk', 'nuts', 'sulphites'] },
        ingredientReview: {
          assessments: [{
            name: 'Riso e Latte e Mortadella', disposition: 'used',
            allergenCoverage: 'partial', presentAllergens: ['milk'], possibleAllergens: ['nuts', 'sulphites'],
            recipeIngredientIndexes: [0, 1, 2],
          }],
          recipeIngredientWarnings: [{
            ingredientIndex: 2, name: 'Mortadella', allergenCoverage: 'partial',
            presentAllergens: [], possibleAllergens: ['nuts', 'sulphites'],
          }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('maps both source ingredients and keeps the generic Pasta warning in an additive provider output', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Pasta e Pomodoro', description: 'Una preparazione semplice.',
      ingredients: [{ name: 'Pasta e Pomodoro', amount: '180 g' }],
      steps: ['Cuoci la pasta con il pomodoro.'], diets: ['omnivore'], allergens: ['gluten'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Pasta', 'Pomodoro'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { allergens: ['gluten', 'eggs'] },
        ingredientReview: {
          assessments: [
            {
              inputIndex: 0, name: 'Pasta', disposition: 'used', recipeIngredientIndexes: [0],
              presentAllergens: ['gluten'], possibleAllergens: ['eggs'], allergenCoverage: 'partial',
            },
            { inputIndex: 1, name: 'Pomodoro', disposition: 'used', recipeIngredientIndexes: [0] },
          ],
          excludedIngredients: [],
          recipeIngredientWarnings: [{
            ingredientIndex: 0, name: 'Pasta e Pomodoro', allergenCoverage: 'partial',
            presentAllergens: ['gluten'], possibleAllergens: ['eggs'],
          }],
        },
      });
      expect(response.json().ingredientReview.assessments[0].warning).toMatch(/controlla l'etichetta/i);
    } finally {
      await app.close();
    }
  });

  it('reports partial-composition risks for provider ingredients not sourced from the pantry', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Riso con mortadella', description: 'Una ricetta.',
      ingredients: [{ name: 'Riso', amount: '100 g' }, { name: 'Mortadella', amount: '80 g' }],
      steps: ['Cuoci il riso.'], diets: ['omnivore'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Riso'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        recipe: { ...providerDraft, allergens: ['nuts', 'sulphites'] },
        ingredientReview: {
          resultSource: 'provider',
          recipeIngredientWarnings: [{
            ingredientIndex: 1, name: 'Mortadella', allergenCoverage: 'partial',
            possibleAllergens: ['nuts', 'sulphites'],
          }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['eggs', { ...defaultDietProfile, excludedAllergens: ['eggs'] }],
    ['gluten', { ...defaultDietProfile, excludedAllergens: ['gluten'] }],
    ['vegan', { ...defaultDietProfile, diet: 'vegan' }],
  ] as Array<[string, DietProfilePayload]>)('does not treat a provider rename as proof that generic Pasta is safe for %s', async (_restriction, dietProfile) => {
    const provider = { generate: vi.fn().mockResolvedValue({
      title: 'Pasta senza uova', description: 'Una pasta.',
      ingredients: [{ name: 'Pasta di semola senza uova', amount: '160 g' }],
      steps: ['Cuoci la pasta.'], diets: ['omnivore'], allergens: ['gluten'],
    }) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Pasta'], dietProfile });

      expect(response.statusCode === 200 && response.json().kind === 'candidate').toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each(['Sugo', 'Curry', 'Riso e miscela ignota', 'Miscela senza allergeni'])('fails closed for consented provider output using unknown composition %s', async (name) => {
    const provider = { generate: vi.fn().mockResolvedValue({
      title: `Ricetta con ${name}`, description: 'Una preparazione.',
      ingredients: [{ name, amount: '200 g' }], steps: ['Prepara gli ingredienti.'],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], allergens: [],
    }) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: [name] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'none_available', ingredientReview: { resultSource: 'none' } });
      expect(response.json()).not.toHaveProperty('recipe');
    } finally {
      await app.close();
    }
  });

  it('accepts the Home-normalized beef strips label while retaining the raw Manzo control', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Manzo', description: 'Manzo semplice.',
      ingredients: [{ name: 'Manzo', amount: '150 g' }], steps: ['Cuoci il manzo.'],
      diets: ['omnivore'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const raw = await generate(app, { ingredients: ['Manzo'] });
      expect(raw.statusCode).toBe(200);
      expect(raw.json()).toMatchObject({ kind: 'candidate', ingredientReview: { assessments: [{ disposition: 'used' }] } });

      const normalizedIngredients = parseIngredientInput('Manzo').map(({ label }) => label);
      expect(normalizedIngredients).toEqual(['Straccetti di manzo']);
      const normalized = await generate(app, { ingredients: normalizedIngredients });

      expect(normalized.statusCode).toBe(200);
      expect(normalized.json()).toMatchObject({
        kind: 'candidate',
        ingredientReview: {
          consideredIngredients: ['Straccetti di manzo'],
          assessments: [{ name: 'Straccetti di manzo', disposition: 'used', recipeIngredientIndexes: [0] }],
        },
      });
      expect(provider.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ ingredients: ['Straccetti di manzo'] }));
    } finally {
      await app.close();
    }
  });

  it('accepts the canonical generic Carne macinata label without inferring an animal species', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Carne macinata', description: 'Una preparazione semplice.',
      ingredients: [{ name: 'Carne macinata', amount: '150 g' }], steps: ['Cuoci la carne.'],
      diets: ['omnivore'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const ingredients = parseIngredientInput('Carne macinata').map(({ label }) => label);
      expect(ingredients).toEqual(['Carne macinata']);
      const response = await generate(app, { ingredients });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        ingredientReview: {
          consideredIngredients: ['Carne macinata'],
          assessments: [{ name: 'Carne macinata', disposition: 'used', recipeIngredientIndexes: [0] }],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('maps a provider-selected 31st source to the actual recipe without a fallback limit exclusion', async () => {
    const ingredients = [
      'Acqua', 'Sale', 'Pepe', 'Riso', 'Ceci', 'Lenticchie', 'Piselli', 'Limone', 'Rucola',
      'Pomodoro', 'Pomodorini', 'Olive', 'Zucchine', 'Peperoni', 'Spinaci', 'Melanzane',
      'Carote', 'Sedano', 'Cipolla', 'Aglio', 'Prezzemolo', 'Basilico', 'Patate', 'Pollo',
      'Tacchino', 'Manzo', 'Tonno', 'Merluzzo', 'Salmone', 'Uova', 'Orata',
    ];
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Orata', description: 'Orata alla piastra.',
      ingredients: [{ name: 'Orata', amount: '1' }], steps: ['Cuoci l’orata.'],
      diets: ['omnivore', 'pescatarian'], allergens: ['fish'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'candidate', recipe: providerDraft });
      expect(response.json().ingredientReview.assessments[30]).toMatchObject({
        inputIndex: 30, name: 'Orata', disposition: 'used', recipeIngredientIndexes: [0],
      });
      expect(response.json().ingredientReview.excludedIngredients).not.toContainEqual(
        expect.objectContaining({ name: 'Orata' }),
      );
    } finally {
      await app.close();
    }
  });

  it('maps Patate novelle to Patate only through the explicit simple-food equivalence', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Patate', description: 'Patate al forno.',
      ingredients: [{ name: 'Patate', amount: '200 g' }], steps: ['Cuoci le patate.'],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Patate novelle'] });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: 'candidate',
        ingredientReview: {
          resultSource: 'provider',
          assessments: [{ inputIndex: 0, name: 'Patate novelle', disposition: 'used', recipeIngredientIndexes: [0] }],
          excludedIngredients: [],
        },
      });
    } finally {
      await app.close();
    }
  });

  it('does not equate Patate al pesto with a provider ingredient named Patate', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Patate', description: 'Patate al forno.',
      ingredients: [{ name: 'Patate', amount: '200 g' }], steps: ['Cuoci le patate.'],
      diets: ['omnivore', 'vegetarian', 'pescatarian', 'vegan'], allergens: [],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Patate al pesto'] });

      expect(response.statusCode === 200 && response.json().kind === 'candidate').toBe(false);
    } finally {
      await app.close();
    }
  });

  it('marks a safe provider-ignored pantry label as not selected, not excluded', async () => {
    const providerDraft: GeneratedRecipeDraft = {
      title: 'Orata', description: 'Orata alla piastra.',
      ingredients: [{ name: 'Orata', amount: '1' }], steps: ['Cuoci l’orata.'],
      diets: ['omnivore', 'pescatarian'], allergens: ['fish'],
    };
    const provider = { generate: vi.fn().mockResolvedValue(providerDraft) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });

    try {
      const response = await generate(app, { ingredients: ['Orata', 'Patate'] });

      expect(response.statusCode).toBe(200);
      expect(response.json().ingredientReview.assessments).toMatchObject([
        { inputIndex: 0, name: 'Orata', disposition: 'used', recipeIngredientIndexes: [0] },
        { inputIndex: 1, name: 'Patate', disposition: 'not_selected', reason: 'not_selected', recipeIngredientIndexes: [] },
      ]);
      expect(response.json().ingredientReview.excludedIngredients).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('restituisce 401 quando la sessione non è verificata', async () => {
    const { app } = createRecipeApp({ bypassConsent: true, authenticated: false });
    const response = await generate(app);
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('restituisce 429 quando il rate limiter esaurisce la quota', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: false, used: 10000, remaining: 0 }) };
    const { app } = createRecipeApp({ bypassConsent: true, limiter });
    const response = await generate(app);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'ai_daily_limit_reached' });
    await app.close();
  });
});
