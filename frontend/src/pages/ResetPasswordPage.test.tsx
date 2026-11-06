import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage from './ResetPasswordPage';

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  it('submits a new password with the URL token without displaying the token', async () => {
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, 'replaceState');
    render(
      <MemoryRouter initialEntries={['/reset-password?token=secret-reset-token-123456789012345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Nuova password'), 'a brand new password');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'a brand new password');
    expect(screen.getByRole('main')).toHaveClass('ik-page', 'text-[var(--ik-ink)]');
    expect(screen.getByRole('region', { name: 'Reimposta la password' })).toHaveClass('ik-surface', 'ik-profile-surface');
    expect(screen.getByLabelText('Nuova password')).toHaveClass('ik-input', 'focus-visible:outline-[var(--ik-focus)]');
    expect(screen.getByRole('button', { name: 'Salva nuova password' })).toHaveClass('ik-button-primary', 'focus-visible:outline-[var(--ik-focus)]');
    await user.click(screen.getByRole('button', { name: 'Salva nuova password' }));

    expect(await screen.findByRole('heading', { name: 'Password aggiornata' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Vai all’accesso' })).toHaveAttribute('href', '/profile');
    expect(screen.queryByText('secret-reset-token-123456789012345')).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), '', '/reset-password');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/v1/auth/reset-password', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'secret-reset-token-123456789012345', password: 'a brand new password' }),
    }));
  });

  it('does not reuse a token after the URL has been scrubbed', async () => {
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Il link non è valido o è scaduto.');
    expect(screen.getByRole('alert')).toHaveClass('bg-[var(--ik-tomato-soft)]', 'text-[var(--ik-tomato)]');
    expect(screen.queryByLabelText('Nuova password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Richiedi un nuovo link' })).toHaveAttribute('href', '/forgot-password');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces an API-rejected reset form with recovery guidance', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'invalid_token', message: 'Invalid token' }),
      { status: 400 },
    )));
    render(
      <MemoryRouter initialEntries={['/reset-password?token=secret-reset-token-123456789012345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Nuova password'), 'a brand new password');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'a brand new password');
    await user.click(screen.getByRole('button', { name: 'Salva nuova password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Il link non è valido o è scaduto.');
    expect(screen.queryByLabelText('Nuova password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Richiedi un nuovo link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('rejects mismatched passwords before calling the API', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/reset-password?token=secret-reset-token-123456789012345']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Nuova password'), 'a brand new password');
    await user.type(screen.getByLabelText('Conferma nuova password'), 'a different password');
    await user.click(screen.getByRole('button', { name: 'Salva nuova password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Le password non coincidono.');
    expect(fetch).not.toHaveBeenCalled();
  });
});
