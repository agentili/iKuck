import { describe, expect, it, vi } from 'vitest';
import type { AiConsent, DietProfilePayload, GeneratedRecipeDraft } from '@ikuck/shared/contracts';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { GenerationRateLimiter } from '../ai/rateLimit.js';
import { createMemorySyncRepository } from '../sync/repository.js';
import type { RecipeGenerationProvider } from '../providers/types.js';
import { ProviderTimeoutError } from '../providers/types.js';

const appOrigin = 'http://127.0.0.1:5173';
const headers = {
  cookie: 'ikuck_session=session-token',
  origin: appOrigin,
  'x-csrf-token': 'csrf-token',
};

const profile: DietProfilePayload = {
  diet: 'vegan',
  excludedAllergens: [],
  nutrition: { maxCaloriesPerServing: null, minProteinGramsPerServing: null },
};

const generatedDraft: GeneratedRecipeDraft = {
  title: 'Ceci croccanti',
  description: 'Una ricetta semplice e veloce.',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
  steps: ['Scola i ceci.', 'Rosolali in padella.'],
  diets: ['vegan'],
  allergens: [],
};

const session = (userId = 'user-1') => ({
  id: `session-${userId}`,
  userId,
  email: `${userId}@example.com`,
  csrfTokenHash: hashOpaqueToken('csrf-token'),
  expiresAt: new Date('2026-10-12T12:00:00.000Z'),
});

interface AiAppOptions {
  userId?: string;
  authenticated?: boolean;
  provider?: RecipeGenerationProvider;
  limiter?: GenerationRateLimiter;
}

const createAiApp = ({
  userId = 'user-1',
  authenticated = true,
  provider = { generate: vi.fn().mockResolvedValue(generatedDraft) },
  limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 4 }) },
}: AiAppOptions = {}) => {
  const repository = createMemorySyncRepository();
  const authService = {
    authenticate: vi.fn().mockResolvedValue(authenticated ? session(userId) : null),
  } as unknown as AuthService;
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin, secureCookies: false },
    aiRecipes: { provider, limiter, repository, authService, appOrigin },
  });
  return { app, repository, provider, limiter };
};

const consent = async (app: ReturnType<typeof createApp>, enabled: boolean): Promise<AiConsent> => {
  const response = await app.inject({ method: 'PUT', url: '/v1/ai-recipes/consent', headers, payload: { enabled } });
  expect(response.statusCode).toBe(200);
  return response.json().consent as AiConsent;
};

const generate = (app: ReturnType<typeof createApp>, input: Partial<{ dietProfile: DietProfilePayload }> = {}) => app.inject({
  method: 'POST',
  url: '/v1/ai-recipes',
  headers,
  payload: {
    ingredients: ['Ceci', 'Pomodoro'],
    constraints: ['Una sola padella'],
    dietProfile: input.dietProfile ?? profile,
  },
});

