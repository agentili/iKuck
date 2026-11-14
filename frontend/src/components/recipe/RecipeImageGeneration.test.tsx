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

  it('requires explicit image consent for the actual image provider before private dispatch', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(false))).mockResolvedValueOnce(json(status(false)))
      .mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json({ queued: 1 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Genera immagine' }));
    expect(screen.getByText(/foto candidate vengono inviati a OpenAI/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Conferma e genera' });
    expect(confirm).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('checkbox'));
    await user.click(confirm);
    await screen.findByRole('status');
    expect(fetch.mock.calls[2][0]).toBe('/v1/ai-recipes/consent');
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ enabled: true, expectedRevision: '2026-11-01T00:00:00Z', imageProvider: 'openai', imagePolicyVersion: 'recipe-images-v1' });
    expect(fetch.mock.calls[3][0]).toBe('/v1/recipe-images/personal-recipe/generate?kind=private');
  });

  it('requires a new confirmation when the image provider changes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(false)))
      .mockResolvedValueOnce(json({ ...status(false), selectedImageProvider: 'gemini' }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Genera tutte le immagini' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Conferma e genera' }));
    expect(await screen.findByText(/foto candidate vengono inviati a Google Gemini/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
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
    expect(await screen.findByRole('alert')).toHaveTextContent('servizio immagini non è disponibile');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Genera immagine' })).toBeEnabled());
  });

  it('keeps generation disabled for guests and when the service is switched off', () => {
    useAuthStore.setState({ user: null, csrfToken: null });
    const view = render(<RecipeImageGeneration />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText(/Accedi con un account verificato/)).toBeInTheDocument();
    vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'false');
    view.rerender(<RecipeImageGeneration />);
    expect(screen.getByText('Il servizio immagini non è attivo.')).toBeInTheDocument();
  });
});
