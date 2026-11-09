import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { useAuthStore } from '../auth/authStore';
import { ApiClientError } from '../api/apiClient';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { saveColorThemePreference } from '../domain/colorTheme';
import { mealPlanApi } from '../mealPlan/api';
import { readMealPlanSnapshot, saveGuestPlanState } from '../mealPlan/storage';
import * as features from '../config/features';
import * as planStorage from '../mealPlan/storage';
import * as planService from '../mealPlan/service';

const verifiedUser = {
  id: 'user-1',
  email: 'ale@example.com',
  emailVerifiedAt: '2026-09-12T10:00:00.000Z',
};

describe('ProfilePage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveColorThemePreference('system');
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

  it('offers ten color palettes and applies the selected palette immediately', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const paletteGroup = screen.getByRole('radiogroup', { name: 'Palette colori' });
    expect(within(paletteGroup).getAllByRole('radio')).toHaveLength(10);
    expect(within(paletteGroup).getByRole('radio', { name: /Basilico/ })).toBeChecked();

    await user.click(within(paletteGroup).getByRole('radio', { name: /Oceano/ }));

    expect(within(paletteGroup).getByRole('radio', { name: /Oceano/ })).toBeChecked();
    expect(window.localStorage.getItem('ikuck-color-palette')).toBe('oceano');
    expect(document.documentElement).toHaveAttribute('data-palette', 'oceano');
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
    expect(screen.getByRole('link', { name: 'La mia casa' })).toHaveAttribute('href', '/house');
    expect(screen.getByRole('button', { name: 'Esporta i miei dati' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elimina account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accedi con Google' })).not.toBeInTheDocument();
    expect(screen.getByText('Accesso con Google non disponibile in questo ambiente.')).toBeVisible();
  });

  it('labels the profile return destination as Chef when Sous Chef owns the root route', async () => {
    const sousChefFlag = vi.spyOn(features, 'isSousChef').mockReturnValue(true);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    expect(screen.getByRole('link', { name: /Torna a Chef/i })).toHaveAttribute('href', '/');
    sousChefFlag.mockRestore();
  });

  it('labels the guest profile return destination as Chef in Sous Chef mode', () => {
    const sousChefFlag = vi.spyOn(features, 'isSousChef').mockReturnValue(true);
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(screen.getByRole('link', { name: /Torna a Chef/i })).toHaveAttribute('href', '/');
    sousChefFlag.mockRestore();
  });

  it('keeps the legacy recipes label for a guest profile when Sous Chef is disabled', () => {
    const sousChefFlag = vi.spyOn(features, 'isSousChef').mockReturnValue(false);
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(screen.getByRole('link', { name: /Torna alle ricette/i })).toHaveAttribute('href', '/');
    sousChefFlag.mockRestore();
  });

  it('keeps the plan import unavailable while the Sous-Chef rollout flag is off', async () => {
    vi.spyOn(features, 'isSousChef').mockReturnValue(false);
    await saveGuestPlanState({ date: '2026-11-03', revision: crypto.randomUUID(), serverSequence: 0,
      kind: 'manual', recipeId: 'guest-pasta' });
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    const guestRead = vi.spyOn(planStorage, 'readMealPlanSnapshot');
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    await act(async () => { await Promise.all(guestRead.mock.results.map((result) => result.value)); });
    expect(screen.queryByRole('button', { name: 'Importa Piano ospite' })).not.toBeInTheDocument();
  });

  it('requires a separate explicit confirmation before importing guest plan choices', async () => {
    vi.spyOn(features, 'isSousChef').mockReturnValue(true);
    const user = userEvent.setup();
    const guestPlan = {
      date: '2026-11-03', revision: '223e4567-e89b-42d3-a456-426614174001', serverSequence: 0,
      kind: 'manual' as const, recipeId: 'guest-pasta',
    };
    const serverPlan = { ...guestPlan, revision: '323e4567-e89b-42d3-a456-426614174002', serverSequence: 1 };
    await saveGuestPlanState(guestPlan);
    setActiveDataScope('account:user-1');
    setPersonalDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });

    vi.spyOn(mealPlanApi, 'getCapabilities').mockResolvedValue({ version: 2, syncReadVersion: 2 });
    vi.spyOn(mealPlanApi, 'readSyncPage').mockResolvedValue({ changes: [], nextCursor: 0 });
    vi.spyOn(mealPlanApi, 'readStates').mockImplementation(async (_scope, dates) => dates.map((date) => ({
      date, state: date === serverPlan.date ? serverPlan : null,
    })));
    const importCommands = vi.spyOn(mealPlanApi, 'importCommands').mockImplementation(async (_scope, items) => ({
      version: 2,
      results: items.map((item) => ({
        sourceId: item.sourceId,
        localRevision: item.localRevision,
        result: { version: 2, operationId: item.command.operationId, outcome: 'applied', current: serverPlan },
      })),
    }));

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    const importButton = await screen.findByRole('button', { name: 'Importa Piano ospite' });
    expect(importButton).toBeEnabled();
    expect(mealPlanApi.getCapabilities).not.toHaveBeenCalled();
    expect(importCommands).not.toHaveBeenCalled();

    await user.click(importButton);
    expect(screen.getByRole('button', { name: 'Conferma importazione Piano' })).toBeVisible();
    expect(mealPlanApi.getCapabilities).not.toHaveBeenCalled();
    expect(importCommands).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Conferma importazione Piano' }));
    expect(await screen.findByText(/Importazione Piano completata/)).toBeVisible();
    expect(importCommands).toHaveBeenCalledWith('account:user-1', [expect.objectContaining({
      source: 'guest', sourceId: guestPlan.date, localRevision: guestPlan.revision,
      command: expect.objectContaining({ scope: 'account:user-1', date: guestPlan.date, action: 'manual_set', recipeId: guestPlan.recipeId }),
    })], 'csrf-1');
    await expect(readMealPlanSnapshot('guest')).resolves.toMatchObject({ states: {} });
  });

  it('requires a new guest-plan confirmation after changing the destination account', async () => {
    vi.spyOn(features, 'isSousChef').mockReturnValue(true);
    await saveGuestPlanState({ date: '2026-11-03', revision: crypto.randomUUID(), serverSequence: 0,
      kind: 'manual', recipeId: 'guest-pasta' });
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Importa Piano ospite' }));
    expect(screen.getByRole('button', { name: 'Conferma importazione Piano' })).toBeVisible();

    await act(async () => {
      setActiveDataScope('account:user-2');
      useAuthStore.setState({ user: { ...verifiedUser, id: 'user-2', email: 'second@example.test' }, csrfToken: 'csrf-2' });
    });

    expect(screen.getByText('second@example.test')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Conferma importazione Piano' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importa Piano ospite' })).toBeVisible();
  });

  it('does not label a preserved guest source as a completed import', async () => {
    vi.spyOn(features, 'isSousChef').mockReturnValue(true);
    await saveGuestPlanState({ date: '2026-11-03', revision: crypto.randomUUID(), serverSequence: 0,
      kind: 'manual', recipeId: 'guest-pasta' });
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    vi.spyOn(planService, 'importGuestMealPlan').mockResolvedValue({ queued: 0, acknowledged: 0, conflicts: 0,
      pending: 0, preservedConflicts: 1 });
    const user = userEvent.setup();
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Importa Piano ospite' }));
    await user.click(screen.getByRole('button', { name: 'Conferma importazione Piano' }));
    const summary = await screen.findByText(/^Importazione Piano /);
    expect(summary).toHaveTextContent('parziale');
    expect(summary).toHaveTextContent('1 scelte conservate da rivedere');
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
    expect(screen.getByText(/nomi degli articoli e le specifiche.*non è copiata nella lista iKuck.*non è disponibile offline/i)).toBeVisible();
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
    expect(screen.getByText(/Confermi l['’]unione.*non verranno cancellati/)).toBeInTheDocument();
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
