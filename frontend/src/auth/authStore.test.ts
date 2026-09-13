import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '@ikuck/shared/contracts';
import { ApiClientError, type ApiRequest } from '../api/apiClient';
import { createAuthStore } from './authStore';

const verifiedUser: AccountSummary = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

const verifiedSession = {
  authenticated: true,
  user: verifiedUser,
  csrfToken: 'csrf-1',
  expiresAt: '2026-10-12T10:00:00.000Z',
};

describe('auth store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts unauthenticated without persisted session metadata', () => {
    const store = createAuthStore(vi.fn() as ApiRequest);

    expect(store.getState()).toMatchObject({
      user: null,
      csrfToken: null,
      expiresAt: null,
      connection: 'unknown',
    });
    expect(window.localStorage).toHaveLength(0);
  });

  it('restores a verified session in memory', async () => {
    const request = vi.fn().mockResolvedValue(verifiedSession) as ApiRequest;
    const store = createAuthStore(request);

    await store.getState().restoreSession();

    expect(request).toHaveBeenCalledWith('/v1/auth/session');
    expect(store.getState()).toMatchObject({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: verifiedSession.expiresAt,
      connection: 'online',
    });
  });

  it('keeps guest state when session restore is offline', async () => {
    const request = vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'Network unavailable')) as ApiRequest;
    const store = createAuthStore(request);

    await store.getState().restoreSession();

    expect(store.getState()).toMatchObject({
      user: null,
      csrfToken: null,
      connection: 'offline',
    });
  });

  it('logs in only with a verified account response', async () => {
    const request = vi.fn().mockResolvedValue(verifiedSession) as ApiRequest;
    const store = createAuthStore(request);

    await store.getState().login(' ale@example.com ', 'a long enough password');

    expect(request).toHaveBeenCalledWith('/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: { email: ' ale@example.com ', password: 'a long enough password' },
    }));
    expect(store.getState().user).toEqual(verifiedUser);
    expect(window.localStorage.getItem('ikuck-session')).toBeNull();
  });

  it('does not authenticate an unverified response', async () => {
    const request = vi.fn().mockResolvedValue({
      ...verifiedSession,
      user: { ...verifiedUser, emailVerifiedAt: '' },
    }) as ApiRequest;
    const store = createAuthStore(request);

    await expect(store.getState().login('ale@example.com', 'a long enough password'))
      .rejects.toMatchObject({ code: 'email_not_verified' });
    expect(store.getState().user).toBeNull();
  });

  it('logs in with a Google credential and stores only the application session metadata', async () => {
    const request = vi.fn().mockResolvedValue(verifiedSession) as ApiRequest;
    const store = createAuthStore(request);

    await store.getState().loginWithGoogle('google-id-token');

    expect(request).toHaveBeenCalledWith('/v1/auth/google', expect.objectContaining({
      method: 'POST',
      body: { credential: 'google-id-token' },
    }));
    expect(store.getState().user).toEqual(verifiedUser);
    expect(window.localStorage.getItem('google-id-token')).toBeNull();
  });

  it('clears in-memory session state on logout', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(verifiedSession)
      .mockResolvedValueOnce(undefined) as ApiRequest;
    const store = createAuthStore(request);

    await store.getState().login('ale@example.com', 'a long enough password');
    await store.getState().logout();

    expect(store.getState()).toMatchObject({ user: null, csrfToken: null, expiresAt: null });
    expect(request).toHaveBeenLastCalledWith('/v1/auth/logout', expect.objectContaining({
      method: 'POST',
      csrfToken: 'csrf-1',
    }));
  });
});
