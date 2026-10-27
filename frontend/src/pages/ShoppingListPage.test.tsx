import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ShoppingListPage from './ShoppingListPage';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useAuthStore } from '../auth/authStore';
import { setActiveDataScope } from '../sync/scopeContext';
const status = vi.hoisted(() => vi.fn());
vi.mock('../bring/bringApi', () => ({ createBringApi: () => ({ status }) }));
vi.mock('../store/shoppingListStore', async () => ({ ...await vi.importActual<typeof import('../store/shoppingListStore')>('../store/shoppingListStore'), hydrateShoppingListStore: vi.fn() }));
beforeEach(() => {
  status.mockReset().mockResolvedValue({ enabled: true, connected: false, connectionId: null });
  setActiveDataScope('guest');
  useAuthStore.setState({ user: null, csrfToken: null });
  useShoppingListStore.setState({ hasHydrated: true, items: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('opens the local shopping list without querying an optional provider', () => {
  render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: /Lista della spesa/i })).toBeInTheDocument();
  expect(status).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Bring!' })).not.toBeInTheDocument();
});
it('keeps a populated local list and its actions available offline', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  useShoppingListStore.setState({ items: [{ id: 'milk', ingredientId: 'milk', label: 'Latte', quantity: 1, unit: 'l', note: null, purchased: false, sourceRecipeId: null, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' }] });
  render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);
  expect(screen.getByText('Latte')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Modifica Latte' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Rimuovi Latte' })).toBeEnabled();
  await user.type(screen.getByLabelText('Cosa ti serve?'), 'Pane');
  await user.click(screen.getByRole('button', { name: 'Aggiungi alla lista' }));
  expect(screen.getByText('Pane')).toBeVisible();
  expect(status).not.toHaveBeenCalled();
});

it('queries Bring only after the verified user opens its section and closes it on a session change', async () => {
  const user = userEvent.setup();
  useAuthStore.setState({ user: { id: 'a', email: 'a@example.com', emailVerifiedAt: '2026-10-26' }, csrfToken: 'csrf-a' });
  render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);
  expect(status).not.toHaveBeenCalled();
  await user.click(screen.getByText('Bring!', { selector: 'summary' }));
  expect(await screen.findByLabelText('Email Bring!')).toBeVisible();
  expect(status).toHaveBeenCalledOnce();
  act(() => useAuthStore.setState({ user: { id: 'b', email: 'b@example.com', emailVerifiedAt: '2026-10-26' }, csrfToken: 'csrf-b' }));
  expect(screen.queryByLabelText('Email Bring!')).not.toBeInTheDocument();
  expect(screen.getByText('Bring!', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
  expect(status).toHaveBeenCalledOnce();
});

it('opens the guest Bring explanation without contacting the provider', async () => {
  render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);
  await userEvent.click(screen.getByText('Bring!', { selector: 'summary' }));
  expect(await screen.findByRole('link', { name: 'Accedi o verifica il tuo account' })).toHaveAttribute('href', '/profile');
  expect(status).not.toHaveBeenCalled();
});
it('reports loading until local data is hydrated', () => {
  useShoppingListStore.setState({ hasHydrated: false });
  render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);
  expect(screen.getByRole('status')).toHaveTextContent('Caricamento della lista');
});
