import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { IngredientDefinition } from '../../domain/types';
import IngredientSuggestions from './IngredientSuggestions';

const ingredients: IngredientDefinition[] = [
  { id: 'onion', label: 'Cipolla', aliases: ['cipolla'], category: 'vegetable', easyToFind: true, staple: false },
  { id: 'basil', label: 'Basilico', aliases: ['basilico'], category: 'vegetable', easyToFind: true, staple: false },
];

describe('IngredientSuggestions', () => {
  it('offers an action to refresh all pantry suggestions', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(<IngredientSuggestions ingredients={ingredients} onAdd={vi.fn()} onDismiss={vi.fn()} onRefresh={onRefresh} />);

    await user.click(screen.getByRole('button', { name: 'Cambia tutti i suggerimenti' }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('lets the user replace one suggestion without adding it to the pantry', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onDismiss = vi.fn();

    render(<IngredientSuggestions ingredients={ingredients} onAdd={onAdd} onDismiss={onDismiss} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Sostituisci Cipolla' }));

    expect(onDismiss).toHaveBeenCalledWith('onion');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('keeps the refresh action available after all suggestions are dismissed', () => {
    render(
      <IngredientSuggestions
        ingredients={[]}
        showEmptyState
        onAdd={vi.fn()}
        onDismiss={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('Non ci sono altri suggerimenti da mostrare.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambia tutti i suggerimenti' })).toBeInTheDocument();
  });
});