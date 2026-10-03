import { describe, expect, it, vi } from 'vitest';
import type { DiaryRecipeDraft } from '@ikuck/shared/dinnerDiary';
import { createApp } from '../app.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import type { GenerationRateLimiter } from '../ai/rateLimit.js';
import type { AuthService } from '../auth/service.js';
import type { DinnerReconstructionProvider } from '../providers/types.js';
import { createProviders } from '../providers/factory.js';
import { createMemorySyncRepository } from '../sync/repository.js';

const appOrigin = 'http://127.0.0.1:5173';
const headers = { cookie: 'ikuck_session=session-token', origin: appOrigin, 'x-csrf-token': 'csrf-token' };
const recipeDraft: DiaryRecipeDraft = {
  draftId: 'server-draft-1',
  title: 'Pasta con zucchine',
  description: 'Pasta con zucchine e ricotta.',
  ingredients: [
    { name: 'Pasta', amount: '80 g', ingredientId: null, optional: false, provenance: 'provided' },
    { name: 'Ricotta', amount: '', ingredientId: null, optional: false, provenance: 'provided' },
  ],
  steps: ['Cuoci la pasta.', 'Condisci con zucchine e ricotta.'],
  servings: null,
  durationMinutes: null,
  diets: null,
  allergens: null,
  suggestedFields: ['title', 'description', 'amounts', 'steps', 'servings', 'durationMinutes', 'diets', 'allergens'],
};

const session = (authenticated: boolean) => authenticated ? ({
  id: 'session-user-1',
  userId: 'user-1',
  email: 'user-1@example.com',
  emailVerifiedAt: new Date('2026-09-24T00:00:00.000Z'),
  csrfTokenHash: hashOpaqueToken('csrf-token'),
  expiresAt: new Date('2026-10-12T12:00:00.000Z'),
}) : null;

interface TestOptions {
  authenticated?: boolean;
  dinnerProvider?: DinnerReconstructionProvider;
  limiter?: GenerationRateLimiter;
  recipeProvider?: 'openai' | 'gemini';
}

const createTestApp = ({
  authenticated = true,
  dinnerProvider = { reconstruct: vi.fn().mockResolvedValue([recipeDraft]) },
  limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }) },
  recipeProvider = 'openai',
}: TestOptions = {}) => {
  const repository = createMemorySyncRepository();
  const authService = { authenticate: vi.fn().mockResolvedValue(session(authenticated)) } as unknown as AuthService;
  const app = createApp({
    database: { ping: async () => undefined },
    cache: { ping: async () => undefined },
    auth: { service: authService, appOrigin, secureCookies: false },
    aiRecipes: {
      provider: { generate: vi.fn() },
      dinnerReconstructionProvider: dinnerProvider,
      limiter,
      repository,
      authService,
      appOrigin,
      recipeProvider,
    },
  });
  return { app, repository, dinnerProvider, limiter };
};

const enableConsent = async (app: ReturnType<typeof createApp>, recipeProvider: 'openai' | 'gemini' = 'openai') => {
  const current = await app.inject({ method: 'GET', url: '/v1/ai-recipes/consent', headers });
  const globalConsent = await app.inject({
    method: 'PUT', url: '/v1/ai-recipes/consent', headers,
    payload: { enabled: true, homeProvider: recipeProvider, expectedRevision: current.json().consent.updatedAt },
  });
  if (globalConsent.statusCode !== 200) return globalConsent;
  return app.inject({
    method: 'PUT', url: '/v1/ai-recipes/consent', headers,
    payload: { dinnerProvider: recipeProvider, expectedRevision: globalConsent.json().consent.updatedAt },
  });
};

const requestDrafts = (app: ReturnType<typeof createApp>, payload: unknown, requestHeaders = headers) => app.inject({
  method: 'POST', url: '/v1/ai-dinner-reconstruction', headers: requestHeaders, payload,
});

