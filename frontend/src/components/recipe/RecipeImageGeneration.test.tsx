import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecipeImageGeneration from './RecipeImageGeneration';
import { useAuthStore } from '../../auth/authStore';
import { setActiveDataScope } from '../../sync/scopeContext';

const account = { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' };
const status = (enabled = true) => ({
  consent: { enabled, updatedAt: '2026-11-01T00:00:00Z', ...(enabled ? { imageProvider: 'openai', imagePolicyVersion: 'recipe-images-v1' } : {}) },
  selectedProvider: 'gemini', selectedImageProvider: 'openai',
});
const json = (data: unknown, code = 200) => new Response(JSON.stringify(data), { status: code });

beforeEach(() => {
  vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'true');
  useAuthStore.setState({ user: account, csrfToken: 'image-csrf' });
  setActiveDataScope('account:image-user');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('RecipeImageGeneration', () => {
  it('queues the collection once with CSRF and reports the accepted count', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({ queued: 12 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    expect(await screen.findByRole('status')).toHaveTextContent('12 immagini aggiunte alla coda');
    expect(fetch).toHaveBeenLastCalledWith('/v1/recipe-images/generate', expect.objectContaining({ method: 'POST', headers: { 'x-csrf-token': 'image-csrf' } }));
  });

  it('requests a catalog image without requesting private-data consent', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ queued: 1 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="pollo-al-limone" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Immagine aggiunta alla coda');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/v1/recipe-images/pollo-al-limone/generate?kind=catalog', expect.objectContaining({ method: 'POST' }));
  });

  it('links to Profile settings when private image consent is missing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(false)));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(screen.getByText(/foto candidate vengono inviati a OpenAI/)).toBeInTheDocument();
    const settingsLink = screen.getByRole('link', { name: /gestisci il consenso immagini nel profilo/i });
    expect(settingsLink).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conferma e genera' })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/v1/recipe-images/personal-recipe/generate?kind=private', expect.anything());
  });

  it('refreshes the server-selected image provider and keeps the Profile settings link', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(false)))
      .mockResolvedValueOnce(json({ ...status(false), selectedImageProvider: 'gemini' }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    expect(await screen.findByText(/foto candidate vengono inviati a OpenAI/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /gestisci il consenso immagini nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');

    await user.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    expect(await screen.findByText(/foto candidate vengono inviati a Google Gemini/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /gestisci il consenso immagini nel profilo/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not queue or show stale results after switching accounts', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    act(() => useAuthStore.setState({ user: { ...account, id: 'other-user' }, csrfToken: 'other-csrf' }));
    await act(async () => { resolve(json(status())); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('displays request failures and allows retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ code: 'images_disabled' }, 503)));
    render(<RecipeImageGeneration recipeId="pollo-al-limone" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('servizio immagini non è attivo sul server');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Genera immagine' })).toBeEnabled());
  });

  it('keeps generation disabled for guests', () => {
    useAuthStore.setState({ user: null, csrfToken: null });
    render(<RecipeImageGeneration />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText(/Accedi con un account verificato/)).toBeInTheDocument();
  });

  it('uses the runtime service even when the old build flag was disabled', async () => {
    vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'false');
    const fetch = vi.fn().mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({ queued: 1 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Immagine aggiunta alla coda');
  });

  it('reports an actually disabled backend and does not queue images', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ ...status(), selectedImageProvider: undefined }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Il servizio immagini non è attivo sul server.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
