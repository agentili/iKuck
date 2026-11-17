import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AiConsent, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { findRecipeNoveltyConflict, type RecipeReference } from '../ai/recipeNovelty.js';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { GenerationRateLimiter } from '../ai/rateLimit.js';
import { createMemorySyncRepository, type SyncRepository } from '../sync/repository.js';
import type { RecipeGenerationProvider } from '../providers/types.js';

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
  diets: [],
  allergens: [],
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
  });
  return { app, repository: memoryRepo, provider, limiter };
};

const generate = (
  app: ReturnType<typeof createApp>,
  input?: { ingredients?: string[] },
) => app.inject({
  method: 'POST',
  url: '/v1/recipes/generate',
  headers,
  payload: { ingredients: input?.ingredients ?? ['Orata', 'Patate'] },
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

  it('falls back to a local candidate when the consented provider is unavailable', async () => {
    const provider = { generate: vi.fn().mockRejectedValue(new Error('provider down')) };
    const { app } = createRecipeApp({ provider, bypassConsent: true });
    const response = await generate(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'candidate' });
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
