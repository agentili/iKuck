import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RecipeDetailModal } from './RecipeDetailModal';

const recipe = {
  id: 'test-recipe',
  title: 'Pasta semplice',
  emoji: '🍝',
  time: '20 minuti',
  servings: 2,
  tags: [],
  image: '',
  description: '',
  ingredients: [],
  steps: ['Cuoci la pasta.'],
  diets: [],
  allergens: [],
  source: 'catalog' as const,
};

const RecipeModalHarness = () => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setIsOpen(true)}>Apri ricetta</button>
      <RecipeDetailModal isOpen={isOpen} onClose={() => setIsOpen(false)} recipe={recipe} />
    </MemoryRouter>
  );
};

describe('RecipeDetailModal shared overlay', () => {
  it('uses the shared semantic overlay and restores focus after closing', async () => {
    const user = userEvent.setup();
    render(<RecipeModalHarness />);
    const opener = screen.getByRole('button', { name: 'Apri ricetta' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: /Pasta semplice/ });
    expect(dialog.querySelector('.ik-modal-backdrop')).not.toBeNull();
    expect(dialog.querySelector('.ik-modal-surface')).not.toBeNull();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    expect(within(dialog).getByRole('button', { name: 'Chiudi' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Chiudi' }));

    expect(screen.queryByRole('dialog', { name: /Pasta semplice/ })).not.toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: '' });
    expect(opener).toHaveFocus();
  });
});
