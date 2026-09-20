import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IngredientInput from './IngredientInput';

describe('IngredientInput', () => {
  it('exposes suggestions as a keyboard-accessible combobox', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();

    render(<IngredientInput onAdd={onAdd} />);
    const input = screen.getByRole('combobox', { name: 'Ingredienti presenti' });

    await user.type(input, 'pom');

    const listbox = screen.getByRole('listbox', { name: 'Ingredienti suggeriti' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'pantry-suggestions');
    expect(within(listbox).getByRole('option', { name: 'Pomodoro' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onAdd).toHaveBeenCalledWith([{ id: 'tomato', label: 'Pomodoro', known: true }]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('lets keyboard users close suggestions without changing the input', async () => {
    const user = userEvent.setup();

    render(<IngredientInput onAdd={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: 'Ingredienti presenti' });

    await user.type(input, 'pom');
    await user.keyboard('{Escape}');

    expect(input).toHaveValue('pom');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