describe('AI recipe routes', () => {
  it('returns disabled consent, supports revocation and keeps private recipes removable', async () => {
    const { app } = createAiApp();

    const initial = await app.inject({ method: 'GET', url: '/v1/ai-recipes/consent', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ consent: { enabled: false } });

    await expect(consent(app, true)).resolves.toMatchObject({ enabled: true });
    const generated = await generate(app);
    expect(generated.statusCode).toBe(201);
    expect(generated.json()).toMatchObject({ recipe: { source: 'ai', title: generatedDraft.title } });

    await expect(consent(app, false)).resolves.toMatchObject({ enabled: false });
    const saved = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().recipes).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/v1/ai-recipes/${saved.json().recipes[0].id}`, headers });
    expect(removed.statusCode).toBe(204);
    await expect(app.inject({ method: 'GET', url: '/v1/ai-recipes', headers })).resolves.toMatchObject({ statusCode: 200 });
    const afterRemoval = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
    expect(afterRemoval.json()).toEqual({ recipes: [] });
    await app.close();
  });

  it('requires authentication, same origin and CSRF for private mutations', async () => {
    const unauthenticated = createAiApp({ authenticated: false });
    const missingSession = await unauthenticated.app.inject({ method: 'GET', url: '/v1/ai-recipes/consent', headers });
    expect(missingSession.statusCode).toBe(401);
    await unauthenticated.app.close();

    const { app } = createAiApp();
    const foreignOrigin = await app.inject({
      method: 'PUT',
      url: '/v1/ai-recipes/consent',
      headers: { ...headers, origin: 'https://attacker.example' },
      payload: { enabled: true },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'csrf_failed' });

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/v1/ai-recipes',
      headers: { cookie: headers.cookie, origin: appOrigin },
      payload: { ingredients: ['Ceci'], constraints: [], dietProfile: profile },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: 'csrf_failed' });
    await app.close();
  });

  it('blocks generation until consent is active and rejects invalid requests', async () => {
    const { app, provider } = createAiApp();
    const withoutConsent = await generate(app);
    expect(withoutConsent.statusCode).toBe(403);
    expect(withoutConsent.json()).toMatchObject({ code: 'ai_consent_required' });
    expect(provider.generate).not.toHaveBeenCalled();

    await consent(app, true);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/ai-recipes',
      headers,
      payload: { ingredients: [], constraints: [], dietProfile: profile },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });
    await app.close();
  });

  it('consumes five daily attempts and rejects the sixth without calling the provider', async () => {
    let used = 0;
    const provider: RecipeGenerationProvider = { generate: vi.fn().mockResolvedValue(generatedDraft) };
    const limiter: GenerationRateLimiter = {
      consume: vi.fn(async () => {
        used += 1;
        return { allowed: used <= 5, used, remaining: Math.max(0, 5 - used) };
      }),
    };
    const { app } = createAiApp({ provider, limiter });
    await consent(app, true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(generate(app)).resolves.toMatchObject({ statusCode: 201 });
    }
    const exhausted = await generate(app);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ code: 'ai_daily_limit_reached' });
    expect(provider.generate).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it('commits quota only after provider success and releases it on provider failure', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const limiter: GenerationRateLimiter = {
      consume: vi.fn(),
      reserve: vi.fn().mockResolvedValue({
        quota: { allowed: true, used: 1, remaining: 4 },
        commit,
        release,
      }),
    };
    const provider: RecipeGenerationProvider = { generate: vi.fn().mockResolvedValue(generatedDraft) };
    const { app } = createAiApp({ provider, limiter });
    await consent(app, true);

    await expect(generate(app)).resolves.toMatchObject({ statusCode: 201 });
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    const failedCommit = vi.fn().mockResolvedValue(undefined);
    const failedRelease = vi.fn().mockResolvedValue(undefined);
    const failedProvider: RecipeGenerationProvider = { generate: vi.fn().mockRejectedValue(new Error('provider failed')) };
    const failed = createAiApp({
      provider: failedProvider,
      limiter: {
        consume: vi.fn(),
        reserve: vi.fn().mockResolvedValue({
          quota: { allowed: true, used: 1, remaining: 4 },
          commit: failedCommit,
          release: failedRelease,
        }),
      },
    });
    await consent(failed.app, true);

    await expect(generate(failed.app)).resolves.toMatchObject({ statusCode: 503 });
    expect(failedCommit).not.toHaveBeenCalled();
    expect(failedRelease).toHaveBeenCalledOnce();

    const invalidRelease = vi.fn().mockResolvedValue(undefined);
    const invalid = createAiApp({
      provider: { generate: vi.fn().mockResolvedValue({ ...generatedDraft, title: '' }) },
      limiter: {
        consume: vi.fn(),
        reserve: vi.fn().mockResolvedValue({
          quota: { allowed: true, used: 1, remaining: 4 },
          commit: vi.fn().mockResolvedValue(undefined),
          release: invalidRelease,
        }),
      },
    });
    await consent(invalid.app, true);
    await expect(generate(invalid.app)).resolves.toMatchObject({ statusCode: 503 });
    expect(invalidRelease).toHaveBeenCalledOnce();

    const timeoutRelease = vi.fn().mockResolvedValue(undefined);
    const timedOut = createAiApp({
      provider: { generate: vi.fn().mockRejectedValue(new ProviderTimeoutError('recipes')) },
      limiter: {
        consume: vi.fn(),
        reserve: vi.fn().mockResolvedValue({
          quota: { allowed: true, used: 1, remaining: 4 },
          commit: vi.fn().mockResolvedValue(undefined),
          release: timeoutRelease,
        }),
      },
    });
    await consent(timedOut.app, true);
    await expect(generate(timedOut.app)).resolves.toMatchObject({ statusCode: 503 });
    expect(timeoutRelease).toHaveBeenCalledOnce();

    await app.close();
    await failed.app.close();
    await invalid.app.close();
    await timedOut.app.close();
  });

  it('does not let concurrent generations exceed the reserved quota', async () => {
    let active = 0;
    let resolveProvider: ((draft: GeneratedRecipeDraft) => void) | undefined;
    const provider: RecipeGenerationProvider = {
      generate: vi.fn(() => new Promise<GeneratedRecipeDraft>((resolve) => {
        resolveProvider = resolve;
      })),
    };
    const limiter: GenerationRateLimiter = {
      consume: vi.fn(),
      reserve: vi.fn(async () => {
        if (active >= 1) {
          return {
            quota: { allowed: false, used: 2, remaining: 0 },
            commit: async () => undefined,
            release: async () => undefined,
          };
        }
        active += 1;
        return {
          quota: { allowed: true, used: 1, remaining: 4 },
          commit: async () => undefined,
          release: async () => { active -= 1; },
        };
      }),
    };
    const { app } = createAiApp({ provider, limiter });
    await consent(app, true);

    const first = generate(app);
    await vi.waitFor(() => expect(provider.generate).toHaveBeenCalledOnce());
    await expect(generate(app)).resolves.toMatchObject({ statusCode: 429 });
    resolveProvider?.(generatedDraft);
    await expect(first).resolves.toMatchObject({ statusCode: 201 });
    await app.close();
  });

  it('returns only the authenticated account recipes and rejects incompatible output', async () => {
    const repository = createMemorySyncRepository();
    const privateRecipe = {
      id: 'private-user-2',
      ...generatedDraft,
      source: 'ai' as const,
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };
    await repository.applyMutation('user-2', {
      mutationId: 'private-user-2',
      deviceId: 'device-2',
      entityType: 'generated_recipe',
      entityId: privateRecipe.id,
      operation: 'upsert',
      payload: privateRecipe,
      clientUpdatedAt: privateRecipe.updatedAt,
    });
    const { app } = createAiApp();
    const listed = await app.inject({ method: 'GET', url: '/v1/ai-recipes', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ recipes: [] });
    await app.close();

    const incompatible: RecipeGenerationProvider = {
      generate: vi.fn().mockResolvedValue({ ...generatedDraft, allergens: ['fish'] }),
    };
    const isolated = createAiApp({ provider: incompatible });
    await consent(isolated.app, true);
    const response = await generate(isolated.app, {
      dietProfile: { ...profile, excludedAllergens: ['fish'] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'ai_recipe_incompatible' });
    const stored = await isolated.repository.readAll('user-1');
    expect(stored.filter((change) => change.entityType === 'generated_recipe')).toEqual([]);
    await isolated.app.close();
  });

  it('maps provider and limiter failures to stable unavailable responses', async () => {
    const provider: RecipeGenerationProvider = { generate: vi.fn().mockRejectedValue(new Error('provider details')) };
    const { app } = createAiApp({ provider });
    await consent(app, true);
    const response = await generate(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'provider_unavailable', message: 'AI recipe provider is unavailable' });
    await app.close();

    const failingLimiter: GenerationRateLimiter = { consume: vi.fn().mockRejectedValue(new Error('redis details')) };
    const unavailable = createAiApp({ limiter: failingLimiter });
    await consent(unavailable.app, true);
    const limited = await generate(unavailable.app);
    expect(limited.statusCode).toBe(503);
    expect(limited.json()).toMatchObject({ code: 'provider_unavailable' });
    await unavailable.app.close();
  });
});
