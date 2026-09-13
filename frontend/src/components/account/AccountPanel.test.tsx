import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPanel from './AccountPanel';
import { useAuthStore } from '../../auth/authStore';

describe('AccountPanel', () => {
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
      logout: vi.fn(),
      requestPasswordReset: vi.fn(),
      restoreSession: vi.fn(),
      clearSession: vi.fn(),
    });
  });

  it('explains guest privacy before opening the account form', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AccountPanel /></MemoryRouter>);

    expect(screen.getByText('I tuoi dati restano su questo dispositivo.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accedi o registrati' }));

    expect(screen.getByRole('heading', { name: 'Il tuo account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('submits a registration and explains that email verification is required', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ register });
    const user = userEvent.setup();
    render(<MemoryRouter><AccountPanel /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Accedi o registrati' }));
    await user.click(screen.getByRole('button', { name: 'Registrati' }));
    await user.type(screen.getByLabelText('Email'), 'ale@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Crea account' }));

    expect(register).toHaveBeenCalledWith('ale@example.com', 'a long enough password');
    expect(await screen.findByText('Controlla la tua email per verificare l’account.')).toBeInTheDocument();
  });

  it('shows verification guidance when login is rejected for an unverified account', async () => {
    const login = vi.fn().mockRejectedValue({ code: 'email_not_verified' });
    useAuthStore.setState({ login });
    const user = userEvent.setup();
    render(<MemoryRouter><AccountPanel /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Accedi o registrati' }));
    await user.type(screen.getByLabelText('Email'), 'ale@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Accedi al profilo' }));

    expect(await screen.findByText('Devi verificare la tua email prima di accedere.')).toBeInTheDocument();
    expect(screen.queryByText('a long enough password')).not.toBeInTheDocument();
  });

  it('navigates to the profile after a verified login succeeds', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ login });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<AccountPanel />} />
          <Route path="/profile" element={<h1>Profilo account</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Accedi o registrati' }));
    await user.type(screen.getByLabelText('Email'), 'ale@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.click(screen.getByRole('button', { name: 'Accedi al profilo' }));

    expect(login).toHaveBeenCalledWith('ale@example.com', 'a long enough password');
    expect(await screen.findByRole('heading', { name: 'Profilo account' })).toBeInTheDocument();
  });
});
