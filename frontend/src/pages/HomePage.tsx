import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import IngredientChip from '../components/pantry/IngredientChip';
import IngredientInput from '../components/pantry/IngredientInput';
import IngredientSuggestions from '../components/pantry/IngredientSuggestions';
import DietFiltersPanel from '../components/diet/DietFiltersPanel';
import PantryLotsPanel from '../components/pantry/PantryLotsPanel';
import StaplesPanel from '../components/pantry/StaplesPanel';
import LocalRecipeCard from '../components/suggestions/LocalRecipeCard';
import SuggestionControls from '../components/suggestions/SuggestionControls';
import { createSeededRandom, findHelpfulIngredients, findRecipeSuggestions } from '../domain/suggestions';
import { aggregatePantryLots } from '../domain/pantryLots';
import type { IngredientDefinition, ParsedIngredient, RecipeSuggestion } from '../domain/types';
import { hydratePantryStore, usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useActivityStore } from '../store/activityStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import {
  persistenceDomains,
  retryPersistence,
  usePersistenceStatusStore,
  type PersistenceDomain,
  type PersistenceState,
} from '../store/persistenceStatusStore';

const persistenceLabels: Record<PersistenceDomain, string> = {
  pantry: 'dispensa',
  'shopping-list': 'lista della spesa',
  activity: 'attività',
  diet: 'preferenze alimentari',
};

const blockingPersistenceStates: readonly PersistenceState[] = ['memory-only', 'sync-error'];

