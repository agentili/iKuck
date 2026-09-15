import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import ShoppingListPanel from './ShoppingListPanel';

const item = (overrides: Partial<ShoppingListItem> = {}): ShoppingListItem => ({
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
  ...overrides,
});

const renderPanel = (items: ShoppingListItem[] = [], overrides: Partial<{
  onAdd: (input: ShoppingListItemPayload) => string | null;
  onTogglePurchased: (id: string) => boolean;
  onRemove: (id: string) => void;
  onRestoreItem: (item: ShoppingListItem) => boolean;
  onUpdate: (id: string, patch: { label?: string; quantity?: number | null; unit?: ShoppingListItem['unit']; note?: string | null }) => boolean;
  onClearPurchased: () => number;
}> = {}) => render(
  <ShoppingListPanel
    items={items}
    onAdd={overrides.onAdd ?? vi.fn().mockReturnValue('shopping-new')}
    onTogglePurchased={overrides.onTogglePurchased ?? vi.fn().mockReturnValue(true)}
    onRemove={overrides.onRemove ?? vi.fn()}
    onRestoreItem={overrides.onRestoreItem ?? vi.fn().mockReturnValue(true)}
    onUpdate={overrides.onUpdate ?? vi.fn().mockReturnValue(true)}
    onClearPurchased={overrides.onClearPurchased ?? vi.fn().mockReturnValue(1)}
  />,
);

describe('ShoppingListPanel', () => {
  it('adds a manual item with optional quantity and unit', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockReturnValue('shopping-new');
    renderPanel([], { onAdd });

    await user.type(screen.getByLabelText('Cosa ti serve?'), 'Pasta');
    await user.click(screen.getByText('Aggiungi dettagli (facoltativi)'));
    await user.type(screen.getByLabelText('Quantità da acquistare'), '500');
    await user.selectOptions(screen.getByLabelText('Unità di misura della spesa'), 'g');
    await user.click(screen.getByRole('button', { name: 'Aggiungi alla lista' }));

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      ingredientId: 'pasta',
      label: 'Pasta',
      quantity: 500,
      unit: 'g',
      purchased: false,
      sourceRecipeId: null,
    }));
  });

  it('shows validation feedback when quantity has no unit', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderPanel([], { onAdd });

    await user.type(screen.getByLabelText('Cosa ti serve?'), 'Pasta');
    await user.click(screen.getByText('Aggiungi dettagli (facoltativi)'));
    await user.type(screen.getByLabelText('Quantità da acquistare'), '500');
    await user.click(screen.getByRole('button', { name: 'Aggiungi alla lista' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Se indichi una quantità, scegli anche l’unità.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('toggles purchased state, removes an item and clears purchased entries', async () => {
    const user = userEvent.setup();
    const onTogglePurchased = vi.fn().mockReturnValue(true);
    const onRemove = vi.fn();
    const onClearPurchased = vi.fn().mockReturnValue(1);
    renderPanel([item({ purchased: true }), item({ id: 'shopping-tomato', label: 'Pomodori' })], { onTogglePurchased, onRemove, onClearPurchased });

    await user.click(screen.getByRole('button', { name: 'Segna Pasta come da acquistare' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi Pomodori' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi gli acquistati' }));

    expect(onTogglePurchased).toHaveBeenCalledWith('shopping-pasta');
    expect(onRemove).toHaveBeenCalledWith('shopping-tomato');
    expect(onClearPurchased).toHaveBeenCalledOnce();
  });

  it('explains an empty list and shows recipe source metadata', () => {
    const { rerender } = renderPanel();
    expect(screen.getByText('La lista è vuota')).toBeVisible();

    rerender(
      <ShoppingListPanel
        items={[item({ sourceRecipeId: 'pasta-tonno-pomodoro', note: 'q.b.' })]}
        onAdd={vi.fn().mockReturnValue('new')}
        onTogglePurchased={vi.fn().mockReturnValue(true)}
        onRemove={vi.fn()}
        onUpdate={vi.fn().mockReturnValue(true)}
        onClearPurchased={vi.fn().mockReturnValue(0)}
      />,
    );
    expect(screen.getByText(/Dalla ricetta: Pasta tonno e pomodoro/)).toBeVisible();
    expect(screen.getByText(/Nota: q\.b\./)).toBeVisible();
  });

  it('restores a removed item from the undo toast', async () => {
    const user = userEvent.setup();
    const onRestoreItem = vi.fn().mockReturnValue(true);
    renderPanel([item()], { onRestoreItem });

    await user.click(screen.getByRole('button', { name: 'Rimuovi Pasta' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onRestoreItem).toHaveBeenCalledWith(item());
  });
});
