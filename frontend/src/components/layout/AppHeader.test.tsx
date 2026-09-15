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
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Lista' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Attività' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Profilo' })).not.toHaveAttribute('aria-current');
  });

  it('keeps account status compact in the header', () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'ale@example.com', emailVerifiedAt: '2026-09-12T10:00:00.000Z' },
      connection: 'online',
    });

    render(<MemoryRouter><AppHeader /></MemoryRouter>);

    expect(screen.getByText('Connesso')).toBeInTheDocument();
    expect(screen.queryByText('ale@example.com')).not.toBeInTheDocument();
  });
});
