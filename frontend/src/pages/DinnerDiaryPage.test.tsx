import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConsent } from '@ikuck/shared/contracts';
import type { DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';
import { fetchAiConsentStatus, updateAiConsent, updateDinnerAiConsent } from '../ai/aiRecipeApi';
import DinnerDiaryPage from './DinnerDiaryPage';
import { useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { setActiveDataScope } from '../sync/scopeContext';

const hydrateDinnerDiaryStoreMock = vi.hoisted(() => vi.fn());

vi.mock('../ai/aiRecipeApi', () => ({
  fetchAiConsentStatus: vi.fn(), updateAiConsent: vi.fn(), updateDinnerAiConsent: vi.fn(),
}));

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
    vi.mocked(fetchAiConsentStatus).mockReset();
    vi.mocked(updateAiConsent).mockReset();
    vi.mocked(updateDinnerAiConsent).mockReset();
    useAuthStore.setState({ user: null, csrfToken: null });
    useHouseStore.setState({ state: null });
    setActiveDataScope('guest');
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [], recipes: [], drafts: [], error: null });
  });

  it('keeps Dinner consent closed until requested, leaving the diary form available', async () => {
    const user = userEvent.setup();
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', dinnerProvider: 'gemini', updatedAt: now },
      selectedProvider: 'gemini',
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    renderPage();

    const region = await screen.findByRole('region', { name: 'Consenso per ricostruire ricette' });
    const checkbox = await screen.findByRole('checkbox', { name: /Gemini di Google.*testo della cena.*porzioni/i, hidden: true });
    const disclosure = region.querySelector('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute('open');
    expect(checkbox).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Salva cena' })).toBeVisible();
    expect(screen.getByText(/Attivo per Gemini di Google/)).toBeVisible();

    const summary = screen.getByText('Consenso AI per Dinner');
    await user.click(summary);
    expect(checkbox).toBeVisible();
    await user.click(summary);
    expect(checkbox).not.toBeVisible();
    expect(updateAiConsent).not.toHaveBeenCalled();
    expect(updateDinnerAiConsent).not.toHaveBeenCalled();
  });

  it('keeps Dinner and global revocation directly available while the consent is collapsed', async () => {
    const user = userEvent.setup();
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', dinnerProvider: 'gemini', updatedAt: now },
      selectedProvider: 'gemini',
    });
    vi.mocked(updateDinnerAiConsent).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-29T10:01:00.000Z' },
      selectedProvider: 'gemini',
    });
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-29T10:02:00.000Z' });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    renderPage();

    const disclosure = (await screen.findByRole('region', { name: 'Consenso per ricostruire ricette' })).querySelector('details');
    const revokeDinner = await screen.findByRole('button', { name: 'Revoca consenso Dinner' });
    const revokeGlobal = screen.getByRole('button', { name: 'Revoca consenso AI globale' });
    expect(disclosure).not.toHaveAttribute('open');
    expect(revokeDinner).toBeVisible();
    expect(revokeGlobal).toBeVisible();

    await user.click(revokeDinner);
    expect(updateDinnerAiConsent).toHaveBeenCalledWith(null, 'csrf-1', undefined);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoca consenso Dinner' })).not.toBeInTheDocument());
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(revokeGlobal);
    expect(updateAiConsent).toHaveBeenCalledWith(false, 'csrf-1', '2026-09-29T10:01:00.000Z', undefined, undefined);
    expect(disclosure).not.toHaveAttribute('open');
  });

  it('tells guests that dinner text and servings stay on-device until verified consent', () => {
    renderPage();

    expect(screen.getByText(/Come ospite, le cene restano sul dispositivo/)).toHaveTextContent(/non inviamo testo, porzioni o note/i);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI|Gemini di Google/)).not.toBeInTheDocument();
    expect(fetchAiConsentStatus).not.toHaveBeenCalled();
  });

  it('requires provider-specific Dinner approval even when Home consent is enabled', async () => {
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', updatedAt: now },
      selectedProvider: 'gemini',
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: 'account:user-1', value: existingEntry }], recipes: [], drafts: [], error: null });

    renderPage();

    const globalConsent = await screen.findByRole('checkbox', { name: /ingredienti della dispensa/i });
    expect(globalConsent).toBeChecked();
    const dinnerConsent = screen.getByRole('checkbox', { name: /Gemini di Google.*testo della cena.*porzioni/i });
    expect(dinnerConsent).not.toBeChecked();
    const providerName = screen.getByText('Gemini di Google', { selector: 'strong' });
    expect(providerName.closest('p')).toHaveTextContent(/testo originale della cena.*porzioni/i);
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepara bozze ricetta' })).not.toBeInTheDocument();
  });

  it('requires explicit Home reconsent after the selected provider changes and discloses every Home field', async () => {
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', dinnerProvider: 'openai', updatedAt: now } as never,
      selectedProvider: 'gemini',
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');

    renderPage();

    const globalConsent = await screen.findByRole('checkbox', { name: /ingredienti della dispensa/i });
    expect(globalConsent).not.toBeChecked();
    expect(globalConsent).toHaveAccessibleName(expect.stringContaining('Gemini di Google'));
    expect(globalConsent).toHaveAccessibleName(expect.stringContaining('ingredienti della dispensa'));
    expect(globalConsent).toHaveAccessibleName(expect.stringContaining('profilo alimentare'));
    expect(globalConsent).toHaveAccessibleName(expect.stringContaining('ricette AI salvate o proposte'));
    const homeDisclosure = globalConsent.closest('label')?.parentElement;
    expect(homeDisclosure).toHaveTextContent('Per Home soltanto, inviamo a Gemini di Google');
    expect(homeDisclosure).toHaveTextContent('dieta scelta, allergeni esclusi, calorie massime e proteine minime');
    expect(homeDisclosure).toHaveTextContent('titoli e nomi/quantità degli ingredienti delle ricette AI salvate o già proposte');
    expect(homeDisclosure).toHaveTextContent('vincoli di generazione, attualmente vuoto');
    expect(screen.getByRole('checkbox', { name: /Gemini di Google.*testo della cena.*porzioni/i })).not.toBeChecked();
  });

  it.each([
    { provider: 'openai' as const, name: 'OpenAI', otherName: 'Gemini di Google' },
    { provider: 'gemini' as const, name: 'Gemini di Google', otherName: 'OpenAI' },
  ])('discloses device-only Dinner draft storage when $name is selected', async ({ provider, name, otherName }) => {
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: provider, updatedAt: now },
      selectedProvider: provider,
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');

    renderPage();

    const providerName = await screen.findByText(name, { selector: 'strong' });
    const disclosure = providerName.closest('p');
    expect(disclosure).toHaveTextContent(/le bozze restano modificabili e conservate solo su questo dispositivo/i);
    expect(disclosure).toHaveTextContent(/finché non le confermi o le scarti/i);
    expect(disclosure).toHaveTextContent(/non vengono salvate sul server come ricette/i);
    expect(screen.queryByText(otherName)).not.toBeInTheDocument();
  });

  it('requires explicit global and provider-specific consent before enabling dinner reconstruction', async () => {
    const user = userEvent.setup();
    const consent: AiConsent = { enabled: false, updatedAt: '2026-09-29T10:00:00.000Z' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent, selectedProvider: 'openai' });
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: true, homeProvider: 'openai', updatedAt: '2026-09-29T10:05:00.000Z' });
    vi.mocked(updateDinnerAiConsent).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', dinnerProvider: 'openai', updatedAt: '2026-09-29T10:06:00.000Z' },
      selectedProvider: 'openai',
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: '2026-09-28T10:00:00.000Z' } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    await waitFor(() => expect(useDinnerDiaryStore.getState().hasHydrated).toBe(true));
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: 'account:user-1', value: existingEntry }], recipes: [], drafts: [], error: null });
    renderPage();

    const globalConsent = await screen.findByRole('checkbox', { name: /ingredienti della dispensa/i });
    expect(globalConsent).not.toBeChecked();
    await user.click(globalConsent);
    await user.click(screen.getByRole('button', { name: 'Salva consenso AI globale' }));
    await waitFor(() => expect(updateAiConsent).toHaveBeenCalledWith(true, 'csrf-1', consent.updatedAt, undefined, 'openai'));

    const dinnerConsent = screen.getByRole('checkbox', { name: /OpenAI.*testo della cena.*porzioni/i });
    expect(dinnerConsent).not.toBeChecked();
    await user.click(dinnerConsent);
    await user.click(screen.getByRole('button', { name: 'Salva consenso Dinner' }));

    await waitFor(() => expect(updateDinnerAiConsent).toHaveBeenCalledWith('openai', 'csrf-1', '2026-09-29T10:05:00.000Z'));
    expect(await screen.findByRole('button', { name: 'Prepara bozze ricetta' })).toBeVisible();
  });

  it('refreshes Dinner consent after a stale provider-grant conflict', async () => {
    const user = userEvent.setup();
    const initialRevision = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus)
      .mockResolvedValueOnce({ consent: { enabled: true, updatedAt: initialRevision }, selectedProvider: 'openai' })
      .mockResolvedValueOnce({ consent: { enabled: true, updatedAt: '2026-09-29T10:02:00.000Z' }, selectedProvider: 'openai' });
    vi.mocked(updateDinnerAiConsent).mockRejectedValueOnce(
      new ApiClientError(409, 'ai_consent_revision_conflict', 'Consent changed'),
    );
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: initialRevision } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    renderPage();

    const dinnerConsent = await screen.findByRole('checkbox', { name: /OpenAI.*testo della cena.*porzioni/i });
    await user.click(dinnerConsent);
    await user.click(screen.getByRole('button', { name: 'Salva consenso Dinner' }));

    expect(updateDinnerAiConsent).toHaveBeenCalledWith('openai', 'csrf-1', initialRevision);
    expect(await screen.findByRole('alert')).toHaveTextContent(/aggiornato lo stato/i);
    expect(fetchAiConsentStatus).toHaveBeenCalledTimes(2);
    expect(dinnerConsent).not.toBeChecked();
  });

  it('shows editing controls on another author’s house dinner for a current member', async () => {
    const houseScope = 'house:home-1';
    const member = { id: 'user-2', emailVerifiedAt: '2026-09-28T10:00:00.000Z' };
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: false, updatedAt: '2026-09-28T10:00:00.000Z' }, selectedProvider: 'openai' });
    useAuthStore.setState({ user: member as never, csrfToken: 'csrf-2' });
    useHouseStore.setState({ state: {
      house: { id: 'home-1', name: 'Casa', createdAt: '2026-09-28T10:00:00.000Z' },
      membership: { role: 'member', joinedAt: '2026-09-28T10:00:00.000Z' }, members: [],
    } });
    setActiveDataScope(houseScope);
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [{ scope: houseScope, value: { ...existingEntry, authorId: 'user-1' } }] });

    renderPage();

    expect(screen.getByRole('button', { name: /Modifica cena del/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Elimina cena del/ })).toBeVisible();
  });

  it('does not display account-only dinner records after entering a house', () => {
    const now = '2026-09-28T10:00:00.000Z';
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: { enabled: false, updatedAt: now }, selectedProvider: 'openai' });
    useHouseStore.setState({ state: {
      house: { id: 'home-1', name: 'Casa', createdAt: now },
      membership: { role: 'member', joinedAt: now }, members: [],
    } });
    setActiveDataScope('house:home-1');
    useDinnerDiaryStore.setState({ hasHydrated: true, entries: [
      { scope: 'account:user-1', value: { ...existingEntry, id: 'old-personal', text: 'Only in account' } },
      { scope: 'house:home-1', value: { ...existingEntry, id: 'current-house', text: 'Only in house' } },
    ] });

    renderPage();

    expect(screen.queryByText('Only in account')).not.toBeInTheDocument();
    expect(screen.getByText('Only in house')).toBeVisible();
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

  it.each([
    { provider: 'openai' as const, name: 'OpenAI' },
    { provider: 'gemini' as const, name: 'Gemini di Google' },
  ])('labels Home-only data separately and limits Dinner disclosure to text and servings for $name', async ({ provider, name }) => {
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: provider, dinnerProvider: provider, updatedAt: now },
      selectedProvider: provider,
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    renderPage();

    const disclosure = await screen.findByRole('region', { name: 'Consenso per ricostruire ricette' });
    const dinnerDisclosure = Array.from(disclosure.querySelectorAll('p')).find((paragraph) => paragraph.textContent?.startsWith('La ricostruzione invia esclusivamente'));
    if (dinnerDisclosure === undefined) throw new Error('Dinner disclosure paragraph was not rendered');
    expect(dinnerDisclosure).toHaveTextContent(new RegExp(`invia esclusivamente a ${name} il testo originale della cena e le porzioni indicate`, 'i'));
    expect(dinnerDisclosure).toHaveTextContent(/non invia la nota/i);
    expect(dinnerDisclosure).toHaveTextContent(/non invia la nota, gli ingredienti della dispensa, il profilo alimentare o le ricette AI/i);
    expect(dinnerDisclosure.textContent).not.toMatch(/\bnull\b/i);

    const homeDisclosure = Array.from(disclosure.querySelectorAll('p')).find((paragraph) => paragraph.textContent?.startsWith('Per Home soltanto'));
    if (homeDisclosure === undefined) throw new Error('Home-only disclosure paragraph was not rendered');
    expect(homeDisclosure).toHaveTextContent(new RegExp(`${name}.*ingredienti della dispensa`, 'i'));
    expect(homeDisclosure).toHaveTextContent(/dieta scelta, allergeni esclusi, calorie massime e proteine minime/i);
    expect(homeDisclosure).toHaveTextContent(/titoli e nomi\/quantità degli ingredienti delle ricette AI/i);
    expect(homeDisclosure).not.toHaveTextContent(/Dinner invia/i);
    expect(disclosure.textContent).not.toMatch(/\bnull\b/i);
  });

  it('fails closed without implying a provider when Dinner provider status is unknown', async () => {
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'openai', dinnerProvider: 'openai', updatedAt: now } as never,
      selectedProvider: null as never,
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    renderPage();

    const disclosure = await screen.findByRole('region', { name: 'Consenso per ricostruire ricette' });
    expect(disclosure).toHaveTextContent(/Non è stato possibile verificare il provider AI attivo/i);
    expect(disclosure.textContent).not.toMatch(/\bnull\b/i);
    expect(disclosure).not.toHaveTextContent(/I dati inviati a/);
    expect(screen.queryByRole('button', { name: 'Prepara bozze ricetta' })).not.toBeInTheDocument();
  });

  it.each([
    { consent: { enabled: true, updatedAt: '2026-09-29T10:00:00.000Z' }, selectedProvider: 'openai' as const },
    { consent: { enabled: true, homeProvider: 'openai' as const, updatedAt: '2026-09-29T10:00:00.000Z' }, selectedProvider: 'gemini' as const },
  ])('lets Dinner revoke legacy or mismatched global consent without approving $selectedProvider', async ({ consent, selectedProvider }) => {
    const user = userEvent.setup();
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({ consent: consent as never, selectedProvider });
    vi.mocked(updateAiConsent).mockResolvedValue({ enabled: false, updatedAt: '2026-09-29T10:01:00.000Z' });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    renderPage();

    const globalConsent = await screen.findByRole('checkbox', { name: /ingredienti della dispensa/i });
    expect(globalConsent).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /revoca consenso AI globale/i }));

    expect(updateAiConsent).toHaveBeenCalledWith(false, 'csrf-1', '2026-09-29T10:00:00.000Z', undefined, undefined);
    expect(updateDinnerAiConsent).not.toHaveBeenCalled();
  });

  it('directly revokes an old Dinner provider marker after the selected provider changes', async () => {
    const user = userEvent.setup();
    const now = '2026-09-29T10:00:00.000Z';
    vi.mocked(fetchAiConsentStatus).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', dinnerProvider: 'openai', updatedAt: now },
      selectedProvider: 'gemini',
    });
    vi.mocked(updateDinnerAiConsent).mockResolvedValue({
      consent: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-29T10:01:00.000Z' },
      selectedProvider: 'gemini',
    });
    useAuthStore.setState({ user: { id: 'user-1', emailVerifiedAt: now } as never, csrfToken: 'csrf-1' });
    setActiveDataScope('account:user-1');
    renderPage();

    const dinnerConsent = await screen.findByRole('checkbox', { name: /Gemini di Google.*testo della cena.*porzioni/i });
    expect(dinnerConsent).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /revoca consenso Dinner/i }));

    expect(updateDinnerAiConsent).toHaveBeenCalledWith(null, 'csrf-1', undefined);
    expect(updateAiConsent).not.toHaveBeenCalled();
  });
});
