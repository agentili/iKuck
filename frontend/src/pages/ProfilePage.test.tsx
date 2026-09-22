import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { useAuthStore } from '../auth/authStore';
import { ApiClientError } from '../api/apiClient';

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
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' } }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes') {
        return Promise.resolve(new Response(JSON.stringify({ recipes: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
    }));
  });

  it('keeps guest account access explicit without promising an automatic import', () => {
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Accedi al tuo profilo' })).toBeInTheDocument();
    expect(screen.getByText(/non importa automaticamente i dati locali/i)).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Importa i dati locali' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esporta i miei dati' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elimina account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accedi con Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Accesso con Google non disponibile in questo ambiente.')).toBeVisible();
  });

  it('keeps private AI recipes inside the verified profile area', async () => {
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    const accountData = screen.getByRole('heading', { name: 'I tuoi dati' });
    const panel = screen.getByRole('region', { name: 'Ricette AI private' });

    expect(accountData.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Ricette AI private' })).toBeInTheDocument();
  });

  it('keeps app version and build diagnostics outside the primary profile header', async () => {
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    const diagnostics = screen.getByText('Diagnostica applicazione').closest('details');

    expect(diagnostics).not.toBeNull();
    expect(diagnostics).not.toHaveAttribute('open');
    expect(screen.getByText('Versione app')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
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

  it('shows sync counts only after the complete local-data import', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' } }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes') {
        return Promise.resolve(new Response(JSON.stringify({ recipes: [] }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 1 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await user.click(screen.getByRole('button', { name: 'Importa i dati locali' }));
    expect(screen.getByText(/I dati locali resteranno sul dispositivo/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Conferma importazione' }));

    const syncMessage = await screen.findByText(/Sincronizzazione completata/);
    expect(syncMessage).toHaveTextContent(/elementi inviati/);
    expect(syncMessage).toHaveTextContent(/0 ricevuti/);
    expect(syncMessage).toHaveTextContent(/In attesa: 0/);
    vi.unstubAllGlobals();
  });

  it('reports a partial import when the server keeps returning more pages', async () => {
    const user = userEvent.setup();
    let cursor = 0;
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({ consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' } }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes') {
        return Promise.resolve(new Response(JSON.stringify({ recipes: [] }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      cursor += 1;
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: cursor, hasMore: true }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await user.click(screen.getByRole('button', { name: 'Importa i dati locali' }));
    await user.click(screen.getByRole('button', { name: 'Conferma importazione' }));

    expect(await screen.findByText(/Sincronizzazione parziale/)).toBeVisible();
    expect(fetch).toHaveBeenCalledWith('/v1/sync', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('shows a recoverable error when profile loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'Network unavailable')));
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Sei offline');
    vi.unstubAllGlobals();
  });

  it('requires explicit confirmation before importing local data', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await user.click(screen.getByRole('button', { name: 'Importa i dati locali' }));

    expect(screen.getByRole('button', { name: 'Conferma importazione' })).toBeInTheDocument();
    expect(screen.getByText(/Confermi l’unione.*non verranno cancellati/)).toBeInTheDocument();
  });

  it('clears the local session and navigates home when logout fails', async () => {
    const user = userEvent.setup();
    const logout = vi.fn().mockRejectedValue(new ApiClientError(0, 'network_error', 'Network unavailable'));
    const clearSession = vi.fn();
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', logout, clearSession });

    render(
      <MemoryRouter initialEntries={['/profile']}>
        <Routes>
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/" element={<h1>Home</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await user.click(screen.getByRole('button', { name: 'Esci' }));

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(logout).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
