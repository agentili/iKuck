import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConsent } from '@ikuck/shared/contracts';
import type { DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { useAuthStore } from '../auth/authStore';
import { fetchAiConsent, updateAiConsent } from '../ai/aiRecipeApi';
import DinnerDiaryPage from './DinnerDiaryPage';
import { useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { setActiveDataScope } from '../sync/scopeContext';

const hydrateDinnerDiaryStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../ai/aiRecipeApi', () => ({ fetchAiConsent: vi.fn(), updateAiConsent: vi.fn() }));

vi.mock('../store/dinnerDiaryStore', async () => {
  const actual = await vi.importActual<typeof import('../store/dinnerDiaryStore')>('../store/dinnerDiaryStore');
  return { ...actual, hydrateDinnerDiaryStore: hydrateDinnerDiaryStoreMock };
});

const renderPage = () => render(<MemoryRouter><DinnerDiaryPage /></MemoryRouter>);
const existingEntry: DinnerEntry = {
  id: 'dinner-1', date: '2026-09-28', text: 'Riso con verdure', servings: 2, note: 'Con basilico',
  recipes: [], authorId: null, createdAt: '2026-09-28T18:00:00.000Z', updatedAt: '2026-09-28T18:00:00.000Z',
};

describe('DinnerDiaryPage', () => {
  beforeEach(() => {
    hydrateDinnerDiaryStoreMock.mockReset().mockResolvedValue(undefined);
    vi.mocked(fetchAiConsent).mockReset();
    vi.mocked(updateAiConsent).mockReset();
    useAuthStore.setState({ user: null, csrfToken: null });
    setActiveDataScope('guest');
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
  });

  it('asks for explicit AI consent before enabling dinner reconstruction', async () => {
    const user = userEvent.setup();
    const consent: AiConsent = { enabled: false, updatedAt: '2026-09-29T10:00:00.000Z' };
    vi.mocked(fetchAiConsent).mockResolvedValue(consent);
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, updatedAt: '2026-09-29T10:05:00.000Z' });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: '2026-09-28T10:00:00.000Z' } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    await waitFor(() => expect(useDinnerDiaryStore.getState().hasHydrated).toBe(true));
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: 'account:user-1', value: existingEntry }], recipes: [], drafts: [], error: null });
    renderPage();

    const consentCheckbox = await screen.findByRole('checkbox', { name: /testo della cena/i });
    expect(consentCheckbox).not.toBeChecked();
    await user.click(consentCheckbox);
    await user.click(screen.getByRole('button', { name: 'Salva consenso' }));

    await waitFor(() => expect(updateAiConsent).toHaveBeenCalledWith(true, 'csrf-1'));
    expect(await screen.findByRole('button', { name: 'Prepara bozze ricetta' })).toBeVisible();
  });

  it('saves a dated dinner description to the local diary', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByRole('heading', { name: 'Diario delle cene' })).toBeVisible();
    expect(screen.getByText('Non hai ancora registrato una cena.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /Com’è andata la cena\?/ }), 'Pasta con zucchine e insalata');
    fireEvent.change(screen.getByLabelText('Data della cena'), { target: { value: '2026-09-29' } });
    await user.click(screen.getByRole('button', { name: 'Salva cena' }));

    expect(await screen.findByText('Pasta con zucchine e insalata')).toBeVisible();
    expect(useDinnerDiaryStore.getState().entries).toHaveLength(1);
    expect(useDinnerDiaryStore.getState().entries[0]?.value).toMatchObject({ date: '2026-09-29', text: 'Pasta con zucchine e insalata' });
  });

  it('edits a saved dinner without dropping its existing links', async () => {
    const user = userEvent.setup();
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: 'guest', value: existingEntry }] });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Modifica cena del/ }));
    await user.clear(screen.getByRole('textbox', { name: /Com’è andata la cena\?/ }));
    await user.type(screen.getByRole('textbox', { name: /Com’è andata la cena\?/ }), 'Riso con verdure e limone');
    fireEvent.change(screen.getByLabelText('Data della cena'), { target: { value: '2026-09-27' } });
    await user.click(screen.getByRole('button', { name: 'Salva modifiche' }));

    expect(useDinnerDiaryStore.getState().entries[0]?.value).toMatchObject({
      id: existingEntry.id, text: 'Riso con verdure e limone', date: '2026-09-27', note: existingEntry.note,
    });
  });

  it('deletes a dinner independently from its saved recipe', async () => {
    const user = userEvent.setup();
    const recipe = { id: 'saved-recipe-1', title: 'Pasta al forno' } as unknown as SavedRecipe;
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: 'guest', value: existingEntry }], recipes: [{ scope: 'guest', value: recipe }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    await user.click(screen.getByRole('button', { name: /Elimina cena del/ }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(useDinnerDiaryStore.getState().entries).toHaveLength(0);
    expect(useDinnerDiaryStore.getState().recipes).toHaveLength(1);
    confirm.mockRestore();
  });

  it('rejects an empty dinner description without adding an entry', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByRole('textbox', { name: /Com’è andata la cena\?/ }), '   ');
    await user.click(screen.getByRole('button', { name: 'Salva cena' }));

    expect(useDinnerDiaryStore.getState().entries).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Scrivi cosa avete mangiato prima di salvare.');
  });
});
