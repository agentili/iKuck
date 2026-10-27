import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STAPLE_IDS, parseIngredientInput } from '@ikuck/shared/ingredients';
import HomePage from '../pages/HomePage';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { DEFAULT_DIET_PROFILE } from '../domain/dietary';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { setActiveDataScope, setPersonalDataScope } from '../sync/scopeContext';
import { RECIPES } from '../domain/recipes';
import { getIngredient } from '@ikuck/shared/ingredients';
import { writeSavedRecipes } from '../storage/dinnerDiaryStorage';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';

const renderHome = () => render(<MemoryRouter><HomePage /></MemoryRouter>);
describe('Home opening suggestions', () => {
  beforeEach(() => {
    setActiveDataScope('guest');
    useDinnerDiaryStore.setState({ recipes: [], entries: [], drafts: [] });
    useShoppingListStore.setState({ hasHydrated: true, items: [] });
    usePantryStore.setState({ hasHydrated: true, pantryItems: [], pantryLots: [], stapleIds: [...DEFAULT_STAPLE_IDS] });
    useActivityStore.setState({ events: [], preferences: [] });
    useDietProfileStore.setState({ profile: { ...DEFAULT_DIET_PROFILE, updatedAt: '2026-10-26T00:00:00.000Z' } });
  });
  afterEach(cleanup);
  it('offers one clear action when the pantry is empty', () => {
    renderHome();
    expect(screen.getByRole('link', { name: /Aggiungi un ingrediente/ })).toHaveAttribute('href', '/pantry');
    expect(screen.queryByRole('heading', { name: 'L’idea di oggi' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Altre idee' })).not.toBeInTheDocument();
  });
  it('offers different existing recipes and retains favorite-first ranking when cycling back', async () => {
    const user = userEvent.setup();
    const available = [...new Set(RECIPES.flatMap((recipe) => recipe.ingredients.map((ingredient) => ingredient.ingredientId)))];
    usePantryStore.setState({ pantryItems: available.map((id) => ({ id, label: getIngredient(id)?.label ?? id, known: true })) });
    useActivityStore.setState({ preferences: [{ recipeId: 'pasta-tonno-pomodoro', favorite: true, rating: 5, note: null, createdAt: '', updatedAt: '' }] });
    renderHome();
    const firstTitles = screen.getAllByRole('article').map((article) => within(article).getByRole('heading').textContent);
    expect(firstTitles[0]).toBe('Pasta tonno e pomodoro');
    await user.click(screen.getByRole('button', { name: 'Altre idee' }));
    const nextTitles = screen.getAllByRole('article').map((article) => within(article).getByRole('heading').textContent);
    expect(nextTitles.every((title) => !firstTitles.includes(title))).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Idee 5–8');
    while (!screen.getByRole('status').textContent?.startsWith('Idee 1–')) {
      await user.click(screen.getByRole('button', { name: 'Altre idee' }));
    }
    expect(within(screen.getAllByRole('article')[0]).getByRole('heading')).toHaveTextContent('Pasta tonno e pomodoro');
  });

  it('opens the shopping list for an already pending ingredient and offers re-add after purchase', async () => {
    usePantryStore.setState({ pantryItems: parseIngredientInput('pasta, passata di pomodoro') });
    useActivityStore.setState({ preferences: [{ recipeId: 'pasta-tonno-pomodoro', favorite: true, rating: 5, note: null, createdAt: '', updatedAt: '' }] });
    const shoppingItem = { id: 'tuna', ingredientId: 'tuna', label: 'Tonno', quantity: null, unit: null, note: null, purchased: false, sourceRecipeId: null, createdAt: '', updatedAt: '' };
    useShoppingListStore.setState({ items: [shoppingItem] });
    renderHome();
    const article = screen.getByRole('article', { name: 'Pasta tonno e pomodoro' });
    expect(within(article).getByRole('link', { name: 'Apri lista della spesa' })).toHaveAttribute('href', '/shopping-list');
    expect(within(article).queryByRole('button', { name: /Aggiungi.*alla lista/ })).not.toBeInTheDocument();
    act(() => useShoppingListStore.setState({ items: [{ ...shoppingItem, purchased: true }] }));
    expect(within(article).getByRole('button', { name: /Aggiungi.*alla lista/ })).toBeVisible();
  });

  it('includes saved diary recipes only from the active scope and keeps their scoped detail URL', async () => {
    const recipe: SavedRecipe = { id: 'diary-special', title: 'Pasta dal diario personale', description: 'Una ricetta di casa', ingredients: [{ name: 'Pasta', ingredientId: 'pasta', amount: '100 g', optional: false, provenance: 'provided' }], steps: ['Cuoci la pasta.'], servings: 1, durationMinutes: 10, diets: null, allergens: null, suggestedFields: [], source: 'diary', authorId: null, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z' };
    await writeSavedRecipes([recipe], 'guest');
    await writeSavedRecipes([{ ...recipe, id: 'house-special', title: 'Pasta riservata alla Casa' }], 'house:other');
    usePantryStore.setState({ pantryItems: parseIngredientInput('pasta') });
    renderHome();
    expect(await screen.findByRole('link', { name: 'Apri Pasta dal diario personale' })).toHaveAttribute('href', '/recipes/diary-special?scope=guest');
    expect(screen.queryByRole('heading', { name: 'Pasta riservata alla Casa' })).not.toBeInTheDocument();
    act(() => { setActiveDataScope('house:other'); setPersonalDataScope('guest'); });
    act(() => usePantryStore.setState({ pantryItems: parseIngredientInput('pasta') }));
    expect(await screen.findByRole('link', { name: 'Apri Pasta riservata alla Casa' })).toHaveAttribute('href', '/recipes/house-special?scope=house%3Aother');
    expect(screen.queryByRole('heading', { name: 'Pasta dal diario personale' })).not.toBeInTheDocument();
  });
  it('shows recipes immediately without a search action', () => {
    usePantryStore.setState({ pantryItems: parseIngredientInput('uova, pasta, pomodoro, zucchine, ceci') });
    renderHome();
    expect(screen.getByRole('heading', { name: 'L’idea di oggi' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Apri/ }).length).toBeGreaterThan(0);
  });
  it('explains when no recipe matches the available ingredients', () => {
    usePantryStore.setState({ pantryItems: parseIngredientInput('ananas') });
    renderHome();
    expect(screen.getByText('Ci manca ancora qualcosa.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Completa la dispensa' })).toHaveAttribute('href', '/pantry');
  });
});
