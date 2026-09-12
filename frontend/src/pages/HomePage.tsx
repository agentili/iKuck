import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import AccountPanel from '../components/account/AccountPanel';
import IngredientChip from '../components/pantry/IngredientChip';
import IngredientInput from '../components/pantry/IngredientInput';
import IngredientSuggestions from '../components/pantry/IngredientSuggestions';
import StaplesPanel from '../components/pantry/StaplesPanel';
import LocalRecipeCard from '../components/suggestions/LocalRecipeCard';
import SuggestionControls from '../components/suggestions/SuggestionControls';
import { findHelpfulIngredients, findRecipeSuggestions } from '../domain/suggestions';
import type { IngredientDefinition, ParsedIngredient, RecipeSuggestion } from '../domain/types';
import { hydratePantryStore, usePantryStore } from '../store/localPantryStore';

export default function HomePage() {
  const hasHydrated = usePantryStore((state) => state.hasHydrated);
  const [hasSearched, setHasSearched] = useState(false);
  const [allowOneMissing, setAllowOneMissing] = useState(false);
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const addIngredients = usePantryStore((state) => state.addIngredients);
  const removeIngredient = usePantryStore((state) => state.removeIngredient);
  const toggleStaple = usePantryStore((state) => state.toggleStaple);
  const getAvailableIngredientIds = usePantryStore((state) => state.getAvailableIngredientIds);

  useEffect(() => {
    void hydratePantryStore();
  }, []);

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">
          Caricamento della tua dispensa…
        </p>
      </main>
    );
  }

  const suggestedIngredients = findHelpfulIngredients(getAvailableIngredientIds(), 5);

  const clearResults = () => {
    setHasSearched(false);
    setSuggestions([]);
  };

  const handleAdd = (items: ParsedIngredient[]) => {
    addIngredients(items);
    clearResults();
  };

  const handleSuggestedIngredient = (ingredient: IngredientDefinition) => {
    addIngredients([{ id: ingredient.id, label: ingredient.label, known: true }]);
    clearResults();
  };

  const handleRemove = (id: string) => {
    removeIngredient(id);
    clearResults();
  };

  const handleToggleStaple = (id: string) => {
    toggleStaple(id);
    clearResults();
  };

  const search = (extended = allowOneMissing) => {
    setSuggestions(findRecipeSuggestions({ availableIds: getAvailableIngredientIds(), allowOneMissing: extended }));
    setHasSearched(true);
  };

  const tryExtended = () => {
    setAllowOneMissing(true);
    search(true);
  };

  const helpfulIngredients = hasSearched && suggestions.length === 0
    ? findHelpfulIngredients(getAvailableIngredientIds(), 3)
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

      <section aria-labelledby="pantry-title" className="space-y-5 rounded-3xl border-2 border-gray-200 bg-gray-50 p-4 sm:p-6">
        <div>
          <h2 id="pantry-title" className="text-2xl font-bold text-gray-950">La tua dispensa</h2>
          <p className="mt-1 text-gray-600">Basta il nome: niente quantità o scadenze.</p>
        </div>
        <IngredientInput onAdd={handleAdd} />
        <IngredientSuggestions ingredients={suggestedIngredients} onAdd={handleSuggestedIngredient} />
        {pantryItems.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-4 text-gray-500">Aggiungi almeno un ingrediente per cercare una ricetta.</p>
        ) : (
          <ul aria-label="La tua dispensa" className="flex flex-wrap gap-2">
            {pantryItems.map((item) => <IngredientChip key={item.id} item={item} onRemove={handleRemove} />)}
          </ul>
        )}
        <StaplesPanel stapleIds={stapleIds} onToggle={handleToggleStaple} />
        <SuggestionControls allowOneMissing={allowOneMissing} disabled={pantryItems.length === 0} onAllowOneMissingChange={setAllowOneMissing} onSearch={() => search()} />
      </section>

      <section aria-live="polite" aria-atomic="false" className="mt-10">
        {hasSearched && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-3xl font-black text-gray-950">Ricette per te</h2>
              <p className="mt-1 text-gray-600">Scelte usando quello che hai indicato.</p>
            </div>
            {suggestions.length > 0 && (
              <button type="button" onClick={() => search()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-4 py-2 font-semibold text-gray-800 hover:border-gray-900">
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
