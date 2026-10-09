import { ChefHat } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import DietFiltersPanel from '../components/diet/DietFiltersPanel';
import IngredientChip from '../components/pantry/IngredientChip';
import IngredientInput from '../components/pantry/IngredientInput';
import IngredientSuggestions from '../components/pantry/IngredientSuggestions';
import PantryLotsPanel from '../components/pantry/PantryLotsPanel';
import StaplesPanel from '../components/pantry/StaplesPanel';
import type { IngredientDefinition, ParsedIngredient } from '../domain/types';
import {
  hydratePantryStore,
  recoverPantryStoreArchivedConflict,
  recoverPantryStoreConflict,
  usePantryStore,
} from '../store/localPantryStore';
import {
  readPantryConflictArchive,
  type PantrySnapshotConflictArchiveEntry,
  type PantrySnapshotConflictCopy,
} from '../storage/pantryStorage';
import { getActiveDataScope, subscribeActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { useDietProfileStore } from '../store/dietProfileStore';
import {
  persistenceDomains,
  retryPersistence,
  usePersistenceStatusStore,
  isPantrySnapshotConflictError,
  isPantrySnapshotConflictBackupError,
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

const isPantryConflictForScope = (error: unknown, scope: SyncScope): boolean => (
  isPantrySnapshotConflictError(error)
    && typeof error === 'object'
    && error !== null
    && 'scope' in error
    && error.scope === scope
);

const pantryCopySummary = (copy: PantrySnapshotConflictCopy): string => {
  const itemLabels = copy.snapshot.pantryItems.map((item) => item.label);
  const lotCount = copy.snapshot.pantryLots?.length ?? 0;
  const stapleCount = copy.snapshot.stapleIds.length;
  const stapleSummary = `${stapleCount} ${stapleCount === 1 ? 'ingrediente di base' : 'ingredienti di base'}`;
  return `${itemLabels.length} ${itemLabels.length === 1 ? 'ingrediente' : 'ingredienti'}${itemLabels.length > 0 ? `: ${itemLabels.join(', ')}` : ''}; ${lotCount} ${lotCount === 1 ? 'lotto' : 'lotti'}; ${stapleSummary}`;
};

export default function PantryPage() {
  const activeScope = useSyncExternalStore(
    (listener) => subscribeActiveDataScope(() => listener()),
    getActiveDataScope,
    getActiveDataScope,
  );
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
  const [selectedConflictCopy, setSelectedConflictCopy] = useState<{ scope: SyncScope; copyId: string } | null>(null);
  const selectedConflictCopyId = selectedConflictCopy?.scope === activeScope ? selectedConflictCopy.copyId : '';
  const [recoveryError, setRecoveryError] = useState<{ scope: SyncScope; message: string } | null>(null);
  const visibleRecoveryError = recoveryError?.scope === activeScope ? recoveryError.message : null;
  const [archiveState, setArchiveState] = useState<{
    scope: SyncScope;
    entries: PantrySnapshotConflictArchiveEntry[];
  }>(() => ({ scope: getActiveDataScope(), entries: [] }));
  const archivedConflicts = archiveState.scope === activeScope ? archiveState.entries : [];
  const [selectedArchivedCopy, setSelectedArchivedCopy] = useState<{
    scope: SyncScope;
    archiveId: string;
    copyId: string;
  } | null>(null);
  const [archiveRecoveryError, setArchiveRecoveryError] = useState<{ scope: SyncScope; message: string } | null>(null);
  const visibleArchiveRecoveryError = archiveRecoveryError?.scope === activeScope ? archiveRecoveryError.message : null;

  useEffect(() => {
    void hydratePantryStore();
  }, []);

  useEffect(() => {
    let active = true;
    const scope = activeScope;
    setArchiveState({ scope, entries: [] });
    void readPantryConflictArchive(scope).then((entries) => {
      if (active && getActiveDataScope() === scope) setArchiveState({ scope, entries });
    });
    return () => { active = false; };
  }, [activeScope]);

  const persistenceIssue = persistenceDomains
    .map((domain) => ({ domain, status: persistenceStatuses[domain] }))
    .filter(({ domain, status }) => !(domain === 'pantry'
      && isPantrySnapshotConflictError(status.error)
      && !isPantryConflictForScope(status.error, activeScope)))
    .find(({ status }) => blockingPersistenceStates.includes(status.state));
  const pantryConflict = persistenceIssue?.domain === 'pantry'
    && isPantryConflictForScope(persistenceIssue.status.error, activeScope);
  const conflictCopies = pantryConflict && typeof persistenceIssue.status.error === 'object'
    && persistenceIssue.status.error !== null && 'copies' in persistenceIssue.status.error
    && Array.isArray(persistenceIssue.status.error.copies)
    ? persistenceIssue.status.error.copies as PantrySnapshotConflictCopy[]
    : [];
  const malformedPantryConflict = pantryConflict
    && isPantrySnapshotConflictBackupError(persistenceIssue?.status.error);
  const conflictCopyCount = conflictCopies.length;

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

  const handlePantryConflictRecovery = async () => {
    const scope = activeScope;
    if (!selectedConflictCopyId || selectedConflictCopy?.scope !== scope || getActiveDataScope() !== scope) return;
    setRecoveryError(null);
    try {
      await recoverPantryStoreConflict(selectedConflictCopyId);
      if (getActiveDataScope() !== scope) return;
      setSelectedConflictCopy(null);
      const entries = await readPantryConflictArchive(scope);
      if (getActiveDataScope() === scope) setArchiveState({ scope, entries });
    } catch (error) {
      if (getActiveDataScope() !== scope) return;
      if (isPantrySnapshotConflictError(error)) setSelectedConflictCopy(null);
      setRecoveryError({
        scope,
        message: 'Il recupero non è riuscito. Il backup resta conservato e le scritture restano sospese.',
      });
    }
  };

  const handleArchivedPantryRecovery = async (archiveId: string) => {
    if (selectedArchivedCopy === null || selectedArchivedCopy.scope !== activeScope
      || selectedArchivedCopy.archiveId !== archiveId || getActiveDataScope() !== activeScope) return;
    const scope = activeScope;
    setArchiveRecoveryError(null);
    try {
      await recoverPantryStoreArchivedConflict(archiveId, selectedArchivedCopy.copyId);
      if (getActiveDataScope() !== scope) return;
      setSelectedArchivedCopy(null);
      const entries = await readPantryConflictArchive(scope);
      if (getActiveDataScope() === scope) setArchiveState({ scope, entries });
    } catch {
      if (getActiveDataScope() !== scope) return;
      setSelectedArchivedCopy(null);
      setArchiveRecoveryError({
        scope,
        message: 'Il ripristino non è riuscito. La dispensa attuale e il backup archiviato restano conservati.',
      });
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Organizza la tua cucina</p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-6xl">La tua dispensa</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700 sm:text-lg">Tieni qui ingredienti, lotti, scadenze e preferenze: le ricette useranno sempre questi dati.</p>
      </header>

      {persistenceIssue !== undefined && (
        <div role="alert" className="mb-5 max-w-3xl rounded-2xl border-2 border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {malformedPantryConflict
                ? 'Il backup della dispensa è stato conservato, ma i dati non sono leggibili. Non è disponibile alcuna copia sicura da scegliere; le modifiche e la sincronizzazione restano sospese.'
                : pantryConflict
                  ? conflictCopyCount === 1
                    ? 'La dispensa ha una copia recuperabile. È conservata; le scritture sono sospese e la sincronizzazione è bloccata finché non scegli una versione.'
                    : conflictCopyCount > 1
                      ? `La dispensa ha ${conflictCopyCount} copie recuperabili. Sono tutte conservate; le scritture sono sospese e la sincronizzazione è bloccata finché non scegli una versione.`
                      : 'La dispensa è in conflitto. Le scritture sono sospese e la sincronizzazione è bloccata finché non scegli una versione.'
                  : persistenceIssue.status.state === 'memory-only'
                    ? `Le modifiche alla ${persistenceLabels[persistenceIssue.domain]} sono disponibili solo in memoria.`
                    : `La sincronizzazione della ${persistenceLabels[persistenceIssue.domain]} non è riuscita.`}
              {!pantryConflict && ' Puoi riprovare quando vuoi.'}
            </p>
            {pantryConflict && conflictCopies.length > 0 ? (
              <div className="w-full space-y-3 border-t border-amber-300 pt-3">
                <fieldset role="radiogroup" aria-label="Seleziona la copia da ripristinare" className="grid gap-2 sm:grid-cols-2">
                  <legend className="mb-2 font-bold">Scegli quale copia diventerà attiva</legend>
                  {conflictCopies.map((copy) => {
                    return (
                      <label key={copy.id} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border-2 border-amber-300 bg-white p-3">
                        <input
                          type="radio"
                          name="pantry-conflict-copy"
                          value={copy.id}
                          checked={selectedConflictCopyId === copy.id}
                          onChange={() => setSelectedConflictCopy({ scope: activeScope, copyId: copy.id })}
                          className="mt-1 h-5 w-5 accent-emerald-700"
                        />
                        <span className="min-w-0">
                          <span className="block font-bold">{copy.label}</span>
                          <span className="block text-sm leading-relaxed">{pantryCopySummary(copy)}</span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <p className="text-sm">{conflictCopyCount === 1
                  ? 'La copia resta nel backup fino al completamento del recupero. Non verrà unita o eliminata.'
                  : 'Le copie non selezionate restano nel backup. Non verranno unite o eliminate.'}</p>
                {visibleRecoveryError !== null && <p role="status" className="font-semibold">{visibleRecoveryError}</p>}
                <button
                  type="button"
                  onClick={() => void handlePantryConflictRecovery()}
                  disabled={!selectedConflictCopyId}
                  className="min-h-11 rounded-xl border-2 border-amber-800 bg-white px-4 py-2 font-bold text-amber-950 enabled:hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Usa questa copia
                </button>
              </div>
            ) : !pantryConflict ? (
              <button type="button" onClick={() => void retryPersistence(persistenceIssue.domain)} className="min-h-10 rounded-xl border-2 border-amber-700 px-3 py-1.5 font-bold text-amber-900 hover:bg-amber-100">Riprova</button>
            ) : null}
          </div>
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

      {!pantryConflict && archivedConflicts.length > 0 && (
        <details className="ik-disclosure mt-4 rounded-3xl border-2 border-amber-200 bg-amber-50/60 p-4 sm:p-5">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
            <span className="font-black text-gray-950">Copie archiviate della dispensa</span>
            <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-amber-950">
              {archivedConflicts.length} {archivedConflicts.length === 1 ? 'recupero' : 'recuperi'}
            </span>
          </summary>
          <div className="mt-4 space-y-4 border-t border-amber-200 pt-4">
            <p className="max-w-3xl text-sm leading-relaxed text-amber-950">
              Puoi consultare tutte le copie conservate e sceglierne una da ripristinare. La dispensa attuale sarà conservata in un nuovo backup prima del ripristino.
            </p>
            {archivedConflicts.map((entry) => (
              <fieldset
                key={entry.id}
                role="radiogroup"
                aria-label={`Seleziona una copia archiviata del recupero ${entry.id}`}
                className="grid gap-2 rounded-2xl border border-amber-200 bg-white p-3 sm:grid-cols-2"
              >
                <legend className="px-1 font-bold text-gray-950">Conflitto archiviato · {new Date(entry.createdAt).toLocaleDateString('it-IT')}</legend>
                {entry.copies.map((copy) => (
                  <label key={copy.id} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border-2 border-amber-200 p-3">
                    <input
                      type="radio"
                      name={`archived-pantry-copy-${entry.id}`}
                      value={copy.id}
                      checked={selectedArchivedCopy?.scope === activeScope
                        && selectedArchivedCopy.archiveId === entry.id && selectedArchivedCopy.copyId === copy.id}
                      onChange={() => setSelectedArchivedCopy({ scope: activeScope, archiveId: entry.id, copyId: copy.id })}
                      className="mt-1 h-5 w-5 accent-emerald-700"
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">{copy.label}</span>
                      <span className="block text-sm leading-relaxed">{pantryCopySummary(copy)}</span>
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => void handleArchivedPantryRecovery(entry.id)}
                  disabled={selectedArchivedCopy?.scope !== activeScope || selectedArchivedCopy.archiveId !== entry.id}
                  className="min-h-11 rounded-xl border-2 border-amber-800 bg-white px-4 py-2 font-bold text-amber-950 enabled:hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2 sm:w-fit"
                >
                  Ripristina copia archiviata
                </button>
              </fieldset>
            ))}
            {visibleArchiveRecoveryError !== null && <p role="status" className="font-semibold text-amber-950">{visibleArchiveRecoveryError}</p>}
          </div>
        </details>
      )}

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
