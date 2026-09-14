import { useEffect, useMemo, useState } from 'react';
import { Clock3, RefreshCw, ShoppingCart, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import AccountPanel from '../components/account/AccountPanel';
import AiRecipePanel from '../components/ai/AiRecipePanel';
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
import { useAuthStore } from '../auth/authStore';
import { useActivityStore } from '../store/activityStore';
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
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const pantryLots = usePantryStore((state) => state.pantryLots);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const addIngredients = usePantryStore((state) => state.addIngredients);
  const addPantryLot = usePantryStore((state) => state.addPantryLot);
  const updatePantryLot = usePantryStore((state) => state.updatePantryLot);
  const removePantryLot = usePantryStore((state) => state.removePantryLot);
  const removeIngredient = usePantryStore((state) => state.removeIngredient);
  const toggleStaple = usePantryStore((state) => state.toggleStaple);
  const dietProfile = useDietProfileStore((state) => state.profile);
  const setDietProfile = useDietProfileStore((state) => state.setDietProfile);
  const resetDietProfile = useDietProfileStore((state) => state.resetDietProfile);
  const events = useActivityStore((state) => state.events);
  const preferences = useActivityStore((state) => state.preferences);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
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

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">
          Caricamento della tua dispensa…
        </p>
      </main>
    );
  }

  const suggestedIngredients = findHelpfulIngredients(availableIngredientIds, 5);

  const handleAdd = (items: ParsedIngredient[]) => {
    addIngredients(items);
  };

  const handleSuggestedIngredient = (ingredient: IngredientDefinition) => {
    addIngredients([{ id: ingredient.id, label: ingredient.label, known: true }]);
  };

  const handleRemove = (id: string) => {
    removeIngredient(id);
  };

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

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 max-w-3xl">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1.5 text-sm font-semibold text-emerald-900">
          <Sparkles size={16} aria-hidden="true" />
          La tua cucina, senza sprechi
        </p>
        <h1 className="text-4xl font-black leading-tight text-gray-950 sm:text-6xl">Cosa c’è in dispensa?</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-gray-600">Scrivi gli ingredienti che hai. Alle ricette pensiamo noi.</p>
      </header>

      <div className="mb-6 max-w-3xl">
        <AccountPanel />
      </div>

      {persistenceIssue !== undefined && (
        <div role="alert" className="mb-6 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
          <p>
            {persistenceIssue.status.state === 'memory-only'
              ? `Le modifiche alla ${persistenceLabels[persistenceIssue.domain]} sono disponibili solo in memoria.`
              : `La sincronizzazione della ${persistenceLabels[persistenceIssue.domain]} non è riuscita.`}
            {' '}Puoi riprovare quando vuoi.
          </p>
          <button type="button" onClick={() => void retryPersistence(persistenceIssue.domain)} className="min-h-10 rounded-xl border-2 border-amber-700 px-3 py-1.5 font-bold text-amber-900 hover:bg-amber-100">Riprova</button>
        </div>
      )}

      <section aria-labelledby="pantry-title" className="space-y-5 rounded-3xl border-2 border-gray-200 bg-gray-50 p-4 sm:p-6">
        <div>
          <h2 id="pantry-title" className="text-2xl font-bold text-gray-950">La tua dispensa</h2>
          <p className="mt-1 text-gray-600">Basta il nome: quantità e scadenze sono opzionali.</p>
        </div>
        <IngredientInput onAdd={handleAdd} />
        <IngredientSuggestions ingredients={suggestedIngredients} onAdd={handleSuggestedIngredient} />
        <DietFiltersPanel profile={dietProfile} onChange={handleDietProfileChange} onReset={handleDietProfileReset} />
        <div className="flex flex-wrap gap-3">
          <Link to="/shopping-list" className="inline-flex min-h-11 w-fit items-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-800 hover:border-gray-900">
            <ShoppingCart size={17} aria-hidden="true" /> Lista della spesa
          </Link>
          <Link to="/activity" className="inline-flex min-h-11 w-fit items-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-3 py-2 text-sm font-bold text-gray-800 hover:border-gray-900">
            <Clock3 size={17} aria-hidden="true" /> Attività
          </Link>
        </div>
        {pantryItems.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-4 text-gray-500">Aggiungi almeno un ingrediente per cercare una ricetta.</p>
        ) : (
          <ul aria-label="La tua dispensa" className="flex flex-wrap gap-2">
            {pantryItems.map((item) => <IngredientChip key={item.id} item={item} onRemove={handleRemove} />)}
          </ul>
        )}
        {pantryItems.length > 0 && (
          <PantryLotsPanel ingredients={pantryItems} lots={pantryLots} onAddLot={addPantryLot} onRemoveLot={removePantryLot} onUpdateLot={updatePantryLot} />
        )}
        <StaplesPanel stapleIds={stapleIds} onToggle={handleToggleStaple} />
        <SuggestionControls allowOneMissing={allowOneMissing} disabled={pantryItems.length === 0} onAllowOneMissingChange={setAllowOneMissing} onSearch={() => search()} />
      </section>

      <AiRecipePanel
        ingredients={pantryItems.map((item) => item.label)}
        dietProfile={dietProfile}
        user={user}
        csrfToken={csrfToken}
      />

      <section aria-live="polite" aria-atomic="false" className="mt-10">
        {hasSearched && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-3xl font-black text-gray-950">Ricette per te</h2>
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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {suggestions.map((suggestion) => <LocalRecipeCard key={suggestion.recipe.id} suggestion={suggestion} />)}
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
    </main>
  );
}
