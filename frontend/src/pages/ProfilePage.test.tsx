import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, act, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './ProfilePage';
import { useAuthStore } from '../auth/authStore';
import { ApiClientError } from '../api/apiClient';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { saveColorThemePreference } from '../domain/colorTheme';
import * as aiRecipeHistory from '../ai/aiRecipeHistory';
import { mealPlanApi } from '../mealPlan/api';
import { readMealPlanSnapshot, saveGuestPlanState } from '../mealPlan/storage';
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

  it('requires explicit approval for the server-selected recipe provider', async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'gemini',
          selectedImageProvider: 'openai',
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const consent = await screen.findByRole('checkbox', { name: /acconsento all’invio a Gemini di Google/i });
    expect(consent).not.toBeChecked();
    expect(fetch).not.toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({ method: 'PUT' }));
  });

  it('saves an explicit grant to the server-selected provider with the current revision', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-13T12:01:00.000Z' },
          selectedProvider: 'gemini',
          selectedImageProvider: 'openai',
        }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'gemini',
          selectedImageProvider: 'openai',
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(await screen.findByRole('checkbox', { name: /acconsento all’invio a Gemini di Google/i }));
    await user.click(screen.getByRole('button', { name: 'Salva consenso AI' }));

    expect(fetch).toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ enabled: true, homeProvider: 'gemini', expectedRevision: '2026-09-13T12:00:00.000Z' }),
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
    }));
    expect(await screen.findByText('Consenso attivo per Gemini di Google.')).toBeVisible();
  });

  it('allows explicit server-selected image consent separately from recipe consent', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: true, imageProvider: 'gemini', imagePolicyVersion: 'recipe-images-v1', updatedAt: '2026-09-13T12:01:00.000Z' },
          selectedProvider: 'openai',
          selectedImageProvider: 'gemini',
        }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'openai',
          selectedImageProvider: 'gemini',
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    const imageConsent = await screen.findByRole('checkbox', { name: /Acconsento all’invio a Gemini di Google per le immagini/i });
    expect(imageConsent).not.toBeChecked();
    await user.click(imageConsent);
    await user.click(screen.getByRole('button', { name: 'Salva consenso immagini AI' }));

    expect(fetch).toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ enabled: true, imagePolicyVersion: 'recipe-images-v1', imageProvider: 'gemini', expectedRevision: '2026-09-13T12:00:00.000Z' }),
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
    }));
    expect(screen.getByRole('checkbox', { name: /Acconsento all’invio a OpenAI dei dati necessari per creare ricette AI/i })).not.toBeChecked();
    expect(await screen.findByText(/Consenso immagini attivo per Gemini di Google/)).toBeVisible();
  });

  it('fails closed when the server has no selected image provider', async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'gemini',
          selectedImageProvider: null,
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByText(/Il servizio per la creazione di immagini non è disponibile sul server/i)).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /per le immagini/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salva consenso immagini AI' })).not.toBeInTheDocument();
    expect(screen.queryByText(/foto candidate vengono inviati a/i)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith('/v1/ai-recipes', expect.anything());
    expect(fetch).not.toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({ method: 'PUT' }));
  });

  it('does not offer approval when the selected AI provider is unavailable', async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({ code: 'provider_unavailable', message: 'Unavailable' }), { status: 503 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent(/provider AI non è disponibile/i);
    expect(screen.queryByRole('checkbox', { name: /acconsento all’invio a .*ingredienti/i })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({ method: 'PUT' }));
  });

  it('revokes global consent, including image permission, from Profile', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:02:00.000Z' },
          selectedProvider: 'openai',
          selectedImageProvider: 'gemini',
        }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: true, homeProvider: 'openai', imageProvider: 'gemini', imagePolicyVersion: 'recipe-images-v1', updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'openai',
          selectedImageProvider: 'gemini',
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    const clearHistory = vi.spyOn(aiRecipeHistory, 'clearAiRecipeProposalHistory').mockResolvedValue(true);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: 'Revoca consenso AI globale' }));

    expect(fetch).toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
    }));
    expect(clearHistory).toHaveBeenCalledWith(verifiedUser.id);
    expect(await screen.findByText(/Consenso AI revocato/)).toBeVisible();
  });

  it('refreshes the server consent after a revision conflict instead of retrying a stale grant', async () => {
    const user = userEvent.setup();
    let consentReads = 0;
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ code: 'ai_consent_revision_conflict', message: 'Consent changed' }), { status: 409 }));
      }
      if (path === '/v1/ai-recipes/consent') {
        consentReads += 1;
        const consent = consentReads === 1
          ? { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' }
          : { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:02:00.000Z' };
        return Promise.resolve(new Response(JSON.stringify({ consent, selectedProvider: 'openai' }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(await screen.findByRole('checkbox', { name: /acconsento all’invio a OpenAI/i }));
    await user.click(screen.getByRole('button', { name: 'Salva consenso AI' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cambiato in un’altra scheda/i);
    expect(screen.getByRole('checkbox', { name: /acconsento all’invio a OpenAI/i })).toBeChecked();
    expect(consentReads).toBe(2);
  });

  it.each(['home', 'images'] as const)(
    'ignores a failed stale %s conflict refresh after the account and CSRF session change',
    async (permission) => {
      const user = userEvent.setup();
      const secondAccount = { ...verifiedUser, id: 'user-2', email: 'second@example.com' };
      let consentReads = 0;
      let rejectConflictRefresh: ((reason?: unknown) => void) | undefined;
      let consentWrites = 0;
      const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
        if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
          consentWrites += 1;
          return Promise.resolve(new Response(JSON.stringify({ code: 'ai_consent_revision_conflict', message: 'Consent changed' }), { status: 409 }));
        }
        if (path === '/v1/ai-recipes/consent') {
          consentReads += 1;
          if (consentReads === 2) {
            return new Promise<Response>((_resolve, reject) => { rejectConflictRefresh = reject; });
          }
          const isNewOwner = consentReads > 2;
          return Promise.resolve(new Response(JSON.stringify({
            consent: { enabled: false, updatedAt: isNewOwner ? '2026-09-13T12:03:00.000Z' : '2026-09-13T12:00:00.000Z' },
            selectedProvider: isNewOwner ? 'gemini' : 'openai',
            selectedImageProvider: isNewOwner ? 'openai' : 'gemini',
          }), { status: 200 }));
        }
        if (path === '/v1/profile') {
          return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: null } }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
      });
      vi.stubGlobal('fetch', fetch);
      setActiveDataScope('account:user-1');
      useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
      render(<MemoryRouter><ProfilePage /></MemoryRouter>);

      const oldControlName = permission === 'home'
        ? /Acconsento all’invio a OpenAI dei dati necessari per creare ricette AI/i
        : /Acconsento all’invio a Gemini di Google per le immagini/i;
      const newControlName = permission === 'home'
        ? /Acconsento all’invio a Gemini di Google dei dati necessari per creare ricette AI/i
        : /Acconsento all’invio a OpenAI per le immagini delle ricette/i;
      await user.click(await screen.findByRole('checkbox', { name: oldControlName }));
      await user.click(screen.getByRole('button', { name: permission === 'home' ? 'Salva consenso AI' : 'Salva consenso immagini AI' }));
      await waitFor(() => expect(rejectConflictRefresh).toBeDefined());

      await act(async () => {
        useAuthStore.setState({ user: secondAccount, csrfToken: 'csrf-2' });
        setActiveDataScope('account:user-2');
      });
      const newOwnerControl = await screen.findByRole('checkbox', { name: newControlName });
      expect(newOwnerControl).not.toBeChecked();
      expect(screen.getByText('Provider selezionato dal server: Gemini di Google.')).toBeVisible();

      await act(async () => {
        rejectConflictRefresh?.(new Error('The previous owner refresh failed'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Il consenso è cambiato in un’altra scheda/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Consenso attivo per OpenAI.')).not.toBeInTheDocument();
      expect(screen.queryByText(/Consenso immagini attivo per Gemini di Google/)).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: newControlName })).not.toBeChecked();
      expect(consentWrites).toBe(1);
    },
  );

  it('does not expose the previous account consent while the new session status is loading', async () => {
    const secondAccount = { ...verifiedUser, id: 'user-2', email: 'second@example.com' };
    let consentReads = 0;
    let resolveSecondConsent: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        consentReads += 1;
        if (consentReads === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:00:00.000Z' },
            selectedProvider: 'openai',
          }), { status: 200 }));
        }
        return new Promise<Response>((resolve) => { resolveSecondConsent = resolve; });
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: null } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Revoca consenso AI globale' });

    await act(async () => {
      useAuthStore.setState({ user: secondAccount, csrfToken: 'csrf-2' });
      setActiveDataScope('account:user-2');
    });
    const staleRevokeWasVisible = screen.queryByRole('button', { name: 'Revoca consenso AI globale' }) !== null;
    await act(async () => {
      resolveSecondConsent?.(new Response(JSON.stringify({
        consent: { enabled: false, updatedAt: '2026-09-13T12:03:00.000Z' },
        selectedProvider: 'gemini',
      }), { status: 200 }));
    });

    expect(staleRevokeWasVisible).toBe(false);
    expect(await screen.findByText(/Provider selezionato dal server: Gemini di Google/)).toBeVisible();
  });

  it('ignores a consent grant that completes after the account session and scope change', async () => {
    const user = userEvent.setup();
    const secondAccount = { ...verifiedUser, id: 'user-2', email: 'second@example.com' };
    let consentReads = 0;
    let resolveGrant: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockImplementation((path: string, options?: RequestInit) => {
      if (path === '/v1/ai-recipes/consent' && options?.method === 'PUT') {
        return new Promise<Response>((resolve) => { resolveGrant = resolve; });
      }
      if (path === '/v1/ai-recipes/consent') {
        consentReads += 1;
        const selectedProvider = consentReads === 1 ? 'openai' : 'gemini';
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: `2026-09-13T12:0${consentReads}:00.000Z` },
          selectedProvider,
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: null } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await user.click(await screen.findByRole('checkbox', { name: /acconsento all’invio a OpenAI/i }));
    await user.click(screen.getByRole('button', { name: 'Salva consenso AI' }));
    await act(async () => {
      useAuthStore.setState({ user: secondAccount, csrfToken: 'csrf-2' });
      setActiveDataScope('account:user-2');
    });
    const secondConsent = await screen.findByRole('checkbox', { name: /acconsento all’invio a Gemini di Google/i });
    expect(secondConsent).not.toBeChecked();

    await act(async () => {
      resolveGrant?.(new Response(JSON.stringify({
        consent: { enabled: true, homeProvider: 'openai', updatedAt: '2026-09-13T12:05:00.000Z' },
        selectedProvider: 'openai',
      }), { status: 200 }));
    });

    expect(screen.queryByText('Consenso attivo per OpenAI.')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /acconsento all’invio a Gemini di Google/i })).not.toBeChecked();
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
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1', expiresAt: '2026-10-12T10:00:00.000Z' });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Il tuo profilo' });
    expect(screen.getByRole('link', { name: /Torna a Chef/i })).toHaveAttribute('href', '/');
  });

  it('labels the guest profile return destination as Chef in Sous Chef mode', () => {
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(screen.getByRole('link', { name: /Torna a Chef/i })).toHaveAttribute('href', '/');
  });

  it('requires a separate explicit confirmation before importing guest plan choices', async () => {
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
    await saveGuestPlanState({
      date: '2026-11-03', revision: crypto.randomUUID(), serverSequence: 0,
      kind: 'manual', recipeId: 'guest-pasta'
    });
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
    await saveGuestPlanState({
      date: '2026-11-03', revision: crypto.randomUUID(), serverSequence: 0,
      kind: 'manual', recipeId: 'guest-pasta'
    });
    setActiveDataScope('account:user-1');
    useAuthStore.setState({ user: verifiedUser, csrfToken: 'csrf-1' });
    vi.spyOn(planService, 'importGuestMealPlan').mockResolvedValue({
      queued: 0, acknowledged: 0, conflicts: 0,
      pending: 0, preservedConflicts: 1
    });
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

  it('keeps AI consent settings in Profile without loading private recipes or exposing generation controls', async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      if (path === '/v1/ai-recipes/consent') {
        return Promise.resolve(new Response(JSON.stringify({
          consent: { enabled: false, updatedAt: '2026-09-13T12:00:00.000Z' },
          selectedProvider: 'openai',
        }), { status: 200 }));
      }
      if (path === '/v1/profile') {
        return Promise.resolve(new Response(JSON.stringify({ profile: { displayName: 'Ale' } }), { status: 200 }));
      }
      if (path === '/v1/ai-recipes') {
        return Promise.resolve(new Response(JSON.stringify({ recipes: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ changes: [], nextCursor: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetch);
    useAuthStore.setState({
      user: verifiedUser,
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-12T10:00:00.000Z',
    });
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Consenso per le ricette AI' })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith('/v1/ai-recipes/consent', expect.any(Object));
    expect(fetch).not.toHaveBeenCalledWith('/v1/ai-recipes', expect.any(Object));
    expect(screen.queryByRole('button', { name: 'Genera ricetta AI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crea ricetta AI' })).not.toBeInTheDocument();
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

    expect(await screen.findByText(/Sei offline/, { selector: 'div[role="alert"]' })).toBeVisible();
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
