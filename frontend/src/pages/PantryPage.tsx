import { ChefHat } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DietFiltersPanel from '../components/diet/DietFiltersPanel';
import IngredientChip from '../components/pantry/IngredientChip';
import IngredientInput from '../components/pantry/IngredientInput';
import IngredientSuggestions from '../components/pantry/IngredientSuggestions';
import PantryLotsPanel from '../components/pantry/PantryLotsPanel';
import StaplesPanel from '../components/pantry/StaplesPanel';
import type { IngredientDefinition, ParsedIngredient } from '../domain/types';
import { hydratePantryStore, usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import {
  persistenceDomains,
  retryPersistence,
  usePersistenceStatusStore,
  type PersistenceDomain,
  type PersistenceState,
} from '../store/persistenceStatusStore';
import { findHelpfulIngredients, createSeededRandom } from '../domain/suggestions';

const persistenceLabels: Record<PersistenceDomain, string> = {
  pantry: 'dispensa',
  'shopping-list': 'lista della spesa',
  activity: 'attività',
  diet: 'preferenze alimentari',
};

const blockingPersistenceStates: readonly PersistenceState[] = ['memory-only', 'sync-error'];

export default function PantryPage() {
  const hasHydrated = usePantryStore((state) => state.hasHydrated);
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
  const persistenceStatuses = usePersistenceStatusStore((state) => state.statuses);
  const [ingredientSuggestionSeed, setIngredientSuggestionSeed] = useState(0);
  const [dismissedIngredientSuggestionIds, setDismissedIngredientSuggestionIds] = useState<string[]>([]);

  useEffect(() => {
    void hydratePantryStore();
  }, []);

  const persistenceIssue = persistenceDomains
    .map((domain) => ({ domain, status: persistenceStatuses[domain] }))
    .find(({ status }) => blockingPersistenceStates.includes(status.state));

  const availableIngredientIds = useMemo(
    () => [...pantryItems.filter((item) => item.known).map((item) => item.id), ...stapleIds],
    [pantryItems, stapleIds],
  );
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

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Organizza la tua cucina</p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-6xl">La tua dispensa</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700 sm:text-lg">Tieni qui ingredienti, lotti, scadenze e preferenze: le ricette useranno sempre questi dati.</p>
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
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Ingredienti presenti</p>
            <h2 className="mt-1 text-2xl font-black text-gray-950">Cosa hai in casa?</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700 sm:text-base">Puoi aggiungere più ingredienti insieme: useremo solo quelli per proporti le ricette.</p>
          </div>
          <span className="rounded-full bg-sage px-3 py-1.5 text-sm font-bold text-ink">
            {pantryItems.length === 0 ? 'Dispensa vuota' : `${pantryItems.length} ${pantryItems.length === 1 ? 'ingrediente' : 'ingredienti'}`}
          </span>
        </div>
        <IngredientInput onAdd={handleAdd} />
        {pantryItems.length > 0 && (
          <ul aria-label="La tua dispensa" className="flex flex-wrap gap-2">
            {pantryItems.map((item) => <IngredientChip key={item.id} item={item} onRemove={removeIngredient} />)}
          </ul>
        )}
        {pantryItems.length === 0 && (
          <p role="status" className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950">
            La tua dispensa è ancora vuota. Inserisci un ingrediente per iniziare.
          </p>
        )}
        {pantryItems.length > 0 ? (
          <Link
            to="/"
            className="ik-button-primary inline-flex min-h-12 w-full min-w-0 flex-col items-center justify-center gap-1 px-4 py-1 text-center text-base font-bold leading-tight sm:w-auto sm:flex-row sm:gap-2 sm:py-3"
          >
            <ChefHat size={19} aria-hidden="true" />
            Vai alle ricette
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className="ik-button-primary pointer-events-none inline-flex min-h-12 w-full min-w-0 flex-col items-center justify-center gap-1 px-4 py-1 text-center text-base font-bold leading-tight opacity-45 sm:w-auto sm:flex-row sm:gap-2 sm:py-3"
          >
            <ChefHat size={19} aria-hidden="true" />
            Vai alle ricette
          </span>
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
          <DietFiltersPanel profile={dietProfile} onChange={setDietProfile} onReset={resetDietProfile} />
          {pantryItems.length > 0 && (
            <PantryLotsPanel ingredients={pantryItems} lots={pantryLots} onAddLot={addPantryLot} onRemoveLot={removePantryLot} onRestoreLot={restorePantryLot} onUpdateLot={updatePantryLot} />
          )}
          <StaplesPanel stapleIds={stapleIds} onToggle={toggleStaple} />
        </div>
      </details>
    </main>
  );
}
