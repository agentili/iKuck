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

    expect(await screen.findByRole('heading', { name: 'Password aggiornata' })).toBeInTheDocument();
    expect(screen.queryByText('secret-reset-token-123456789012345')).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/v1/auth/reset-password', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'secret-reset-token-123456789012345', password: 'a brand new password' }),
    }));
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
