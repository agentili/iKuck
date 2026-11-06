import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { AuthService } from '../auth/service.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { createMemorySyncRepository, DEFAULT_AI_CONSENT_REVISION } from '../sync/repository.js';
import { ProviderTimeoutError } from '../providers/types.js';

const appOrigin = 'http://127.0.0.1:5173';

describe('chef chat endpoint', () => {
  it('dispatches a consented request after reserving and committing quota', async () => {
    const repository = createMemorySyncRepository();
    await repository.updateAiConsent('user-1', { enabled: true, chatProvider: 'openai', chatPolicyVersion: 'chef-chat-v1', expectedRevision: DEFAULT_AI_CONSENT_REVISION });
    const authService = { authenticate: async () => ({ id: 'session', userId: 'user-1', emailVerifiedAt: new Date(), csrfTokenHash: hashOpaqueToken('csrf-token') }) } as unknown as AuthService;
    const startChat = vi.fn(() => ({ response: Promise.resolve('Risposta'), settled: Promise.resolve() }));
    const quota = { reserve: vi.fn().mockResolvedValue({ kind: 'allowed', operationId: 'op', token: 'secret' }), dispatch: vi.fn().mockResolvedValue(true), cancel: vi.fn().mockResolvedValue(true) };
    const store = { settle: vi.fn().mockResolvedValue(true) };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, auth: { service: authService, appOrigin, secureCookies: false }, chefChat: { authService, appOrigin, repository, recipeProvider: 'openai', provider: { startChat }, quota, store } });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin, cookie: 'ikuck_session=session-token', 'x-csrf-token': 'csrf-token' }, payload: { message: 'Ciao', history: [] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reply: 'Risposta' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(startChat).toHaveBeenCalledOnce();
      expect(quota.dispatch).toHaveBeenCalledWith('op', 'secret');
      expect(store.settle).toHaveBeenCalledWith('op', 'secret');
    } finally { await app.close(); }
  });

  it('returns timeout without releasing a dispatched operation after late transport settlement', async () => {
    const repository = createMemorySyncRepository();
    await repository.updateAiConsent('user-1', { enabled: true, chatProvider: 'openai', chatPolicyVersion: 'chef-chat-v1', expectedRevision: DEFAULT_AI_CONSENT_REVISION });
    const authService = { authenticate: async () => ({ id: 'session', userId: 'user-1', emailVerifiedAt: new Date(), csrfTokenHash: hashOpaqueToken('csrf-token') }) } as unknown as AuthService;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const provider = { startChat: vi.fn(() => ({ response: Promise.reject(new ProviderTimeoutError('chef_chat')), settled })) };
    const quota = { reserve: vi.fn().mockResolvedValue({ kind: 'allowed', operationId: 'op', token: 'secret' }), dispatch: vi.fn().mockResolvedValue(true), cancel: vi.fn().mockResolvedValue(true) };
    const store = { settle: vi.fn().mockResolvedValue(true) };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, auth: { service: authService, appOrigin, secureCookies: false }, chefChat: { authService, appOrigin, repository, recipeProvider: 'openai', provider, quota, store } });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin, cookie: 'ikuck_session=session-token', 'x-csrf-token': 'csrf-token' }, payload: { message: 'Ciao', history: [] } });
      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe('provider_timeout');
      finish();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.settle).not.toHaveBeenCalled();
      expect(quota.cancel).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('rechecks consent after a pending reservation before dispatch', async () => {
    const repository = createMemorySyncRepository();
    const consent = await repository.updateAiConsent('user-1', { enabled: true, chatProvider: 'openai', chatPolicyVersion: 'chef-chat-v1', expectedRevision: DEFAULT_AI_CONSENT_REVISION });
    const authService = { authenticate: async () => ({ id: 'session', userId: 'user-1', emailVerifiedAt: new Date(), csrfTokenHash: hashOpaqueToken('csrf-token') }) } as unknown as AuthService;
    let admit!: (value: { kind: 'allowed'; operationId: string; token: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const quota = { reserve: vi.fn(() => { entered(); return new Promise<{ kind: 'allowed'; operationId: string; token: string }>((resolve) => { admit = resolve; }); }), dispatch: vi.fn().mockResolvedValue(true), cancel: vi.fn().mockResolvedValue(true) };
    const startChat = vi.fn(() => ({ response: Promise.resolve('Risposta'), settled: Promise.resolve() }));
    const store = { settle: vi.fn().mockResolvedValue(true) };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, auth: { service: authService, appOrigin, secureCookies: false }, chefChat: { authService, appOrigin, repository, recipeProvider: 'openai', provider: { startChat }, quota, store } });
    try {
      const pending = app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin, cookie: 'ikuck_session=session-token', 'x-csrf-token': 'csrf-token' }, payload: { message: 'Ciao', history: [] } });
      const responsePromise = Promise.resolve(pending);
      await started;
      await repository.updateAiConsent('user-1', { chatProvider: null, expectedRevision: consent.updatedAt });
      admit({ kind: 'allowed', operationId: 'op', token: 'secret' });
      const response = await responsePromise;
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ai_consent_required');
      expect(quota.cancel).toHaveBeenCalledWith('user-1', 'op', 'secret');
      expect(quota.dispatch).not.toHaveBeenCalled();
      expect(startChat).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('allows consent revocation once transport starts without awaiting the provider response', async () => {
    const repository = createMemorySyncRepository();
    const consent = await repository.updateAiConsent('user-1', { enabled: true, chatProvider: 'openai', chatPolicyVersion: 'chef-chat-v1', expectedRevision: DEFAULT_AI_CONSENT_REVISION });
    const authService = { authenticate: async () => ({ id: 'session', userId: 'user-1', emailVerifiedAt: new Date(), csrfTokenHash: hashOpaqueToken('csrf-token') }) } as unknown as AuthService;
    let finish!: (text: string) => void;
    let started!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => { started = resolve; });
    const response = new Promise<string>((resolve) => { finish = resolve; });
    const provider = { startChat: () => { started(); return { response, settled: response.then(() => undefined) }; } };
    const quota = { reserve: vi.fn().mockResolvedValue({ kind: 'allowed', operationId: 'op', token: 'secret' }), dispatch: vi.fn().mockResolvedValue(true), cancel: vi.fn().mockResolvedValue(true) };
    const store = { settle: vi.fn().mockResolvedValue(true) };
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, auth: { service: authService, appOrigin, secureCookies: false }, chefChat: { authService, appOrigin, repository, recipeProvider: 'openai', provider, quota, store } });
    try {
      const pending = Promise.resolve(app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin, cookie: 'ikuck_session=session-token', 'x-csrf-token': 'csrf-token' }, payload: { message: 'Ciao', history: [] } }));
      await dispatchStarted;
      const revoked = repository.updateAiConsent('user-1', { chatProvider: null, expectedRevision: consent.updatedAt });
      const beforeResponse = await Promise.race([revoked.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))]);
      finish('Risposta');
      await pending;
      await revoked;
      expect(beforeResponse).toBe(true);
    } finally { await app.close(); }
  });

  it('sets no-store for a malformed JSON request before route parsing', async () => {
    const authService = { authenticate: async () => null } as unknown as AuthService;
    const app = createApp({ database: { ping: async () => undefined }, cache: { ping: async () => undefined }, auth: { service: authService, appOrigin, secureCookies: false } });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin, 'content-type': 'application/json' }, payload: '{' });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });

  it('rejects unauthenticated requests without caching', async () => {
    const authService = { authenticate: async () => null } as unknown as AuthService;
    const app = createApp({
      database: { ping: async () => undefined },
      cache: { ping: async () => undefined },
      auth: { service: authService, appOrigin, secureCookies: false },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/chef-chat', headers: { origin: appOrigin }, payload: { message: 'Ciao', history: [] } });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
