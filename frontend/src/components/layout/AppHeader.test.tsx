import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import AppHeader from './AppHeader';
import { useAuthStore } from '../../auth/authStore';

describe('AppHeader', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, connection: 'unknown' });
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
});