export default function HomePage() {
  const hasHydrated = usePantryStore((state) => state.hasHydrated);
  const [hasSearched, setHasSearched] = useState(false);
  const [allowOneMissing, setAllowOneMissing] = useState(false);
  const [searchedAllowOneMissing, setSearchedAllowOneMissing] = useState(false);
  const [varietySeed, setVarietySeed] = useState(0);
  const [ingredientSuggestionSeed, setIngredientSuggestionSeed] = useState(0);
  const [dismissedIngredientSuggestionIds, setDismissedIngredientSuggestionIds] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
  const [focusResultsTitle, setFocusResultsTitle] = useState(false);
  const resultsTitleRef = useRef<HTMLHeadingElement>(null);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const pantryLots = usePantryStore((state) => state.pantryLots);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const addIngredients = usePantryStore((state) => state.addIngredients);
  const addPantryLot = usePantryStore((state) => state.addPantryLot);
  const updatePantryLot = usePantryStore((state) => state.updatePantryLot);
  const removePantryLot = usePantryStore((state) => state.removePantryLot);
  const restorePantryLot = usePantryStore((state) => state.restorePantryLot);
  const removeIngredient = usePantryStore((state) => state.removeIngredient);
  const toggleStaple = usePantryStore((state) => state.toggleStaple);
  const dietProfile = useDietProfileStore((state) => state.profile);
  const setDietProfile = useDietProfileStore((state) => state.setDietProfile);
  const resetDietProfile = useDietProfileStore((state) => state.resetDietProfile);
  const events = useActivityStore((state) => state.events);
  const preferences = useActivityStore((state) => state.preferences);
  const shoppingItems = useShoppingListStore((state) => state.items);
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const persistenceStatuses = usePersistenceStatusStore((state) => state.statuses);

  const persistenceIssue = persistenceDomains
    .map((domain) => ({ domain, status: persistenceStatuses[domain] }))
    .find(({ status }) => blockingPersistenceStates.includes(status.state));

  const availableIngredientIds = useMemo(
    () => [...pantryItems.filter((item) => item.known).map((item) => item.id), ...stapleIds],
    [pantryItems, stapleIds],
  );
  const quantitySummaries = useMemo(
    () => aggregatePantryLots(pantryLots),
    [pantryLots],
  );
  const calculatedSuggestions = useMemo(() => {
    if (!hasSearched) return [];
    return findRecipeSuggestions({
      availableIds: availableIngredientIds,
      allowOneMissing: searchedAllowOneMissing,
      quantitySummaries,
      dietProfile,
      events,
      preferences,
      random: createSeededRandom(varietySeed),
    });
  }, [availableIngredientIds, dietProfile, events, hasSearched, preferences, quantitySummaries, searchedAllowOneMissing, varietySeed]);

  useEffect(() => {
    void hydratePantryStore();
  }, []);

  useEffect(() => {
    if (hasSearched) setSuggestions(calculatedSuggestions);
  }, [calculatedSuggestions, hasSearched]);

  useEffect(() => {
    if (!focusResultsTitle || !hasSearched) return;
    resultsTitleRef.current?.focus();
    setFocusResultsTitle(false);
  }, [focusResultsTitle, hasSearched]);

  const suggestedIngredients = useMemo(
    () => findHelpfulIngredients(availableIngredientIds, 5, {
      excludedIds: dismissedIngredientSuggestionIds,
      random: ingredientSuggestionSeed === 0 ? undefined : createSeededRandom(ingredientSuggestionSeed),
    }),
    [availableIngredientIds, dismissedIngredientSuggestionIds, ingredientSuggestionSeed],
  );

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">
          Caricamento della tua dispensa…
        </p>
      </main>
    );
  }

  const handleAdd = (items: ParsedIngredient[]) => {
    addIngredients(items);
  };

  const handleSuggestedIngredient = (ingredient: IngredientDefinition) => {
    addIngredients([{ id: ingredient.id, label: ingredient.label, known: true }]);
  };

  const refreshIngredientSuggestions = () => {
    setIngredientSuggestionSeed((seed) => seed + 1);
    setDismissedIngredientSuggestionIds([]);
  };

  const dismissIngredientSuggestion = (id: string) => {
    setDismissedIngredientSuggestionIds((current) => current.includes(id) ? current : [...current, id]);
  };

  const handleRemove = (id: string) => {
    removeIngredient(id);
  };

  const addMissingSuggestionToShoppingList = (suggestion: RecipeSuggestion) => {
    addMissingRecipeIngredients(suggestion.recipe, availableIngredientIds);
  };

  const isMissingSuggestionInShoppingList = (suggestion: RecipeSuggestion) => suggestion.missingIngredientIds.some((ingredientId) => (
    shoppingItems.some((item) => !item.purchased && item.ingredientId === ingredientId)
  ));

  const handleToggleStaple = (id: string) => {
    toggleStaple(id);
  };

  const handleDietProfileChange = (profile: Parameters<typeof setDietProfile>[0]) => {
    setDietProfile(profile);
  };

  const handleDietProfileReset = () => {
    resetDietProfile();
  };

  const calculateSuggestions = (seed: number, extended: boolean): RecipeSuggestion[] => findRecipeSuggestions({
    availableIds: availableIngredientIds,
    allowOneMissing: extended,
    quantitySummaries,
    dietProfile,
    events,
    preferences,
    random: createSeededRandom(seed),
  });

  const search = (extended = allowOneMissing) => {
    setSearchedAllowOneMissing(extended);
    setSuggestions(calculateSuggestions(varietySeed, extended));
    setHasSearched(true);
    setFocusResultsTitle(true);
  };

  const tryExtended = () => {
    setAllowOneMissing(true);
    search(true);
  };

  const refreshSuggestions = () => {
    const nextSeed = varietySeed + 1;
    setVarietySeed(nextSeed);
    setSuggestions(calculateSuggestions(nextSeed, searchedAllowOneMissing));
  };

  const helpfulIngredients = hasSearched && suggestions.length === 0
    ? findHelpfulIngredients(availableIngredientIds, 3)
    : [];
  const readySuggestions = suggestions.filter((suggestion) => suggestion.missingIngredientIds.length === 0);
  const onePurchaseSuggestions = suggestions.filter((suggestion) => suggestion.missingIngredientIds.length === 1);

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Ricette dalla tua dispensa</p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-6xl">Cosa c’è in dispensa?</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700 sm:text-lg">Aggiungi quello che hai: ti proponiamo ricette concrete, senza perdere tempo.</p>
      </header>

      {persistenceIssue !== undefined && (
        <div role="alert" className="mb-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
          <p>
            {persistenceIssue.status.state === 'memory-only'
              ? `Le modifiche alla ${persistenceLabels[persistenceIssue.domain]} sono disponibili solo in memoria.`
              : `La sincronizzazione della ${persistenceLabels[persistenceIssue.domain]} non è riuscita.`}
            {' '}Puoi riprovare quando vuoi.
          </p>
          <button type="button" onClick={() => void retryPersistence(persistenceIssue.domain)} className="min-h-10 rounded-xl border-2 border-amber-700 px-3 py-1.5 font-bold text-amber-900 hover:bg-amber-100">Riprova</button>
        </div>
      )}

      <section aria-label="La tua dispensa" className="ik-surface ik-pantry-workbench space-y-4 rounded-3xl border-2 border-emerald-200 bg-white p-4 shadow-sm sm:space-y-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">La tua dispensa</p>
            <h2 id="pantry-title" className="mt-1 text-2xl font-black text-gray-950">Cosa hai in casa?</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700 sm:text-base">Puoi aggiungere più ingredienti insieme: useremo solo quelli per proporti le ricette.</p>
          </div>
          <span className="rounded-full bg-sage px-3 py-1.5 text-sm font-bold text-ink">
            {pantryItems.length === 0 ? 'Dispensa vuota' : `${pantryItems.length} ${pantryItems.length === 1 ? 'ingrediente' : 'ingredienti'}`}
          </span>
        </div>
        <IngredientInput onAdd={handleAdd} />
        <SuggestionControls allowOneMissing={allowOneMissing} disabled={pantryItems.length === 0} onAllowOneMissingChange={setAllowOneMissing} onSearch={() => search()} />
        {pantryItems.length > 0 && (
          <ul aria-label="La tua dispensa" className="flex flex-wrap gap-2">
            {pantryItems.map((item) => <IngredientChip key={item.id} item={item} onRemove={handleRemove} />)}
          </ul>
        )}
        {pantryItems.length === 0 && (
          <p role="status" className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950">
            La tua dispensa è ancora vuota. Inserisci un ingrediente per iniziare.
          </p>
        )}
      </section>

      <section aria-labelledby="results-title" aria-live="polite" aria-atomic="false" className="mt-8">
        {hasSearched && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="results-title" ref={resultsTitleRef} tabIndex={-1} className="text-3xl font-black text-gray-950">Ricette per te</h2>
              <p className="mt-1 text-gray-600">Scelte usando quello che hai indicato.</p>
            </div>
            {suggestions.length > 0 && (
              <button type="button" onClick={refreshSuggestions} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-4 py-2 font-semibold text-gray-800 hover:border-gray-900">
                <RefreshCw size={17} aria-hidden="true" />
                Altre idee
              </button>
            )}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="space-y-7">
            {readySuggestions.length > 0 && (
              <section aria-labelledby="ready-recipes-title" className="ik-results-group ik-results-group--ready rounded-3xl border-2 border-emerald-100 bg-emerald-50/50 p-4 sm:p-5">
                <div className="mb-4 max-w-2xl">
                  <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Senza spesa</p>
                  <h3 id="ready-recipes-title" className="mt-1 text-2xl font-black text-gray-950">Pronte da cucinare</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-700 sm:text-base">Hai già tutto il necessario: scegli una ricetta e inizia.</p>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {readySuggestions.map((suggestion) => <LocalRecipeCard key={suggestion.recipe.id} suggestion={suggestion} />)}
                </div>
              </section>
            )}
            {onePurchaseSuggestions.length > 0 && (
              <section aria-labelledby="one-purchase-recipes-title" className="ik-results-group ik-results-group--one-purchase rounded-3xl border-2 border-amber-200 bg-amber-50/60 p-4 sm:p-5">
                <div className="mb-4 max-w-2xl">
                  <p className="text-sm font-bold uppercase tracking-[0.14em] text-amber-900">Un piccolo acquisto</p>
                  <h3 id="one-purchase-recipes-title" className="mt-1 text-2xl font-black text-gray-950">Con un solo acquisto</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-700 sm:text-base">Manca un solo ingrediente: aggiungilo alla lista e la ricetta è pronta.</p>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {onePurchaseSuggestions.map((suggestion) => (
                    <LocalRecipeCard
                      key={suggestion.recipe.id}
                      suggestion={suggestion}
                      missingIngredientInShoppingList={isMissingSuggestionInShoppingList(suggestion)}
                      onAddMissingIngredient={addMissingSuggestionToShoppingList}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
        {hasSearched && suggestions.length === 0 && (
          <div className="rounded-3xl border-2 border-gray-200 bg-white p-6">
            <h3 className="text-xl font-bold text-gray-950">Nessuna ricetta pronta con questi ingredienti</h3>
            {!allowOneMissing ? (
              <button type="button" onClick={tryExtended} className="mt-4 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Prova con 1 ingrediente in più</button>
            ) : (
              <div className="mt-3">
                <p className="text-gray-700">Prova ad aggiungere uno di questi ingredienti comuni:</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {helpfulIngredients.map((ingredient) => <li key={ingredient.id} className="rounded-full bg-amber-100 px-3 py-1.5 font-semibold text-amber-950">{ingredient.label}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <details className="ik-disclosure ik-disclosure--ideas mt-7 rounded-3xl border-2 border-emerald-100 bg-emerald-50/50 p-4 sm:p-5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
          <span className="font-black text-gray-950">Idee per ampliare la dispensa</span>
          <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-emerald-900">Facoltativo</span>
        </summary>
        <div className="border-t border-emerald-100 pt-4">
          <IngredientSuggestions
            ingredients={suggestedIngredients}
            onAdd={handleSuggestedIngredient}
            onDismiss={dismissIngredientSuggestion}
            onRefresh={refreshIngredientSuggestions}
            showEmptyState={dismissedIngredientSuggestionIds.length > 0}
          />
        </div>
      </details>

      <details className="ik-disclosure mt-4 rounded-3xl border-2 border-gray-200 bg-white p-4 sm:p-5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
          <span className="font-black text-gray-950">Personalizza la dispensa</span>
          <span className="text-sm font-medium text-gray-600">Filtri, lotti e ingredienti di base</span>
        </summary>
        <div className="mt-4 space-y-5 border-t border-gray-200 pt-4">
          <p className="max-w-2xl text-sm leading-relaxed text-gray-600">Imposta solo ciò che serve alla tua cucina: queste opzioni affinano le proposte senza rallentare la ricerca.</p>
          <DietFiltersPanel profile={dietProfile} onChange={handleDietProfileChange} onReset={handleDietProfileReset} />
          {pantryItems.length > 0 && (
            <PantryLotsPanel ingredients={pantryItems} lots={pantryLots} onAddLot={addPantryLot} onRemoveLot={removePantryLot} onRestoreLot={restorePantryLot} onUpdateLot={updatePantryLot} />
          )}
          <StaplesPanel stapleIds={stapleIds} onToggle={handleToggleStaple} />
        </div>
      </details>
    </main>
  );
}
