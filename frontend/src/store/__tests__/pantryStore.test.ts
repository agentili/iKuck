import { DEFAULT_STAPLE_IDS } from '../../domain/ingredients';
import { usePantryStore } from '../localPantryStore';

describe('pantry store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePantryStore.getState().resetPantry();
  });

  it('starts with default staples and no pantry items', () => {
    const state = usePantryStore.getState();

    expect(state.pantryItems).toEqual([]);
    expect(state.stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
  });

  it('adds unique ingredients while preserving the first label', () => {
    usePantryStore.getState().addIngredients([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tomato', label: 'Pomodori', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('removes one pantry ingredient by id', () => {
    usePantryStore.getState().addIngredients([
      { id: 'tomato', label: 'Pomodoro', known: true },
      { id: 'tuna', label: 'Tonno', known: true },
    ]);

    usePantryStore.getState().removeIngredient('tomato');

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'tuna', label: 'Tonno', known: true },
    ]);
  });

  it('toggles a staple without affecting pantry ingredients', () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');

    expect(usePantryStore.getState().stapleIds).not.toContain('salt');
    expect(usePantryStore.getState().pantryItems).toHaveLength(1);

    usePantryStore.getState().toggleStaple('salt');
    expect(usePantryStore.getState().stapleIds).toContain('salt');
  });

  it('combines known pantry ingredients with enabled staples', () => {
    usePantryStore.getState().addIngredients([
      { id: 'pasta', label: 'Pasta', known: true },
      { id: 'custom:tempeh', label: 'Tempeh', known: false },
    ]);
    usePantryStore.getState().toggleStaple('salt');

    expect(usePantryStore.getState().getAvailableIngredientIds()).toEqual([
      'pasta',
      'water',
      'black_pepper',
      'olive_oil',
    ]);
  });

  it('persists pantry and staples across rehydration', async () => {
    usePantryStore.getState().addIngredients([{ id: 'pasta', label: 'Pasta', known: true }]);
    usePantryStore.getState().toggleStaple('salt');
    const persisted = window.localStorage.getItem('ikuck-pantry-v1');
    usePantryStore.setState({ pantryItems: [], stapleIds: [] });
    window.localStorage.setItem('ikuck-pantry-v1', persisted!);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(usePantryStore.getState().stapleIds).not.toContain('salt');
  });

  it('recovers from unreadable persisted data', async () => {
    usePantryStore.setState({ pantryItems: [], stapleIds: [...DEFAULT_STAPLE_IDS] });
    window.localStorage.setItem('ikuck-pantry-v1', '{not-json');

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([]);
    expect(usePantryStore.getState().stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
    expect(window.localStorage.getItem('ikuck-pantry-v1')).toBeNull();
  });

  it('migrates an existing iRicetto pantry to the iKuck storage key', async () => {
    const legacyPersisted = JSON.stringify({
      state: {
        pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      },
      version: 1,
    });
    usePantryStore.setState({ pantryItems: [], stapleIds: [] });
    window.localStorage.removeItem('ikuck-pantry-v1');
    window.localStorage.setItem('iricetto-pantry-v1', legacyPersisted);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(window.localStorage.getItem('ikuck-pantry-v1')).toBe(legacyPersisted);
  });
});
