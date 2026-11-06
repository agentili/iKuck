import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingListItem } from '@ikuck/shared/contracts';
import ShoppingListPage from './ShoppingListPage';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useAuthStore } from '../auth/authStore';
import type { BringStatus } from '@ikuck/shared/bring';
import { isSousChef } from '../config/features';

vi.mock('../config/features', () => ({ isSousChef: vi.fn(() => false) }));

const hydrateShoppingListStoreMock = vi.hoisted(() => vi.fn());
const bringApiMocks = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  lists: vi.fn(),
  items: vi.fn(),
  write: vi.fn(),
}));

vi.mock('../bring/bringApi', () => ({
  createBringApi: () => bringApiMocks,
}));

vi.mock('../store/shoppingListStore', async () => {
  const actual = await vi.importActual<typeof import('../store/shoppingListStore')>('../store/shoppingListStore');
  return { ...actual, hydrateShoppingListStore: hydrateShoppingListStoreMock };
});

const item: ShoppingListItem = {
  id: 'shopping-pasta',
  ingredientId: 'pasta',
  label: 'Pasta',
  quantity: null,
  unit: null,
  note: null,
  purchased: false,
  sourceRecipeId: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z',
};

const connectedStatus: BringStatus = { enabled: true, connected: true, connectionId: 'connection-1' };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const setVerifiedSession = (id = 'user-1', csrfToken = 'csrf-1', emailVerifiedAt = '2026-09-12T10:00:00.000Z') => {
  useAuthStore.setState({
    user: { id, email: `${id}@example.com`, emailVerifiedAt },
    csrfToken,
  });
};

