import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import RecipeDetailPage from './RecipeDetailPage';
import { useShoppingListStore } from '../store/shoppingListStore';
import { usePantryStore } from '../store/localPantryStore';
import { useActivityStore } from '../store/activityStore';

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
});
