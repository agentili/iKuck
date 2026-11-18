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

  it('falls back to a local candidate when the consented provider is unavailable', async () => {
    const provider = { generate: vi.fn().mockRejectedValue(new Error('provider down')) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });
    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate' });
    await app.close();
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
