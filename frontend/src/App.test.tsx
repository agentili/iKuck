import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useAuthStore } from './auth/authStore';
import { useActivityStore } from './store/activityStore';
import { useShoppingListStore } from './store/shoppingListStore';
import { usePantryStore } from './store/localPantryStore';
import { useHouseStore } from './house/houseStore';
import { usePantryMergeNoticeStore } from './store/pantryMergeNoticeStore';
import { getActiveDataScope, setActiveDataScope, setPersonalDataScope } from './sync/scopeContext';
import { clearDataScope } from './sync/syncQueue';
import { isScopeWritable, trackScopedWrite } from './sync/scopeWriteFence';
import { writeDinnerEntries } from './storage/dinnerDiaryStorage';

const syncVerifiedSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const listenForReconnect = vi.hoisted(() => vi.fn().mockReturnValue(vi.fn()));
const initializeSessionScope = vi.hoisted(() => vi.fn());

vi.mock('./sync/syncQueue', async () => {
  const actual = await vi.importActual<typeof import('./sync/syncQueue')>('./sync/syncQueue');
  return { ...actual, initializeSessionScope, syncVerifiedSession, listenForReconnect };
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
    initializeSessionScope.mockReset();
    initializeSessionScope.mockImplementation(async (session: { userId: string }) => {
      const scope = `account:${session.userId}` as const;
      setActiveDataScope(scope);
      setPersonalDataScope(scope);
      return { state: null, mergeSummary: null, guestMergeFailed: false };
    });
    useHouseStore.getState().clear();
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
    usePantryMergeNoticeStore.getState().clear();
    useAuthStore.setState({
      user: null,
      csrfToken: null,
      expiresAt: null,
      connection: 'unknown',
      isLoading: false,
      restoreSession: vi.fn().mockResolvedValue(undefined),
    });
    useActivityStore.setState({ hasHydrated: true, events: [], preferences: [] });
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
  });

  it('hides a revoked House diary immediately while purge waits for a local write', async () => {
    const houseScope = 'house:revoked-on-screen' as const;
    const state = {
      house: { id: 'revoked-on-screen', name: 'Casa', createdAt: '2026-09-30T10:00:00.000Z' },
      membership: { role: 'member' as const, joinedAt: '2026-09-30T10:00:00.000Z' }, members: [],
    };
    await writeDinnerEntries([{
      id: 'revoked-entry', date: '2026-09-30', text: 'Cena visibile prima della revoca',
      servings: null, note: null, recipes: [], authorId: verifiedUser.id,
      createdAt: state.house.createdAt, updatedAt: state.house.createdAt,
    }], houseScope);
    setActiveDataScope(houseScope);
    setPersonalDataScope(`account:${verifiedUser.id}`);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    initializeSessionScope.mockImplementation(async () => {
      setActiveDataScope(houseScope);
      setPersonalDataScope(`account:${verifiedUser.id}`);
      return { state, mergeSummary: null, guestMergeFailed: false };
    });
    window.history.pushState({}, '', '/dinner-diary');
    const { unmount } = render(<App />);
    await screen.findByText('Cena visibile prima della revoca');
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pending = trackScopedWrite(houseScope, () => held);
    let complete = false;
    const purging = clearDataScope(houseScope).then(() => { complete = true; });
    try {
      await waitFor(() => expect(screen.queryByText('Cena visibile prima della revoca')).not.toBeInTheDocument());
      expect(screen.getByRole('status')).toHaveTextContent('Caricamento');
      expect(complete).toBe(false);
    } finally {
      release?.();
      await Promise.all([pending, purging]);
      act(() => unmount());
      window.history.pushState({}, '', '/');
    }
  });

  it('hides the previous account’s routes during a new account’s unresolved House bootstrap', async () => {
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    const { rerender } = render(<App />);
    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledOnce());
    let releaseBootstrap: (() => void) | undefined;
    const bootstrap = new Promise<null>((resolve) => { releaseBootstrap = () => resolve(null); });
    initializeSessionScope.mockReturnValueOnce(bootstrap);
    setActiveDataScope('account:user-1');
    setPersonalDataScope('account:user-1');
    usePantryStore.setState({ hasHydrated: true, pantryItems: [{ id: 'secret-pasta', label: 'Pasta privata', known: true }] });
    window.history.pushState({}, '', '/pantry');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'La tua dispensa' });
    expect(screen.getByText('Pasta privata')).toBeVisible();

    useAuthStore.setState({ user: { ...verifiedUser, id: 'user-2', email: 'other@example.com' }, csrfToken: 'csrf-2' });
    rerender(<App />);
    expect(screen.queryByRole('heading', { name: 'La tua dispensa' })).not.toBeInTheDocument();
    expect(screen.queryByText('Pasta privata')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Caricamento');
    releaseBootstrap?.();
    window.history.pushState({}, '', '/');
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

  it('keeps verified navigation available and retries a transient House lookup without exposing scoped data', async () => {
    const actual = await vi.importActual<typeof import('./sync/syncQueue')>('./sync/syncQueue');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'temporary_unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const houseScope = 'house:offline-home' as const;
    setActiveDataScope(houseScope);
    setPersonalDataScope('account:user-1');
    usePantryStore.setState({ hasHydrated: true, pantryItems: [{ id: 'secret-pasta', label: 'Dispensa privata House', known: true }] });
    initializeSessionScope.mockImplementation((...args: Parameters<typeof actual.initializeSessionScope>) => actual.initializeSessionScope(...args));
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    const { unmount } = render(<App />);

    try {
      await waitFor(() => expect(initializeSessionScope).toHaveBeenCalled());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/verificare l’ambito della Casa/i);
      expect(screen.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Riprova' })).toBeVisible();
      expect(screen.queryByText('Dispensa privata House')).not.toBeInTheDocument();
      expect(getActiveDataScope()).toBe(houseScope);
      expect(isScopeWritable(houseScope)).toBe(false);
      await expect(trackScopedWrite(houseScope, async () => undefined)).rejects.toMatchObject({ code: 'scope_unverified' });
      expect(syncVerifiedSession).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/v1/house', expect.objectContaining({ method: 'GET' }));

      screen.getByRole('button', { name: 'Riprova' }).click();
      expect(await screen.findByRole('heading', { name: 'Cucina viva' })).toBeVisible();
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/v1/house', expect.objectContaining({ method: 'GET' }));
      expect(getActiveDataScope()).toBe('account:user-1');
      await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledOnce());
    } finally {
      unmount();
      vi.unstubAllGlobals();
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps verified navigation but does not hydrate or sync an unresolved House scope', async () => {
    setActiveDataScope('house:unresolved-membership-test');
    setPersonalDataScope('account:user-1');
    initializeSessionScope.mockRejectedValue(new Error('House lookup offline'));
    usePantryStore.setState({ hasHydrated: false, pantryItems: [{ id: 'secret-house-item', label: 'Dispensa Casa riservata', known: true }] });
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    render(<App />);

    await waitFor(() => expect(initializeSessionScope).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent(/ambito della Casa/i);
    expect(screen.getByRole('navigation', { name: 'Navigazione principale' })).toBeVisible();
    expect(screen.getAllByText('Ambito da verificare')).not.toHaveLength(0);
    expect(screen.queryByText('Dispensa Casa riservata')).not.toBeInTheDocument();
    expect(usePantryStore.getState().hasHydrated).toBe(false);
    expect(getActiveDataScope()).toBe('house:unresolved-membership-test');
    expect(syncVerifiedSession).not.toHaveBeenCalled();
    expect(listenForReconnect).not.toHaveBeenCalled();
  });

  it('shows the non-destructive warning after a guest pantry merge fails', async () => {
    initializeSessionScope.mockImplementation(async () => {
      setActiveDataScope('house:house-a');
      return {
        state: {
          house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
          membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' },
          members: [],
        },
        mergeSummary: null,
        guestMergeFailed: true,
      };
    });
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    render(<App />);

    const warning = await screen.findByText('La dispensa della Casa resta selezionata.');
    expect(warning).toBeVisible();
    expect(warning.closest('[role="alert"]')).toHaveTextContent('La copia locale è stata conservata su questo dispositivo');
    await waitFor(() => expect(useHouseStore.getState().state?.house?.id).toBe('house-a'));
    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledOnce());
  });

  it('keeps a successful merge summary visible after the house bootstrap refreshes', async () => {
    const houseState = {
      house: { id: 'house-a', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
      membership: { role: 'member' as const, joinedAt: '2026-09-24T00:00:00.000Z' },
      members: [],
    };
    initializeSessionScope.mockImplementationOnce(async () => {
      setActiveDataScope('house:house-a');
      return {
        state: houseState,
        mergeSummary: { addedLots: 2, mergedLots: 0, importedStaples: 0 },
        guestMergeFailed: false,
      };
    }).mockImplementation(async () => {
      setActiveDataScope('house:house-a');
      return {
        state: houseState,
        mergeSummary: { addedLots: 0, mergedLots: 0, importedStaples: 0 },
        guestMergeFailed: false,
      };
    });
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    render(<App />);

    const importedLots = await screen.findByText('2 elementi aggiunti');
    await waitFor(() => expect(initializeSessionScope).toHaveBeenCalledTimes(2));
    expect(importedLots).toBeVisible();
  });

  it('clears a prior merge failure notice when a later bootstrap finds no house', async () => {
    usePantryMergeNoticeStore.getState().showFailure();
    initializeSessionScope.mockImplementation(async () => {
      setActiveDataScope('account:user-1');
      setPersonalDataScope('account:user-1');
      return { state: null, mergeSummary: null, guestMergeFailed: false };
    });
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });

    render(<App />);
    await waitFor(() => expect(initializeSessionScope).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('La dispensa della Casa resta selezionata.')).not.toBeInTheDocument());
  });

  it('does not replace a stored house with guest while restoring a verified session', async () => {
    setActiveDataScope('house:restored-home');
    setPersonalDataScope('account:user-1');
    initializeSessionScope.mockImplementation(async () => ({
      state: {
        house: { id: 'restored-home', name: 'Casa', createdAt: '2026-09-24T00:00:00.000Z' },
        membership: { role: 'member', joinedAt: '2026-09-24T00:00:00.000Z' }, members: [],
      },
      mergeSummary: null,
      guestMergeFailed: false,
    }));
    let finishRestore: (() => void) | undefined;
    const restoration = new Promise<void>((resolve) => { finishRestore = resolve; });
    useAuthStore.setState({
      user: null,
      csrfToken: null,
      restoreSession: vi.fn(async () => {
        await restoration;
        useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
      }),
    });

    render(<App />);

    expect(getActiveDataScope()).toBe('house:restored-home');
    finishRestore?.();
    await waitFor(() => expect(initializeSessionScope).toHaveBeenCalled());
    expect(getActiveDataScope()).toBe('house:restored-home');
    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalled());
  });

  it('restores the session once when the application mounts', async () => {
    const restoreSession = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ restoreSession });

    render(<App />);

    expect(restoreSession).toHaveBeenCalledOnce();
    await screen.findByRole('heading', { name: 'Cucina viva' });
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

  it('renders an explicit 404 without replacing the requested URL', async () => {
    window.history.pushState({}, '', '/missing-page');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Pagina non trovata' })).toBeVisible();
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

  it('keeps Home focused on cooking and sends pantry editing to its section', async () => {
    usePantryStore.setState({
      hasHydrated: true,
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [],
    });
    window.history.pushState({}, '', '/');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Cucina viva' })).toBeVisible();
    expect(screen.queryByLabelText('Ingredienti presenti')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apri tutta la dispensa' })).toHaveAttribute('href', '/pantry');
    expect(screen.getByRole('button', { name: 'Trova ricette' })).toBeEnabled();
  });

  it.each([
    ['/', 'Cucina viva'],
    ['/pantry', 'La tua dispensa'],
    ['/recipes/pasta-tonno-pomodoro', 'Pasta tonno e pomodoro'],
    ['/profile', 'Accedi al tuo profilo'],
    ['/shopping-list', 'Lista della spesa'],
    ['/activity', 'La tua attività'],
    ['/house', 'La mia casa'],
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
    await waitFor(() => expect(syncVerifiedSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', csrfToken: 'csrf-1' }),
      expect.anything(),
    ));
    vi.unstubAllGlobals();
  });
});