describe('ShoppingListPage', () => {
  beforeEach(() => {
    vi.mocked(isSousChef).mockReturnValue(false);
    hydrateShoppingListStoreMock.mockReset();
    hydrateShoppingListStoreMock.mockResolvedValue(undefined);
    Object.values(bringApiMocks).forEach((mock) => mock.mockReset());
    bringApiMocks.status.mockResolvedValue({ enabled: true, connected: false, connectionId: null } satisfies BringStatus);
    bringApiMocks.lists.mockResolvedValue({ connectionId: 'connection-1', lists: [] });
    bringApiMocks.items.mockResolvedValue({ connectionId: 'connection-1', listId: 'list-1', labelsAvailable: true, items: [] });
    bringApiMocks.write.mockResolvedValue({ connectionId: 'connection-1', listId: 'list-1', labelsAvailable: true, items: [] });
    bringApiMocks.connect.mockResolvedValue({ enabled: true, connected: true, connectionId: 'connection-1', lists: [] });
    bringApiMocks.disconnect.mockResolvedValue(undefined);
    useAuthStore.setState({ user: null, csrfToken: null });
    useShoppingListStore.setState({ hasHydrated: false, items: [] });
  });

  it('shows loading while shopping-list hydration is pending', () => {
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento della lista…');
    expect(hydrateShoppingListStoreMock).toHaveBeenCalledOnce();
  });

  it('uses the Sous Chef surface token and main landmark during local hydration', () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    const loading = screen.getByRole('status');
    expect(loading).toHaveTextContent('Caricamento della lista…');
    expect(loading).toHaveClass('bg-[var(--ik-surface)]');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.queryByRole('group', { name: 'Origine della lista' })).not.toBeInTheDocument();
  });

  it('shows the empty list after hydration', () => {
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Torna alle ricette' })).toHaveAttribute('href', '/');
    expect(screen.getByText('La lista è vuota')).toBeVisible();
  });

  it('keeps a single list heading and a tokenized source choice in the Sous Chef guest shell', () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Torna a Chef' })).toHaveAttribute('href', '/');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    const local = screen.getByRole('group', { name: 'Origine della lista' }).querySelector('button[aria-pressed="true"]');
    expect(local).toHaveTextContent('iKuck');
    expect(local).toHaveClass('bg-[var(--ik-sage)]');
    expect(bringApiMocks.status).not.toHaveBeenCalled();
  });

  it('renders populated items and invokes page actions', async () => {
    const user = userEvent.setup();
    const togglePurchased = vi.fn().mockReturnValue(true);
    const removeItem = vi.fn();
    useShoppingListStore.setState({ hasHydrated: true, items: [item], togglePurchased, removeItem });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Segna Pasta come acquistato' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi Pasta' }));

    expect(togglePurchased).toHaveBeenCalledWith(item.id);
    expect(removeItem).toHaveBeenCalledWith(item.id);
  });

  it('keeps a disconnected verified account on the local list', async () => {
    setVerifiedSession();
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(bringApiMocks.status).toHaveBeenCalledOnce();
  });

  it('opens Bring! when the verified account has a saved connection', async () => {
    setVerifiedSession();
    bringApiMocks.status.mockResolvedValue(connectedStatus);
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Lista della spesa' })).not.toBeInTheDocument();
    expect(bringApiMocks.lists).toHaveBeenCalledWith('connection-1', expect.any(AbortSignal));
  });

  it('shows one Sous Chef page heading and the selected Bring! origin for a verified connected account', async () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    setVerifiedSession();
    bringApiMocks.status.mockResolvedValue(connectedStatus);
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Lista Bring!', level: 2 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Spesa', level: 1 })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Bring!' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Bring!' })).toHaveClass('bg-[var(--ik-sage)]');
    expect(screen.queryByLabelText('Cosa ti serve?')).not.toBeInTheDocument();
    expect(bringApiMocks.lists).toHaveBeenCalledWith('connection-1', expect.any(AbortSignal));
  });

  it('lets a guest open the Bring! sign-in prompt and return to the unchanged local list', async () => {
    const user = userEvent.setup();
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Bring!' }));

    expect(screen.getByText(/Per collegare Bring! accedi a un account iKuck verificato\./)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Accedi o verifica il tuo account' })).toHaveAttribute('href', '/profile');
    expect(screen.queryByRole('heading', { name: 'Lista della spesa' })).not.toBeInTheDocument();
    expect(bringApiMocks.status).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'iKuck' }));
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  });

  it('requires a verified session before showing the Bring! access prompt', async () => {
    const user = userEvent.setup();
    setVerifiedSession('user-unverified', 'csrf-unverified', '');
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Bring!' }));

    expect(screen.getByText(/Per collegare Bring! accedi a un account iKuck verificato\./)).toBeVisible();
    expect(bringApiMocks.status).not.toHaveBeenCalled();
  });

  it.each(['guest', 'unverified', 'missing CSRF'] as const)('keeps the Sous Chef local fallback visible when Bring! access is denied for %s', async (session) => {
    vi.mocked(isSousChef).mockReturnValue(true);
    if (session === 'unverified') setVerifiedSession('unverified', 'csrf-1', '');
    if (session === 'missing CSRF') {
      setVerifiedSession('verified');
      useAuthStore.setState({ csrfToken: null });
    }
    const user = userEvent.setup();
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Bring!' }));
    expect(screen.getByRole('heading', { name: 'Spesa', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Lista Bring!', level: 2 })).toBeVisible();
    expect(screen.getByText(/La lista iKuck resta utilizzabile senza account e offline/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Accedi o verifica il tuo account' })).toHaveAttribute('href', '/profile');
    expect(bringApiMocks.status).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apri la lista locale offline' }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa', level: 1 })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
  });

  it('keeps a manual iKuck choice when a pending status later reports a Bring! connection', async () => {
    const user = userEvent.setup();
    const pendingStatus = deferred<BringStatus>();
    bringApiMocks.status.mockReturnValue(pendingStatus.promise);
    setVerifiedSession();
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByText('Verifico quale lista aprire…')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Lista della spesa' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'iKuck' }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();

    await act(async () => pendingStatus.resolve(connectedStatus));

    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Lista Bring!' })).not.toBeInTheDocument();
  });

  it('keeps Sous Chef feedback visible after a manual local choice and ignores a late Bring! answer', async () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    const user = userEvent.setup();
    const pendingStatus = deferred<BringStatus>();
    bringApiMocks.status.mockReturnValue(pendingStatus.promise);
    setVerifiedSession();
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Spesa', level: 1 })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Verifico quale lista aprire…');
    await user.click(screen.getByRole('button', { name: 'iKuck' }));
    expect(screen.getByRole('status')).toHaveTextContent('Lista iKuck selezionata');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await act(async () => pendingStatus.resolve(connectedStatus));
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'iKuck' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('heading', { name: 'Lista Bring!' })).not.toBeInTheDocument();
  });

  it('hides local writes after a status error until the user explicitly selects iKuck', async () => {
    const user = userEvent.setup();
    setVerifiedSession();
    bringApiMocks.status.mockRejectedValue(new Error('synthetic network failure'));
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Non posso verificare il collegamento Bring!');
    expect(screen.queryByRole('heading', { name: 'Lista della spesa' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cosa ti serve?')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'iKuck' }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
  });

  it('offers an explicit offline fallback after a Sous Chef provider error without showing local writes first', async () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    const user = userEvent.setup();
    setVerifiedSession();
    bringApiMocks.status.mockRejectedValue(new Error('synthetic network failure'));
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Non posso verificare il collegamento Bring!');
    expect(error).toHaveClass('bg-[var(--ik-tomato-soft)]');
    expect(screen.getByRole('button', { name: 'iKuck' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Bring!' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByLabelText('Cosa ti serve?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apri la lista locale offline' }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Origine selezionata' })).toHaveTextContent('Lista iKuck selezionata');
  });

  it('aborts the previous Bring! panel and hides it during an account switch', async () => {
    const firstPageStatus = deferred<BringStatus>();
    const previousPanelStatus = deferred<BringStatus>();
    const nextPageStatus = deferred<BringStatus>();
    bringApiMocks.status
      .mockImplementationOnce(() => firstPageStatus.promise)
      .mockImplementationOnce(() => previousPanelStatus.promise)
      .mockImplementation(() => nextPageStatus.promise);
    setVerifiedSession('user-1', 'csrf-1');
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    await act(async () => firstPageStatus.resolve(connectedStatus));
    expect(await screen.findByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
    expect(bringApiMocks.status).toHaveBeenCalledTimes(2);
    const previousPanelSignal = bringApiMocks.status.mock.calls[1]?.[0] as AbortSignal;

    await act(async () => setVerifiedSession('user-2', 'csrf-2'));

    expect(bringApiMocks.status.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(previousPanelSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lista Bring!' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Verifico quale lista aprire…')).toBeVisible());

    await act(async () => nextPageStatus.resolve({ enabled: true, connected: false, connectionId: null }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
  });

  it('does not expose the old Sous Chef Bring! panel while checking the replacement session', async () => {
    vi.mocked(isSousChef).mockReturnValue(true);
    const firstPageStatus = deferred<BringStatus>();
    const previousPanelStatus = deferred<BringStatus>();
    const nextPageStatus = deferred<BringStatus>();
    bringApiMocks.status
      .mockImplementationOnce(() => firstPageStatus.promise)
      .mockImplementationOnce(() => previousPanelStatus.promise)
      .mockImplementation(() => nextPageStatus.promise);
    setVerifiedSession('user-1', 'csrf-1');
    useShoppingListStore.setState({ hasHydrated: true, items: [item] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    await act(async () => firstPageStatus.resolve(connectedStatus));
    expect(await screen.findByRole('heading', { name: 'Lista Bring!' })).toBeVisible();
    const previousPanelSignal = bringApiMocks.status.mock.calls[1]?.[0] as AbortSignal;
    await act(async () => setVerifiedSession('user-2', 'csrf-2'));
    expect(previousPanelSignal.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Lista Bring!' })).not.toBeInTheDocument();
    expect(screen.getByText('Verifico quale lista aprire…')).toBeVisible();
    await act(async () => nextPageStatus.resolve({ enabled: true, connected: false, connectionId: null }));
    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByText('Pasta', { exact: true })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('keeps the safe empty list when hydration reports no usable data', async () => {
    hydrateShoppingListStoreMock.mockImplementation(async () => {
      await act(async () => {
        useShoppingListStore.setState({ hasHydrated: true, items: [] });
      });
    });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(await screen.findByText('La lista è vuota')).toBeVisible();
    expect(hydrateShoppingListStoreMock).toHaveBeenCalledOnce();
  });
});
