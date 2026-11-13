import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecipeImageSettings from './RecipeImageSettings';
import { apiRequest, ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { setActiveDataScope } from '../../sync/scopeContext';

vi.mock('../../api/apiClient', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/apiClient')>(), apiRequest: vi.fn(),
}));
const user = { id: 'image-user', email: 'image@example.test', emailVerifiedAt: '2026-11-13T10:00:00Z' };
beforeEach(() => {
  vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'true');
  vi.mocked(apiRequest).mockReset();
  useAuthStore.setState({ user, csrfToken: 'csrf' });
  setActiveDataScope('account:image-user');
});
describe('RecipeImageSettings', () => {
  it('explicitly queues images for the active scope and reports background storage', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ queued: 4 });
    render(<RecipeImageSettings />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera e salva le immagini delle ricette' }));
    expect(apiRequest).toHaveBeenCalledWith('/v1/recipe-images/generate-library', {
      method: 'POST', csrfToken: 'csrf', body: { scope: 'account:image-user' },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('4 immagini accodate');
  });
  it('requires image consent without enabling it implicitly', async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiClientError(403, 'ai_image_consent_required', 'Consent required'));
    render(<RecipeImageSettings />);
    await userEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conferma prima il consenso');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
  it('ignores a completed request after changing account or scope', async () => {
    let resolve!: (value: { queued: number }) => void;
    vi.mocked(apiRequest).mockReturnValue(new Promise(done => { resolve = done; }));
    render(<RecipeImageSettings />);
    await userEvent.click(screen.getByRole('button'));
    act(() => setActiveDataScope('house:another-house'));
    await act(async () => resolve({ queued: 8 }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
  it('does not dispatch when the service is disabled or the session is unverified', () => {
    vi.stubEnv('VITE_RECIPE_IMAGES_ENABLED', 'false');
    render(<RecipeImageSettings />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
