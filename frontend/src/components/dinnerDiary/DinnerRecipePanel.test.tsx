import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiaryRecipeDraft, DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { useAuthStore } from '../../auth/authStore';
import { useHouseStore } from '../../house/houseStore';
import { setActiveDataScope, setPersonalDataScope } from '../../sync/scopeContext';
import { deleteLocalDatabase } from '../../storage/indexedDb';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore, waitForPendingDinnerDiaryWrites } from '../../store/dinnerDiaryStore';
import { confirmDiaryRecipe, reconstructDinnerRecipes } from '../../diary/dinnerDiaryApi';
import DinnerRecipePanel from './DinnerRecipePanel';

vi.mock('../../diary/dinnerDiaryApi', () => ({
  confirmDiaryRecipe: vi.fn(), linkDiaryRecipe: vi.fn(), reconstructDinnerRecipes: vi.fn(),
}));

const scope = 'account:user-1';
const entryValue: DinnerEntry = {
  id: 'entry-1', date: '2026-09-29', text: 'Pasta con zucchine e insalata', servings: 2, note: null,
  recipes: [], authorId: 'user-1', createdAt: '2026-09-29T18:00:00.000Z', updatedAt: '2026-09-29T18:01:00.000Z',
};
const makeDraft = (draftId: string, title: string): DiaryRecipeDraft => ({
  draftId, title, description: `${title} dalla cena`,
  ingredients: [{ name: 'Pasta', amount: '160 g', ingredientId: null, optional: false, provenance: 'provided' }],
  steps: ['Cuoci la pasta.'], servings: 2, durationMinutes: null, diets: null, allergens: null, suggestedFields: [],
});
const makeRecipe = (draft: DiaryRecipeDraft, id: string): SavedRecipe => ({
  id, title: draft.title, description: draft.description, ingredients: draft.ingredients, steps: draft.steps,
  servings: draft.servings, durationMinutes: draft.durationMinutes, diets: draft.diets, allergens: draft.allergens,
  suggestedFields: draft.suggestedFields, source: 'diary', authorId: 'user-1', createdAt: entryValue.createdAt,
  updatedAt: '2026-09-29T18:02:00.000Z',
});

const renderPanel = (entry = entryValue) => render(
  <DinnerRecipePanel entry={{ scope, value: entry }} availableRecipes={[]} manageable verified consentEnabled csrfToken="csrf-test" />,
);

beforeEach(async () => {
  vi.clearAllMocks();
  await deleteLocalDatabase();
  useAuthStore.setState({ user: { id: 'user-1' } as never });
  useHouseStore.setState({ state: null });
  setPersonalDataScope(scope); setActiveDataScope(scope);
  await hydrateDinnerDiaryStore();
  useDinnerDiaryStore.setState({
    hasHydrated: true, error: null, entries: [{ scope, value: entryValue }], recipes: [], drafts: [],
  });
});

afterEach(async () => waitForPendingDinnerDiaryWrites());

describe('DinnerRecipePanel', () => {
  it('keeps generated recipes as editable drafts until explicit confirmation', async () => {
    const user = userEvent.setup();
    const drafts = [makeDraft('draft-1', 'Pasta con zucchine'), makeDraft('draft-2', 'Insalata')];
    vi.mocked(reconstructDinnerRecipes).mockResolvedValue(drafts);
    const editedDraft = { ...drafts[0], title: 'Pasta con zucchine e ricotta' };
    const recipe = makeRecipe(editedDraft, 'saved-recipe-1');
    const confirmedEntry: DinnerEntry = {
      ...entryValue, recipes: [{ recipeId: recipe.id, title: recipe.title, source: 'diary' }], updatedAt: recipe.updatedAt,
    };
    vi.mocked(confirmDiaryRecipe).mockResolvedValue({ entry: confirmedEntry, recipe });

    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Prepara bozze ricetta' }));
    expect(await screen.findByRole('heading', { name: 'Pasta con zucchine' })).toBeInTheDocument();
    expect(useDinnerDiaryStore.getState().recipes).toEqual([]);
    expect(reconstructDinnerRecipes).toHaveBeenCalledWith({ dinnerText: entryValue.text, servings: 2 }, 'csrf-test');

    const title = screen.getAllByRole('textbox', { name: 'Titolo ricetta' })[0];
    await user.clear(title);
    await user.type(title, editedDraft.title);
    await user.click(screen.getAllByRole('button', { name: 'Conferma questa ricetta' })[0]);

    await waitFor(() => expect(confirmDiaryRecipe).toHaveBeenCalledWith('entry-1', expect.objectContaining({ title: editedDraft.title }), 'csrf-test'));
    await waitFor(() => expect(useDinnerDiaryStore.getState().recipes.map(item => item.value.id)).toEqual([recipe.id]));
    expect(useDinnerDiaryStore.getState().entries[0].value.recipes).toEqual(confirmedEntry.recipes);
    expect(useDinnerDiaryStore.getState().drafts).toEqual([expect.objectContaining({
      value: expect.objectContaining({ entryUpdatedAt: confirmedEntry.updatedAt, drafts: [drafts[1]] }),
    })]);
  });

  it('keeps the dinner saved when AI reconstruction fails', async () => {
    const user = userEvent.setup();
    vi.mocked(reconstructDinnerRecipes).mockRejectedValue(new Error('provider unavailable'));

    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Prepara bozze ricetta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/la cena resta salvata/i);
    expect(useDinnerDiaryStore.getState().entries).toEqual([{ scope, value: entryValue }]);
    expect(useDinnerDiaryStore.getState().drafts).toEqual([]);
    expect(useDinnerDiaryStore.getState().recipes).toEqual([]);
  });

  it('retains the edited draft when server confirmation fails', async () => {
    const user = userEvent.setup();
    const draft = makeDraft('draft-fail', 'Pasta');
    vi.mocked(reconstructDinnerRecipes).mockResolvedValue([draft]);
    vi.mocked(confirmDiaryRecipe).mockRejectedValue(new Error('offline'));

    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Prepara bozze ricetta' }));
    await screen.findByRole('heading', { name: 'Pasta' });
    const title = screen.getByRole('textbox', { name: 'Titolo ricetta' });
    await user.clear(title);
    await user.type(title, 'Pasta corretta');
    await user.click(screen.getByRole('button', { name: 'Conferma questa ricetta' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/confermare/i);
    expect(useDinnerDiaryStore.getState().drafts[0].value.drafts[0].title).toBe('Pasta corretta');
    expect(useDinnerDiaryStore.getState().recipes).toEqual([]);
  });
});
