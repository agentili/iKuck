import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { useAuthStore } from '../auth/authStore';
import { ApiClientError } from '../api/apiClient';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { saveColorThemePreference } from '../domain/colorTheme';
import { saveColorPalettePreference } from '../domain/colorPalette';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

describe('ProfilePage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
    saveColorPalettePreference('pistachio-lemon');
    setActiveDataScope('guest');
    setPersonalDataScope('guest');
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

  it('ignores an old save response and clears confirmation state after switching accounts', async () => {
    const actions = userEvent.setup();
    let finishSave!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finishSave = resolve; });
      const displayName = useAuthStore.getState().user?.id === verifiedUser.id ? 'Ale' : 'Bea';
      return Promise.resolve(new Response(JSON.stringify({ profile: { displayName } }), { status: 200 }));
    }));
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByDisplayValue('Ale');
    await actions.click(screen.getByRole('button', { name: 'Elimina account' }));
    await actions.click(screen.getByRole('button', { name: 'Salva profilo' }));
    act(() => useAuthStore.setState({ user: { ...verifiedUser, id: 'user-2' }, csrfToken: 'csrf-2' }));
    await screen.findByDisplayValue('Bea');
    expect(screen.queryByRole('button', { name: 'Conferma eliminazione account' })).not.toBeInTheDocument();
    await act(async () => finishSave(new Response(JSON.stringify({ profile: { displayName: 'Nome precedente' } }), { status: 200 })));
    expect(screen.getByLabelText('Nome visualizzato')).toHaveValue('Bea');
    expect(screen.queryByText('Profilo aggiornato.')).not.toBeInTheDocument();
  });

  it('does not clear the new session after an old account deletion finishes', async () => {
    const actions = userEvent.setup();
    let finishDelete!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((resolve) => { finishDelete = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Nome' } }), { status: 200 }));
    }));
    const clearSession = vi.fn();
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', clearSession });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByDisplayValue('Nome');
    await actions.click(screen.getByRole('button', { name: 'Elimina account' }));
    await actions.click(screen.getByRole('button', { name: 'Conferma eliminazione account' }));
    act(() => useAuthStore.setState({ user: { ...verifiedUser, id: 'user-2' }, csrfToken: 'csrf-2' }));
    await act(async () => finishDelete(new Response(null, { status: 204 })));
    expect(clearSession).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user?.id).toBe('user-2');
    expect(screen.getByRole('heading', { name: 'Il tuo profilo' })).toBeVisible();
  });

  it('offers all theme options and persists a selected preference', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const themeGroup = screen.getByRole('radiogroup', { name: 'Tema' });
    expect(themeGroup).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sistema' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Scuro' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Chiaro' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Scuro' }));

    expect(screen.getByRole('radio', { name: 'Scuro' })).toBeChecked();
    expect(window.localStorage.getItem('ikuck-color-theme')).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    act(() => saveColorThemePreference('light'));
    expect(screen.getByRole('radio', { name: 'Chiaro' })).toBeChecked();
    expect(window.localStorage.getItem('ikuck-color-theme')).toBe('light');
  });

  it('offers all palette options and saves the selected palette on this device', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const paletteGroup = screen.getByRole('radiogroup', { name: 'Palette' });
    expect(paletteGroup).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Pistacchio e limone/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Pesca e corallo/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Lavanda e mirtillo/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Mare e terracotta/ })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Lavanda e mirtillo/ }));

    expect(screen.getByRole('radio', { name: /Lavanda e mirtillo/ })).toBeChecked();
    expect(window.localStorage.getItem('ikuck-color-palette')).toBe('lavender-blueberry');
    expect(document.documentElement).toHaveAttribute('data-palette', 'lavender-blueberry');
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
    expect(screen.getByRole('radiogroup', { name: 'Palette' })).toBeVisible();
    expect(screen.getByText('ale@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importa i dati locali' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'La mia casa' })).toHaveAttribute('href', '/house');
    expect(screen.getByRole('button', { name: 'Esporta i miei dati' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elimina account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accedi con Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Accesso con Google non disponibile in questo ambiente.')).toBeVisible();
  });

  it('explains Bring data transfer, personal encrypted sessions, and disconnect limits', async () => {
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    expect(screen.getByRole('heading', { name: 'Privacy e servizi esterni' })).toBeVisible();
    expect(screen.getByText(/il collegamento richiede una conferma esplicita.*dopo la conferma, email e password vengono inviate a Bring!/i)).toBeVisible();
    expect(screen.getByText(/la password non viene conservata.*sessione è cifrata sul server.*resta personale/i)).toBeVisible();
    expect(screen.getByText(/nomi degli articoli e le specifiche.*non è copiata nella lista A tavola.*non è disponibile offline/i)).toBeVisible();
    expect(screen.getByText(/ingredienti delle ricette non vengono trasferiti automaticamente/i)).toBeVisible();
    expect(screen.getByText(/non garantisce la revoca.*Bring!/i)).toBeVisible();
  });

  it('labels guest import as a house operation and preserves shared history on account deletion', async () => {
    setActiveDataScope('house:copy-home');
    setPersonalDataScope('account:user-1');
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    expect(screen.getByText(/dati ospite.*Casa attiva/i)).toBeVisible();
    expect(screen.getByText(/i dati condivisi restano nella Casa/i)).toBeVisible();
  });

  it('no longer includes the AI recipes panel (moved to home page)', async () => {
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    expect(screen.queryByRole('region', { name: 'Ricette AI private' })).not.toBeInTheDocument();
  });

  it('keeps diagnostics compact and opens them only on request', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    const diagnostics = screen.getByText('Diagnostica applicazione').closest('details');

    expect(diagnostics).not.toBeNull();
    expect(diagnostics).toHaveClass('mt-4');
    expect(diagnostics).not.toHaveAttribute('open');
    expect(screen.getByText('Versione app')).not.toBeVisible();
    expect(screen.getByText('Build')).not.toBeVisible();
    await user.click(screen.getByText('Diagnostica applicazione'));
    expect(screen.getByText('Versione app')).toBeVisible();
    expect(screen.getByText('Build')).toBeVisible();
    await user.click(screen.getByText('Diagnostica applicazione'));
    expect(diagnostics).not.toHaveAttribute('open');
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
    setActiveDataScope('account:user-1');
    setPersonalDataScope('account:user-1');
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
    setActiveDataScope('account:user-1');
    setPersonalDataScope('account:user-1');
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