describe('AI dinner reconstruction route', () => {
  it('requires consent, sends only dinner text and servings, and returns unpersisted drafts', async () => {
    const suppliedServingDraft = {
      ...recipeDraft,
      servings: 3,
      suggestedFields: recipeDraft.suggestedFields.filter((field) => field !== 'servings'),
    };
    const dinnerProvider = { reconstruct: vi.fn().mockResolvedValue([suppliedServingDraft]) };
    const { app, repository, limiter } = createTestApp({ dinnerProvider });
    const payload = { dinnerText: 'Pasta con zucchine, poi insalata.', servings: 3 };

    const denied = await requestDrafts(app, payload);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ai_consent_required' });
    expect(dinnerProvider.reconstruct).not.toHaveBeenCalled();

    await expect(enableConsent(app)).resolves.toMatchObject({ statusCode: 200 });
    const accepted = await requestDrafts(app, payload);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ drafts: [suppliedServingDraft], quota: { allowed: true } });
    expect(dinnerProvider.reconstruct).toHaveBeenCalledOnce();
    expect(dinnerProvider.reconstruct).toHaveBeenCalledWith({ ...payload, signal: expect.any(AbortSignal) });
    expect(limiter.consume).toHaveBeenCalledWith('user-1');
    const mutations = await repository.readAll('user-1');
    expect(mutations.map(({ entityType }) => entityType)).toEqual(['ai_consent']);
    await app.close();
  });

  it('fails closed for legacy global consent when the selected dinner provider has no explicit approval', async () => {
    const dinnerProvider = { reconstruct: vi.fn().mockResolvedValue([recipeDraft]) };
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }) };
    const { app, repository } = createTestApp({ dinnerProvider, limiter, recipeProvider: 'gemini' });
    await repository.applyMutation('user-1', {
      mutationId: 'legacy-ai-consent',
      deviceId: 'test-device',
      entityType: 'ai_consent',
      entityId: 'profile',
      operation: 'upsert',
      payload: { enabled: true, updatedAt: '2026-09-24T00:00:00.000Z' },
      clientUpdatedAt: '2026-09-24T00:00:00.000Z',
    });

    const denied = await requestDrafts(app, { dinnerText: 'Pasta con zucchine', servings: null });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ai_consent_required' });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(dinnerProvider.reconstruct).not.toHaveBeenCalled();
    await app.close();
  });

  it('denies a previously approved OpenAI provider after selection switches to Gemini', async () => {
    const dinnerProvider = { reconstruct: vi.fn().mockResolvedValue([recipeDraft]) };
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true, used: 1, remaining: 9999 }) };
    const { app, repository } = createTestApp({ dinnerProvider, limiter, recipeProvider: 'gemini' });
    const globalConsent = await repository.updateAiConsent('user-1', {
      enabled: true, homeProvider: 'openai', expectedRevision: '1970-01-01T00:00:00.000Z',
    });
    await repository.updateAiConsent('user-1', { dinnerProvider: 'openai', expectedRevision: globalConsent.updatedAt });

    const denied = await requestDrafts(app, { dinnerText: 'Pasta con zucchine', servings: null });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ai_consent_required' });
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(dinnerProvider.reconstruct).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses selected Gemini output in the consented route without persisting the draft', async () => {
    const modelRecipe = {
      title: recipeDraft.title,
      description: recipeDraft.description,
      ingredients: recipeDraft.ingredients,
      steps: recipeDraft.steps,
      servings: null,
      durationMinutes: null,
      diets: null,
      allergens: null,
      suggestedFields: recipeDraft.suggestedFields,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ recipes: [modelRecipe] }) }] } }],
    })));
    const providers = createProviders({ providers: {
      recipeProvider: 'gemini', geminiApiKey: 'synthetic-gemini-key', geminiModel: 'gemini-route-test',
    } }, { fetch });
    const { app, repository, limiter } = createTestApp({ dinnerProvider: providers.dinnerReconstruction, recipeProvider: 'gemini' });
    await enableConsent(app, 'gemini');

    const result = await requestDrafts(app, { dinnerText: 'Pasta con zucchine, poi insalata.', servings: null });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ drafts: [{ title: recipeDraft.title, allergens: null, diets: null }], quota: { allowed: true } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-route-test:generateContent');
    expect(limiter.consume).toHaveBeenCalledWith('user-1');
    expect((await repository.readAll('user-1')).map(({ entityType }) => entityType)).toEqual(['ai_consent']);
    await app.close();
  });

  it('requires a verified session, same origin, and CSRF before provider access', async () => {
    const unauthenticated = createTestApp({ authenticated: false });
    const missingSession = await requestDrafts(unauthenticated.app, { dinnerText: 'Pasta', servings: null });
    expect(missingSession.statusCode).toBe(401);
    expect(unauthenticated.dinnerProvider.reconstruct).not.toHaveBeenCalled();
    await unauthenticated.app.close();

    const { app, dinnerProvider } = createTestApp();
    await enableConsent(app);
    const foreignOrigin = await requestDrafts(app, { dinnerText: 'Pasta', servings: null }, { ...headers, origin: 'https://attacker.example' });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'csrf_failed' });
    const missingCsrf = await requestDrafts(app, { dinnerText: 'Pasta', servings: null }, { cookie: headers.cookie, origin: appOrigin });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: 'csrf_failed' });
    expect(dinnerProvider.reconstruct).not.toHaveBeenCalled();
    await app.close();
  });

  it('validates input and enforces the shared AI daily quota', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: false, used: 10001, remaining: 0 }) };
    const { app, dinnerProvider } = createTestApp({ limiter });
    await enableConsent(app);

    const invalid = await requestDrafts(app, { dinnerText: '  ', servings: null });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_payload' });
    expect(limiter.consume).not.toHaveBeenCalled();

    const exhausted = await requestDrafts(app, { dinnerText: 'Pasta', servings: null });
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ code: 'ai_daily_limit_reached' });
    expect(dinnerProvider.reconstruct).not.toHaveBeenCalled();
    await app.close();
  });

  it('releases reserved quota on provider failure and never persists the generated draft', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const limiter = {
      consume: vi.fn(),
      reserve: vi.fn().mockResolvedValue({ quota: { allowed: true, used: 1, remaining: 9999 }, release, commit }),
    };
    const dinnerProvider = { reconstruct: vi.fn().mockRejectedValue(new Error('upstream failed')) };
    const { app, repository } = createTestApp({ limiter, dinnerProvider });
    await enableConsent(app);

    const failed = await requestDrafts(app, { dinnerText: 'Pasta', servings: null });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'provider_unavailable' });
    expect(release).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect((await repository.readAll('user-1')).map(({ entityType }) => entityType)).toEqual(['ai_consent']);
    await app.close();
  });

  it('rejects unmarked provider-proposed servings when the request omitted portions', async () => {
    const unmarkedDraft = {
      ...recipeDraft,
      servings: 4,
      suggestedFields: recipeDraft.suggestedFields.filter((field) => field !== 'servings'),
    };
    const { app } = createTestApp({ dinnerProvider: { reconstruct: vi.fn().mockResolvedValue([unmarkedDraft]) } });
    await enableConsent(app);

    const failed = await requestDrafts(app, { dinnerText: 'Pasta con zucchine', servings: null });

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'provider_unavailable' });
    await app.close();
  });

  it('rejects invalid provider drafts before returning them', async () => {
    const invalidDraft = { ...recipeDraft, title: '' };
    const dinnerProvider = { reconstruct: vi.fn().mockResolvedValue([invalidDraft]) };
    const { app } = createTestApp({ dinnerProvider });
    await enableConsent(app);

    const failed = await requestDrafts(app, { dinnerText: 'Pasta', servings: null });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'provider_unavailable' });
    await app.close();
  });
});
