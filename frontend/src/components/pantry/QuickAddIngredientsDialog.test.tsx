import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import QuickAddIngredientsDialog from './QuickAddIngredientsDialog';

describe('QuickAddIngredientsDialog', () => {
  it('closes only after suggestions have first been dismissed with Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<QuickAddIngredientsDialog open scope="guest" onClose={onClose} onAdd={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: 'Ingredienti presenti' });
    await user.type(input, 'pom');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Aggiungi ingredienti' })).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invalidates an open draft when its account or house scope changes', async () => {
    const onClose = vi.fn();
    const onAdd = vi.fn();
    const { rerender } = render(<QuickAddIngredientsDialog open scope="guest" onClose={onClose} onAdd={onAdd} />);
    rerender(<QuickAddIngredientsDialog open scope="account:user-2" onClose={onClose} onAdd={onAdd} />);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<QuickAddIngredientsDialog open={false} scope="account:user-2" onClose={onClose} onAdd={onAdd} />);
    expect(screen.queryByRole('dialog', { name: 'Aggiungi ingredienti' })).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('submits parser output through the supplied pantry mutation', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<QuickAddIngredientsDialog open scope="guest" onClose={onClose} onAdd={onAdd} />);
    await user.type(screen.getByRole('combobox', { name: 'Ingredienti presenti' }), 'pomodoro, farina sconosciuta');
    await user.click(screen.getByRole('button', { name: 'Aggiungi ingredienti' }));
    expect(onAdd).toHaveBeenCalledWith([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'custom:farina-sconosciuta', label: 'farina sconosciuta', known: false },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
