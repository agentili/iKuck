import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage from './ForgotPasswordPage';

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  it('uses theme-aware surfaces, inputs and visible focus styles', () => {
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('main')).toHaveClass('ik-page', 'text-[var(--ik-ink)]');
    expect(screen.getByRole('region', { name: 'Recupera la password' })).toHaveClass('ik-surface', 'ik-profile-surface');
    expect(screen.getByLabelText('Email')).toHaveClass('ik-input', 'focus-visible:outline-[var(--ik-focus)]');
    expect(screen.getByRole('button', { name: 'Invia link di recupero' })).toHaveClass('ik-button-primary', 'focus-visible:outline-[var(--ik-focus)]');
  });

  it('keeps reset confirmation generic and returns to the recipe library', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Email'), 'private@example.test');
    await user.click(screen.getByRole('button', { name: 'Invia link di recupero' }));

    expect(await screen.findByRole('heading', { name: 'Controlla la tua email' })).toBeVisible();
    expect(screen.getByText('Se l\'email è registrata, riceverai le istruzioni per recuperare l\'account.')).toBeVisible();
    expect(screen.getByRole('status')).not.toHaveTextContent('private@example.test');
    expect(screen.getByRole('link', { name: 'Torna alle ricette' })).toHaveAttribute('href', '/recipes');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/v1/auth/request-password-reset', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'private@example.test' }),
    }));
  });

  it('shows rate-limit feedback with the semantic error palette without echoing the address', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'rate_limited', message: 'Too many requests' }),
      { status: 429 },
    )));
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText('Email'), 'private@example.test');
    await user.click(screen.getByRole('button', { name: 'Invia link di recupero' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Troppi tentativi. Attendi qualche minuto prima di riprovare.');
    expect(alert).toHaveClass('bg-[var(--ik-tomato-soft)]', 'text-[var(--ik-tomato)]');
    expect(alert).not.toHaveTextContent('private@example.test');
  });
});
