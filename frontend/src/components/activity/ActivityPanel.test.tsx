import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import ActivityPanel from './ActivityPanel';
import { setActiveDataScope } from '../../sync/scopeContext';

const event: CookEvent = {
  id: 'event-1',
  recipeId: 'pasta-tonno-pomodoro',
  recipeTitle: 'Pasta tonno e pomodoro',
  servings: 2,
  cookedAt: '2026-09-13T12:00:00.000Z',
  note: 'Con basilico',
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

const preference: RecipePreference = {
  recipeId: 'pasta-tonno-pomodoro',
  favorite: true,
  rating: 5,
  note: 'Da rifare',
  createdAt: '2026-09-13T12:00:00.000Z',
  updatedAt: '2026-09-13T12:00:00.000Z',
};

describe('ActivityPanel', () => {
  it('clamps the last history page after removal and clears undo when the scope changes', async () => {
    setActiveDataScope('guest');
    const user = userEvent.setup();
    const events = Array.from({ length: 41 }, (_, index) => ({ ...event, id: `event-${index}`, recipeTitle: `Cena ${index + 1}` }));
    const props = { preferences: [], onRemoveEvent: vi.fn().mockReturnValue(true), onRestoreEvent: vi.fn().mockReturnValue(true), onClearActivity: vi.fn() };
    const { rerender } = render(<ActivityPanel {...props} events={events} />);
    const navigation = screen.getByRole('navigation', { name: 'Ricette cucinate' });
    await user.click(within(navigation).getByRole('button', { name: 'Avanti' }));
    await user.click(within(navigation).getByRole('button', { name: 'Avanti' }));
    await user.click(screen.getByRole('button', { name: 'Rimuovi evento Cena 41' }));
    rerender(<ActivityPanel {...props} events={events.slice(0, 40)} />);
    expect(within(navigation).getByRole('status')).toHaveTextContent('Pagina 2 di 2');
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeVisible();
    act(() => setActiveDataScope('house:other'));
    expect(screen.queryByRole('button', { name: 'Annulla' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Ricette cucinate' })).getByRole('status')).toHaveTextContent('Pagina 1 di 2');
    expect(props.onRestoreEvent).not.toHaveBeenCalled();
  });
  it('explains empty activity', () => {
    render(<ActivityPanel events={[]} preferences={[]} onRemoveEvent={vi.fn()} onRestoreEvent={vi.fn()} onClearActivity={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'La tua attività' })).toBeInTheDocument();
    expect(screen.getByText('Non hai ancora segnato ricette come cucinate.')).toBeVisible();
  });

  it('shows cooking history, preference details and handles removal', async () => {
    const user = userEvent.setup();
    const onRemoveEvent = vi.fn();
    const onRestoreEvent = vi.fn().mockReturnValue(true);
    const onClearActivity = vi.fn();
    render(<ActivityPanel events={[event]} preferences={[preference]} onRemoveEvent={onRemoveEvent} onRestoreEvent={onRestoreEvent} onClearActivity={onClearActivity} />);

    expect(screen.getAllByText('Pasta tonno e pomodoro')).toHaveLength(2);
    expect(screen.getByText(/Con basilico/)).toBeVisible();
    expect(screen.getByText(/Da rifare/)).toBeVisible();
    expect(screen.getByText('5/5')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Rimuovi evento Pasta tonno e pomodoro' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    await user.click(screen.getByRole('button', { name: 'Svuota attività' }));

    expect(onRemoveEvent).toHaveBeenCalledWith(event.id);
    expect(onRestoreEvent).toHaveBeenCalledWith(event);
    expect(onClearActivity).toHaveBeenCalledOnce();
  });
});
