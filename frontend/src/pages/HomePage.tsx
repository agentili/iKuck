import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import LocalRecipeCard from '../components/suggestions/LocalRecipeCard';
import SuggestionControls from '../components/suggestions/SuggestionControls';
import { createSeededRandom, findRecipeSuggestions } from '../domain/suggestions';
import { aggregatePantryLots } from '../domain/pantryLots';
import type { RecipeSuggestion } from '../domain/types';
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
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
  const [focusResultsTitle, setFocusResultsTitle] = useState(false);
  const resultsTitleRef = useRef<HTMLHeadingElement>(null);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const pantryLots = usePantryStore((state) => state.pantryLots);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const dietProfile = useDietProfileStore((state) => state.profile);
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

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">
          Caricamento delle tue ricette…
        </p>
      </main>
    );
  }

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

  const addMissingSuggestionToShoppingList = (suggestion: RecipeSuggestion) => {
    addMissingRecipeIngredients(suggestion.recipe, availableIngredientIds);
  };

  const isMissingSuggestionInShoppingList = (suggestion: RecipeSuggestion) => suggestion.missingIngredientIds.some((ingredientId) => (
    shoppingItems.some((item) => !item.purchased && item.ingredientId === ingredientId)
  ));

  const readySuggestions = suggestions.filter((suggestion) => suggestion.missingIngredientIds.length === 0);
  const onePurchaseSuggestions = suggestions.filter((suggestion) => suggestion.missingIngredientIds.length === 1);
  const hasPantryItems = pantryItems.length > 0;

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Ricette dalla tua cucina</p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-6xl">Cosa cuciniamo oggi?</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700 sm:text-lg">Trova ricette concrete usando gli ingredienti che hai già salvato nella dispensa.</p>
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

      <section aria-labelledby="pantry-summary-title" className="ik-surface ik-surface--quiet flex flex-col items-stretch gap-4 rounded-3xl border-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="min-w-0">
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">La tua dispensa</p>
          <h2 id="pantry-summary-title" className="mt-1 text-2xl font-black text-gray-950">
            {hasPantryItems ? 'Pronta per cercare ricette' : 'Aggiungi prima gli ingredienti'}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700 sm:text-base">
            {hasPantryItems
              ? `${pantryItems.length} ${pantryItems.length === 1 ? 'ingrediente salvato' : 'ingredienti salvati'} nella sezione Dispensa.`
              : 'Inserisci ciò che hai in casa nella sezione Dispensa, poi torna qui per cercare una ricetta.'}
          </p>
        </div>
        <Link to="/pantry" className="ik-button-secondary inline-flex min-h-11 w-full items-center justify-center whitespace-normal border-2 px-4 py-2 text-center font-bold leading-tight hover:bg-white sm:w-auto sm:shrink-0 sm:whitespace-nowrap">
          {hasPantryItems ? 'Gestisci la dispensa' : 'Apri la dispensa'}
        </Link>
      </section>

      <div className="mt-5">
        <SuggestionControls allowOneMissing={allowOneMissing} disabled={!hasPantryItems} onAllowOneMissingChange={setAllowOneMissing} onSearch={() => search()} />
        {!hasPantryItems && (
          <p role="status" className="mt-3 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950">
            Aggiungi almeno un ingrediente nella dispensa per iniziare la ricerca.
          </p>
        )}
      </div>

      <section aria-labelledby="results-title" aria-live="polite" aria-atomic="false" className="mt-8">
        {hasSearched && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="results-title" ref={resultsTitleRef} tabIndex={-1} className="text-3xl font-black text-gray-950">Ricette per te</h2>
              <p className="mt-1 text-gray-600">Scelte usando quello che hai indicato nella dispensa.</p>
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
                <p className="text-gray-700">Puoi aggiungere altri ingredienti nella sezione Dispensa.</p>
                <Link to="/pantry" className="mt-3 inline-flex min-h-11 items-center rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Gestisci la dispensa</Link>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
