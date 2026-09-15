import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAuthStore } from './auth/authStore';

const syncVerifiedSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const listenForReconnect = vi.hoisted(() => vi.fn().mockReturnValue(vi.fn()));

vi.mock('./sync/syncQueue', async () => {
  const actual = await vi.importActual<typeof import('./sync/syncQueue')>('./sync/syncQueue');
  return { ...actual, syncVerifiedSession, listenForReconnect };
});

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

describe('App synchronization lifecycle', () => {
  beforeEach(() => {
    syncVerifiedSession.mockClear();
    listenForReconnect.mockClear();
    useAuthStore.setState({
      user: null,
      csrfToken: null,
      expiresAt: null,
      connection: 'unknown',
      isLoading: false,
      restoreSession: vi.fn(),
    });
  });

  it('starts one initial sync and one reconnect listener for a verified session', async () => {
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    render(<App />);

    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledOnce());
    expect(syncVerifiedSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', csrfToken: 'csrf-1' }),
      expect.objectContaining({ isSessionCurrent: expect.any(Function) }),
    );
    expect(listenForReconnect).toHaveBeenCalledOnce();
  });

  it('does not start sync or a reconnect listener for guests and unverified sessions', async () => {
    const { unmount } = render(<App />);
    await waitFor(() => expect(syncVerifiedSession).not.toHaveBeenCalled());
    expect(listenForReconnect).not.toHaveBeenCalled();
    unmount();

    useAuthStore.setState({ user: { ...verifiedUser, emailVerifiedAt: '' }, csrfToken: 'csrf-1' });
    render(<App />);
    await waitFor(() => expect(syncVerifiedSession).not.toHaveBeenCalled());
    expect(listenForReconnect).not.toHaveBeenCalled();
  });

  it('removes the reconnect listener when the verified session leaves the app', async () => {
    const removeListener = vi.fn();
    listenForReconnect.mockReturnValue(removeListener);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    const { unmount } = render(<App />);
    await waitFor(() => expect(listenForReconnect).toHaveBeenCalledOnce());

    unmount();

    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('renders an explicit 404 without replacing the requested URL', () => {
    window.history.pushState({}, '', '/missing-page');

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Pagina non trovata' })).toBeVisible();
    expect(window.location.pathname).toBe('/missing-page');

    window.history.pushState({}, '', '/');
  });
});
