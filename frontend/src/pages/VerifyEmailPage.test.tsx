import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VerifyEmailPage from './VerifyEmailPage';

describe('VerifyEmailPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ verified: true }),
      { status: 200 },
    )));
  });

  it('verifies the URL token without displaying it', async () => {
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, 'replaceState');
    render(
      <MemoryRouter initialEntries={['/verify-email?token=secret-verification-token-1234567890']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Conferma la tua email' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('ik-page');
    expect(screen.getByRole('region', { name: 'Conferma la tua email' })).toHaveClass('ik-surface', 'ik-profile-surface');
    expect(screen.queryByText('secret-verification-token-1234567890')).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), '', '/verify-email');

    const confirmButton = screen.getByRole('button', { name: 'Conferma email' });
    expect(confirmButton).toHaveClass('ik-button-primary', 'focus-visible:outline-[var(--ik-focus)]');
    await user.click(confirmButton);

    expect(await screen.findByRole('heading', { name: 'Email verificata' })).toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/v1/auth/verify-email', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ token: 'secret-verification-token-1234567890' }),
    }));
  });

  it('reports an invalid or expired token without exposing the raw value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'invalid_token', message: 'Invalid token' }),
      { status: 400 },
    )));
    render(
      <MemoryRouter initialEntries={['/verify-email?token=expired-token-1234567890']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Il link non è valido o è scaduto.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('bg-[var(--ik-tomato-soft)]', 'text-[var(--ik-tomato)]');
    expect(screen.queryByText('expired-token-1234567890')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Torna alle ricette' })).toHaveAttribute('href', '/recipes');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
