import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAuthStore } from './auth/authStore';
import { useActivityStore } from './store/activityStore';
import { useShoppingListStore } from './store/shoppingListStore';
import { usePantryStore } from './store/localPantryStore';

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
    useActivityStore.setState({ hasHydrated: true, events: [], preferences: [] });
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
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

  it('restores the session once when the application mounts', () => {
    const restoreSession = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ restoreSession });

    render(<App />);

    expect(restoreSession).toHaveBeenCalledOnce();
  });

  it('hydrates pantry data before an authenticated profile uses it', async () => {
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    usePantryStore.setState({ hasHydrated: false, pantryItems: [] });
    window.history.pushState({}, '', '/profile');

    render(<App />);

    await waitFor(() => expect(usePantryStore.getState().hasHydrated).toBe(true));
    window.history.pushState({}, '', '/');
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

  it('opens the pantry as a dedicated primary section', async () => {
    usePantryStore.setState({ hasHydrated: true, pantryItems: [], pantryLots: [] });
    window.history.pushState({}, '', '/pantry');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'La tua dispensa' })).toBeVisible();
    expect(screen.getByLabelText('Ingredienti presenti')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('link', { name: 'Dispensa' })).toHaveAttribute('aria-current', 'page');

    window.history.pushState({}, '', '/');
  });

  it('keeps Home focused on recipes and sends pantry editing to its section', async () => {
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [],
    });
    window.history.pushState({}, '', '/');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Cosa cuciniamo oggi?' })).toBeVisible();
    expect(screen.queryByLabelText('Ingredienti presenti')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gestisci la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
  });

  it.each([
    ['/', 'Cosa cuciniamo oggi?'],
    ['/pantry', 'La tua dispensa'],
    ['/recipes/pasta-tonno-pomodoro', 'Pasta tonno e pomodoro'],
    ['/profile', 'Accedi al tuo profilo'],
    ['/shopping-list', 'Lista della spesa'],
    ['/activity', 'La tua attività'],
    ['/verify-email', 'Link non valido'],
    ['/reset-password', 'Reimposta la password'],
  ])('maps %s to its page without changing the route', async (path, heading) => {
    window.history.pushState({}, '', path);

    render(<App />);

    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
    expect(window.location.pathname).toBe(path);
  });

  it('renders the authorized profile route with the restored verified session', async () => {
    const verifiedUser = {
      id: 'user-1',
      email: 'ale@example.com',
      emailVerifiedAt: '2026-09-12T10:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }),
    ));
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    window.history.pushState({}, '', '/profile');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
    expect(syncVerifiedSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', csrfToken: 'csrf-1' }),
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });
});
