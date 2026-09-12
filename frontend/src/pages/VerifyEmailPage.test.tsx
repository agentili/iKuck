import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
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
    render(
      <MemoryRouter initialEntries={['/verify-email?token=secret-verification-token-1234567890']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Email verificata' })).toBeInTheDocument();
    expect(screen.queryByText('secret-verification-token-1234567890')).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/v1/auth/verify-email?token=secret-verification-token-1234567890',
      expect.objectContaining({ credentials: 'include' }),
    );
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
    expect(screen.queryByText('expired-token-1234567890')).not.toBeInTheDocument();
  });
});
