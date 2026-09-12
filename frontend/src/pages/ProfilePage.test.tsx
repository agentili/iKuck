import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { useAuthStore } from '../auth/authStore';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

describe('ProfilePage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      csrfToken: null,
      expiresAt: null,
      connection: 'unknown',
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      resendVerification: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      requestPasswordReset: vi.fn(),
      restoreSession: vi.fn(),
      clearSession: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }),
    ));
  });

  it('asks guests to log in before showing account controls', () => {
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Accedi per vedere il profilo' })).toBeInTheDocument();
  });

  it('shows the verified account and explicit local-data controls', async () => {
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Il tuo profilo' })).toBeInTheDocument();
    expect(screen.getByText('ale@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importa la dispensa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esporta i miei dati' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elimina account' })).toBeInTheDocument();
  });

  it('requires a second confirmation before account deletion', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await user.click(screen.getByRole('button', { name: 'Elimina account' }));

    expect(screen.getByRole('button', { name: 'Conferma eliminazione account' })).toBeInTheDocument();
  });
});
