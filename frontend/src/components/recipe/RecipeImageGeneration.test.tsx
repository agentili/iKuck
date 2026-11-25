import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecipeImageGeneration from './RecipeImageGeneration';
import { useAuthStore } from '../../auth/authStore';
import { setActiveDataScope } from '../../sync/scopeContext';

const account = { id: 'image-user', email: 'images@example.com', emailVerifiedAt: '2026-11-01T00:00:00Z' };
const status = (enabled = true, imagePolicyVersion = 'recipe-images-v3') => ({
  consent: {
    enabled,
    updatedAt: '2026-11-01T00:00:00Z',
    ...(enabled ? { imageProvider: 'openai', imagePolicyVersion } : {}),
  },
  selectedProvider: 'gemini',
  selectedImageProvider: 'openai',
});
const json = (data: unknown, code = 200) => new Response(JSON.stringify(data), { status: code });

beforeEach(() => {
  useAuthStore.setState({ user: account, csrfToken: 'image-csrf' });
  setActiveDataScope('account:image-user');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('RecipeImageGeneration', () => {
  it('shows one recipe action and dispatches only after the visible catalog button is clicked', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ queued: 1 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="pollo-al-limone" />);

    const generateButton = screen.getByRole('button', { name: 'Genera immagine' });
    expect(generateButton).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Genera tutte le immagini' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(generateButton);

    expect(await screen.findByRole('status')).toHaveTextContent('Immagine aggiunta alla coda');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/v1/recipe-images/pollo-al-limone/generate?kind=catalog', expect.objectContaining({
      method: 'POST',
      headers: { 'x-csrf-token': 'image-csrf' },
    }));
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

  it('shows the exact OpenAI disclosure and Profile link when private image consent is missing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(false)));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(screen.getByText(/inviamo a OpenAI soltanto il titolo della ricetta e i nomi degli ingredienti/i)).toBeVisible();
    expect(screen.getByText(/Quantità, descrizione, passaggi, profilo alimentare e dispensa non vengono inviati/i)).toBeVisible();
    expect(screen.queryByText(/Wikimedia Commons|foto candidate|Gemini/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /gestisci il consenso immagini nel profilo/i })).toHaveAttribute('href', '/profile#ai-consent-settings');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conferma e genera' })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/v1/recipe-images/personal-recipe/generate?kind=private', expect.anything());
  });

  it('requires a fresh v3 grant before sending a private recipe with a legacy v2 grant', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(status(true, 'recipe-images-v2')));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(screen.getByText(/inviamo a OpenAI soltanto il titolo della ricetta e i nomi degli ingredienti/i)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/v1/recipe-images/personal-recipe/generate?kind=private', expect.anything());
  });

  it('sends one private request only after the matching OpenAI v3 grant is confirmed', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(status()))
      .mockResolvedValueOnce(json({ queued: 1 }, 202));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Immagine aggiunta alla coda');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2, '/v1/recipe-images/personal-recipe/generate?kind=private', expect.objectContaining({
      method: 'POST',
      headers: { 'x-csrf-token': 'image-csrf' },
    }));
  });

  it('fails closed for a stale Gemini image provider', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({
      ...status(true, 'recipe-images-v3'),
      consent: { enabled: true, imageProvider: 'gemini', imagePolicyVersion: 'recipe-images-v3', updatedAt: '2026-11-01T00:00:00Z' },
      selectedImageProvider: 'gemini',
    }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Il servizio immagini non è attivo sul server.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/v1/recipe-images/personal-recipe/generate?kind=private', expect.anything());
  });

  it('does not queue or show stale results after switching accounts', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));
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
    render(<RecipeImageGeneration recipeId="pollo-al-limone" />);
    expect(screen.getByRole('button', { name: 'Genera immagine' })).toBeDisabled();
    expect(screen.getByText(/Accedi con un account verificato/)).toBeInTheDocument();
  });

  it.each([
    ['null', { ...status(), selectedImageProvider: null }],
    ['omitted', { ...status(), selectedImageProvider: undefined }],
  ])('fails closed for private dispatch when the image provider is %s', async (_availability, response) => {
    const fetch = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal('fetch', fetch);
    render(<RecipeImageGeneration recipeId="personal-recipe" />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera immagine' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Il servizio immagini non è attivo sul server.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/v1/recipe-images/personal-recipe/generate?kind=private', expect.anything());
  });
});
