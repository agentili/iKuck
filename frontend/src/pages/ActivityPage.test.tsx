import { MemoryRouter } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import ActivityPage from './ActivityPage';
import { useActivityStore } from '../store/activityStore';

const hydrateActivityStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../store/activityStore', async () => {
  const actual = await vi.importActual<typeof import('../store/activityStore')>('../store/activityStore');
  return { ...actual, hydrateActivityStore: hydrateActivityStoreMock };
});

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

describe('ActivityPage', () => {
  beforeEach(() => {
    hydrateActivityStoreMock.mockReset();
    hydrateActivityStoreMock.mockResolvedValue(undefined);
    useActivityStore.setState({ hasHydrated: false, events: [], preferences: [] });
  });

  it('shows loading while activity hydration is pending', () => {
    render(<MemoryRouter><ActivityPage /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento dell’attività…');
    expect(hydrateActivityStoreMock).toHaveBeenCalledOnce();
  });

  it('shows the empty state after activity hydration', async () => {
    useActivityStore.setState({ hasHydrated: true });
    render(<MemoryRouter><ActivityPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'La tua attività' })).toBeVisible();
    expect(screen.getByText('Non hai ancora segnato ricette come cucinate.')).toBeVisible();
    expect(hydrateActivityStoreMock).toHaveBeenCalledOnce();
  });

  it('renders populated history and invokes page actions', async () => {
    const user = userEvent.setup();
    const removeCookEvent = vi.fn().mockReturnValue(true);
    const restoreCookEvent = vi.fn().mockReturnValue(true);
    useActivityStore.setState({ hasHydrated: true, events: [event], preferences: [preference], removeCookEvent, restoreCookEvent });
    render(<MemoryRouter><ActivityPage /></MemoryRouter>);

    expect(screen.getByText(/Con basilico/)).toBeVisible();
    expect(screen.getByText(/Da rifare/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Rimuovi evento Pasta tonno e pomodoro' }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(removeCookEvent).toHaveBeenCalledWith(event.id);
    expect(restoreCookEvent).toHaveBeenCalledWith(event);
  });

  it('keeps the safe empty state when hydration reports no usable data', async () => {
    hydrateActivityStoreMock.mockImplementation(async () => {
      await act(async () => {
        useActivityStore.setState({ hasHydrated: true, events: [], preferences: [] });
      });
    });
    render(<MemoryRouter><ActivityPage /></MemoryRouter>);

    expect(await screen.findByText('Non hai ancora segnato ricette come cucinate.')).toBeVisible();
    expect(hydrateActivityStoreMock).toHaveBeenCalledOnce();
  });
});
