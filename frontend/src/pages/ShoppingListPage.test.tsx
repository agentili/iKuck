import { MemoryRouter } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingListItem } from '@ikuck/shared/contracts';
import ShoppingListPage from './ShoppingListPage';
import { useShoppingListStore } from '../store/shoppingListStore';

const hydrateShoppingListStoreMock = vi.hoisted(() => vi.fn());

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

describe('ShoppingListPage', () => {
  beforeEach(() => {
    hydrateShoppingListStoreMock.mockReset();
    hydrateShoppingListStoreMock.mockResolvedValue(undefined);
    useShoppingListStore.setState({ hasHydrated: false, items: [] });
  });

  it('shows loading while shopping-list hydration is pending', () => {
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento della lista…');
    expect(hydrateShoppingListStoreMock).toHaveBeenCalledOnce();
  });

  it('shows the empty list after hydration', () => {
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    render(<MemoryRouter><ShoppingListPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Lista della spesa' })).toBeVisible();
    expect(screen.getByText('La lista è vuota')).toBeVisible();
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
