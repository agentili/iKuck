import { DEFAULT_STAPLE_IDS } from '../../domain/ingredients';
import { deleteLocalDatabase, readKeyValue, writeKeyValue } from '../../storage/indexedDb';
import { hydratePantryStore, usePantryStore } from '../localPantryStore';

describe('pantry store', () => {
  beforeEach(async () => {
    await deleteLocalDatabase();
    window.localStorage.clear();
    usePantryStore.setState({
      hasHydrated: false,
      pantryItems: [],
      stapleIds: [...DEFAULT_STAPLE_IDS],
    });
    await readKeyValue('pantry');
    await deleteLocalDatabase();
  });

  it('starts with default staples and no pantry items', () => {
    const state = usePantryStore.getState();

    expect(state.pantryItems).toEqual([]);
    expect(state.stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
  });

  it('exposes hydration state and becomes ready after IndexedDB rehydration', async () => {
    expect(usePantryStore.getState().hasHydrated).toBe(false);

    await hydratePantryStore();

    expect(usePantryStore.getState().hasHydrated).toBe(true);
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
    const persisted = await readKeyValue<string>('pantry');
    expect(persisted).not.toBeNull();
    usePantryStore.setState({ pantryItems: [], stapleIds: [], hasHydrated: false });
    await readKeyValue('pantry');
    await writeKeyValue('pantry', persisted!);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(usePantryStore.getState().stapleIds).not.toContain('salt');
  });

  it('recovers from unreadable persisted data', async () => {
    await writeKeyValue('pantry', '{not-json');

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([]);
    expect(usePantryStore.getState().stapleIds).toEqual([...DEFAULT_STAPLE_IDS]);
    await expect(readKeyValue<string>('pantry').then((raw) => JSON.parse(raw!))).resolves.toMatchObject({
      state: { pantryItems: [], stapleIds: [...DEFAULT_STAPLE_IDS] },
    });
  });

  it('migrates an existing iRicetto pantry to the iKuck storage key', async () => {
    const legacyPersisted = JSON.stringify({
      state: {
        pantryItems: [{ id: 'pasta', label: 'Pasta', known: true }],
        stapleIds: [...DEFAULT_STAPLE_IDS],
      },
      version: 1,
    });
    window.localStorage.removeItem('ikuck-pantry-v1');
    window.localStorage.setItem('iricetto-pantry-v1', legacyPersisted);

    await usePantryStore.persist.rehydrate();

    expect(usePantryStore.getState().pantryItems).toEqual([
      { id: 'pasta', label: 'Pasta', known: true },
    ]);
    expect(window.localStorage.getItem('iricetto-pantry-v1')).toBeNull();
    await expect(readKeyValue('pantry')).resolves.toBe(legacyPersisted);
  });
});
