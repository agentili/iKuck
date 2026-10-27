import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import AppHeader from './AppHeader';
import { useAuthStore } from '../../auth/authStore';
import { usePantryCandidatesBadgeStore } from '../../store/pantryCandidatesBadgeStore';
import { saveColorThemePreference } from '../../domain/colorTheme';
import { setActiveDataScope } from '../../sync/scopeContext';
import { useHouseStore } from '../../house/houseStore';

describe('AppHeader', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    document.documentElement.dataset.theme = 'light';
    useAuthStore.setState({ user: null, connection: 'unknown' });
    usePantryCandidatesBadgeStore.getState().reset();
    setActiveDataScope('guest');
    useHouseStore.getState().clear();
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
    expect(screen.getByRole('status', { name: 'Stato account e dati' })).toHaveTextContent('Account verificato');
    expect(screen.queryByText('ale@example.com')).not.toBeInTheDocument();
  });

  it('keeps account identity, offline state and actual data scope visible together', () => {
    useAuthStore.setState({ user: { id: 'user-1', email: 'ale@example.com', emailVerifiedAt: '2026-09-12' }, connection: 'offline' });
    useHouseStore.setState({ state: { house: { id: 'old-house', name: 'Casa precedente', createdAt: '2026-09-12' }, membership: { role: 'member', joinedAt: '2026-09-12' }, members: [] } });
    setActiveDataScope('account:user-1');
    render(<MemoryRouter><AppHeader /></MemoryRouter>);
    const status = screen.getByRole('status', { name: 'Stato account e dati' });
    expect(status).toHaveTextContent('Account verificato');
    expect(status).toHaveTextContent('Offline');
    expect(status).toHaveTextContent('Dati personali');
    expect(status).not.toHaveTextContent('Casa precedente');
    act(() => setActiveDataScope('house:old-house'));
    expect(status).toHaveTextContent('Casa · Casa precedente');
    act(() => setActiveDataScope('guest'));
    expect(status).toHaveTextContent('Dati ospite sul dispositivo');
  });

  it('responds to the browser going offline for guests', () => {
    render(<MemoryRouter><AppHeader /></MemoryRouter>);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    try {
      act(() => window.dispatchEvent(new Event('offline')));
      expect(screen.getByRole('status', { name: 'Stato account e dati' })).toHaveTextContent('Offline');
      expect(screen.getByRole('status', { name: 'Stato account e dati' })).toHaveTextContent('Ospite · dati locali');
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    }
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

  it('renders the Ricette destination between Cucina e Dispensa with the full name as accessible name', () => {
    render(<MemoryRouter initialEntries={['/']}><AppHeader /></MemoryRouter>);

    const navigation = screen.getByRole('navigation', { name: 'Navigazione principale' });
    const primary = within(navigation).getAllByRole('link', { name: /^(Cucina|Ricette|Dispensa|Spesa|Diario)$/ });
    expect(primary).toHaveLength(5);
    expect(primary.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Cucina', 'Ricette', 'Dispensa', 'Spesa', 'Diario',
    ]);
    const ricette = screen.getByRole('link', { name: 'Ricette' });
    expect(ricette).toHaveAttribute('href', '/recipes');
  });

  it('marks Ricette as current on /recipes', () => {
    render(<MemoryRouter initialEntries={['/recipes']}><AppHeader /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Ricette' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks Ricette as current on /recipes/:recipeId and no longer marks Cucina', () => {
    render(<MemoryRouter initialEntries={['/recipes/orata-al-forno']}><AppHeader /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Ricette' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Cucina' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Cucina current only on the home route', () => {
    render(<MemoryRouter initialEntries={['/']}><AppHeader /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Cucina' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Ricette' })).not.toHaveAttribute('aria-current');
  });

  it('renders a different icon for Ricette than for Diario (no icon collision)', () => {
    render(<MemoryRouter><AppHeader /></MemoryRouter>);

    const ricetteSvg = screen.getByRole('link', { name: 'Ricette' }).querySelector('svg');
    const diarioSvg = screen.getByRole('link', { name: 'Diario' }).querySelector('svg');
    expect(ricetteSvg).not.toBeNull();
    expect(diarioSvg).not.toBeNull();
    expect(ricetteSvg!.innerHTML).not.toBe(diarioSvg!.innerHTML);
  });

  it('applies the five-column grid and overflow-safe sizing to the navigation list', () => {
    render(<MemoryRouter><AppHeader /></MemoryRouter>);

    const list = screen.getByRole('navigation', { name: 'Navigazione principale' }).querySelector('ul');
    expect(list).not.toBeNull();
    expect(list!.className.split(/\s+/)).toContain('grid-cols-5');
    const items = list!.querySelectorAll('li');
    expect(items).toHaveLength(5);
    expect([...items].every((li) => li.className.split(/\s+/).includes('min-w-0'))).toBe(true);
  });
});
