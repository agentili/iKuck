import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';
import RecipeDetailPage from './RecipeDetailPage';
import { useShoppingListStore } from '../store/shoppingListStore';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';
import { useAuthStore } from '../auth/authStore';

const renderRoute = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/recipes/:recipeId" element={<RecipeDetailPage />} />
    </Routes>
  </MemoryRouter>,
);

const resetFeatureState = () => {
  usePantryStore.setState({ pantryItems: [], pantryLots: [], stapleIds: [] });
  useShoppingListStore.setState({ hasHydrated: true, items: [] });
  useActivityStore.setState({ hasHydrated: true, events: [], preferences: [] });
  useAuthStore.setState({ user: null, csrfToken: null, expiresAt: null, connection: 'unknown', isLoading: false });
};

describe('RecipeDetailPage integration', () => {
  beforeEach(() => {
    resetFeatureState();
  });

  it('loads a recipe directly from its stable url', () => {
    renderRoute('/recipes/pollo-al-limone');

    expect(screen.getByRole('heading', { name: 'Pollo al limone' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ingredienti' })).toBeInTheDocument();
    expect(screen.getByText('Petto di pollo')).toBeInTheDocument();
    expect(screen.getByText('300 g')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preparazione' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(6);
  });

  it('marks optional ingredients in the cooking details', () => {
    renderRoute('/recipes/pasta-tonno-pomodoro');

    expect(screen.getByText('1 spicchio · facoltativo')).toBeInTheDocument();
  });

  it('shows estimated nutrition and declared allergens without implying precision', () => {
    renderRoute('/recipes/pasta-tonno-pomodoro');

    expect(screen.getByText('Stima indicativa')).toBeVisible();
    expect(screen.getByText(/Allergeni dichiarati: glutine, pesce/)).toBeVisible();
  });

  it('prioritizes cooking content before experience and secondary nutrition', () => {
    renderRoute('/recipes/pasta-tonno-pomodoro');

    const ingredients = screen.getByRole('heading', { name: 'Ingredienti' });
    const preparation = screen.getByRole('heading', { name: 'Preparazione' });
    const experience = screen.getByRole('heading', { name: 'La tua esperienza' });
    const nutrition = screen.getByRole('heading', { name: 'Nutrizione stimata per porzione' });

    expect(ingredients.compareDocumentPosition(preparation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preparation.compareDocumentPosition(experience) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(experience.compareDocumentPosition(nutrition) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the singular label for one rated star', () => {
    renderRoute('/recipes/pasta-tonno-pomodoro');

    expect(screen.getByRole('button', { name: 'Valuta Pasta tonno e pomodoro: 1 stella' })).toBeInTheDocument();
  });

  it('shows a recoverable state for an unknown recipe id', () => {
    renderRoute('/recipes/not-real');

    expect(screen.getByRole('heading', { name: 'Ricetta non trovata' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Torna alla dispensa' })).toHaveAttribute('href', '/');
  });

  it('adds only missing non-optional ingredients to the shopping list', async () => {
    const user = userEvent.setup();
    usePantryStore.setState({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [],
      stapleIds: ['salt', 'olive_oil'],
    });
    renderRoute('/recipes/pasta-tonno-pomodoro');

    await user.click(screen.getByRole('button', { name: 'Aggiungi mancanti alla spesa' }));

    expect(useShoppingListStore.getState().items).toEqual([
      expect.objectContaining({ ingredientId: 'tuna', quantity: 120, unit: 'g', sourceRecipeId: 'pasta-tonno-pomodoro' }),
      expect.objectContaining({ ingredientId: 'tomato_sauce', quantity: 250, unit: 'ml', sourceRecipeId: 'pasta-tonno-pomodoro' }),
    ]);
    expect(useShoppingListStore.getState().items.some((item) => item.ingredientId === 'garlic')).toBe(false);
  });

  it('does not duplicate pending items when the recipe action is repeated', async () => {
    const user = userEvent.setup();
    renderRoute('/recipes/pasta-tonno-pomodoro');

    const action = screen.getByRole('button', { name: 'Aggiungi mancanti alla spesa' });
    await user.click(action);
    await user.click(action);

    expect(useShoppingListStore.getState().items.filter((item) => item.sourceRecipeId === 'pasta-tonno-pomodoro')).toHaveLength(5);
  });

  it('preserves an uncertain recipe amount as a note and links to the list', async () => {
    const user = userEvent.setup();
    renderRoute('/recipes/pollo-al-limone');

    await user.click(screen.getByRole('button', { name: 'Aggiungi mancanti alla spesa' }));

    expect(useShoppingListStore.getState().items).toContainEqual(expect.objectContaining({ ingredientId: 'garlic', quantity: null, unit: null, note: '1 spicchio' }));
    expect(screen.getByRole('link', { name: 'Apri la lista della spesa' })).toHaveAttribute('href', '/shopping-list');
  });

  it('records a cooking event without changing the pantry', async () => {
    const user = userEvent.setup();
    usePantryStore.setState({
      pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
      pantryLots: [],
      stapleIds: ['salt'],
    });
    const before = JSON.stringify(usePantryStore.getState());
    renderRoute('/recipes/pasta-tonno-pomodoro');

    await user.click(screen.getByRole('button', { name: 'Segna come cucinata' }));

    expect(useActivityStore.getState().events).toEqual([expect.objectContaining({
      recipeId: 'pasta-tonno-pomodoro',
      recipeTitle: 'Pasta tonno e pomodoro',
    })]);
    expect(JSON.stringify(usePantryStore.getState())).toBe(before);
    expect(screen.getByRole('status')).toHaveTextContent('Ricetta aggiunta alla cronologia.');
  });

  it('saves a favorite, rating and private note', async () => {
    const user = userEvent.setup();
    renderRoute('/recipes/pollo-al-limone');

    await user.click(screen.getByRole('button', { name: 'Aggiungi ai preferiti' }));
    await user.click(screen.getByRole('button', { name: 'Valuta Pollo al limone: 4 stelle' }));
    await user.type(screen.getByLabelText('Nota privata sulla ricetta'), 'Da rifare nel weekend');
    await user.click(screen.getByRole('button', { name: 'Salva preferenza' }));

    expect(useActivityStore.getState().getRecipePreference('pollo-al-limone')).toMatchObject({
      favorite: true,
      rating: 4,
      note: 'Da rifare nel weekend',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Preferenza salvata.');
  });

  it('lets a verified user replace the catalog estimate with a successful USDA response', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com', emailVerifiedAt: '2026-09-13T12:00:00.000Z' },
      csrfToken: 'csrf-token',
      expiresAt: '2026-10-13T12:00:00.000Z',
      connection: 'online',
      isLoading: false,
    });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ nutrition: {
      caloriesPerServing: 410,
      proteinGramsPerServing: 28,
      carbohydrateGramsPerServing: 35,
      fatGramsPerServing: 14,
      source: 'usda',
      isComplete: true,
      missingNutrients: [],
    } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);

    renderRoute('/recipes/pasta-tonno-pomodoro');
    await user.click(screen.getByRole('button', { name: 'Aggiorna stima USDA' }));

    expect(await screen.findByText('Valori USDA aggiornati')).toBeVisible();
    expect(fetch).toHaveBeenCalledWith('/v1/recipes/nutrition', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ ingredients: expect.any(Array) });
    vi.unstubAllGlobals();
  });

  it('keeps the guest detail page offline without a USDA action or network request', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    renderRoute('/recipes/pasta-tonno-pomodoro');

    expect(screen.queryByRole('button', { name: 'Aggiorna stima USDA' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
