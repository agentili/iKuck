import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import AppHeader from './AppHeader';
import { useAuthStore } from '../../auth/authStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';
import { saveColorThemePreference } from '../../domain/colorTheme';

describe('AppHeader', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    document.documentElement.dataset.theme = 'light';
    useAuthStore.setState({ user: null, connection: 'unknown' });
    usePantryCandidatesBadgeStore.getState().reset();
  });

  it('toggles the resolved theme and exposes the opposite action on mobile and desktop', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AppHeader /></MemoryRouter>);

    const toggleButtons = screen.getAllByRole('button', { name: 'Attiva tema scuro' });
    expect(toggleButtons).toHaveLength(2);
    await user.click(toggleButtons[0]);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('ikuck-color-theme')).toBe('dark');
    expect(screen.getAllByRole('button', { name: 'Attiva tema chiaro' })).toHaveLength(2);
  });

  it('exposes the compact primary navigation and marks the current route', () => {
    render(
      <MemoryRouter initialEntries={['/activity']}>
        <AppHeader />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Salta al contenuto' })).toHaveAttribute('href', '#main-content');
    const navigation = screen.getByRole('navigation', { name: 'Navigazione principale' });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cucina' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Dispensa' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Spesa' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Diario' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('link', { name: 'Profilo' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Casa' })).toHaveLength(2);
    expect(screen.queryByRole('link', { name: 'Attività' })).not.toBeInTheDocument();
  });

  it('marks the dinner diary as an accessible primary destination', () => {
    render(
      <MemoryRouter initialEntries={['/dinner-diary']}>
        <AppHeader />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Diario' })).toHaveAttribute('href', '/dinner-diary');
    expect(screen.getByRole('link', { name: 'Diario' })).toHaveAttribute('aria-current', 'page');
  });

  it('exposes profile and house destinations with the real connected scope', () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'ale@example.com', emailVerifiedAt: '2026-09-12T10:00:00.000Z' },
      connection: 'online',
    });

    render(<MemoryRouter><AppHeader /></MemoryRouter>);

    expect(screen.getAllByRole('link', { name: 'Profilo' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Casa' })).toHaveLength(2);
    expect(screen.getAllByText('Account verificato')).toHaveLength(2);
    expect(screen.queryByText('ale@example.com')).not.toBeInTheDocument();
  });

  it('mostra il badge dei candidati pendenti sulla scheda Dispensa', () => {
    usePantryCandidatesBadgeStore.getState().setHouse('house-a');
    usePantryCandidatesBadgeStore.getState().setPendingCount(3);
    render(<MemoryRouter initialEntries={['/pantry']}><AppHeader /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Dispensa (3 da confermare)' })).toBeInTheDocument();
    expect(screen.getByLabelText('3 articoli da confermare')).toHaveTextContent('3');
  });

  it('non mostra il badge quando non ci sono candidati pendenti', () => {
    render(<MemoryRouter initialEntries={['/pantry']}><AppHeader /></MemoryRouter>);

    expect(screen.queryByLabelText(/da confermare/)).not.toBeInTheDocument();
  });
});
