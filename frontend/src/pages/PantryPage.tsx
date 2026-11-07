import { ChefHat } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import DietFiltersPanel from '../components/diet/DietFiltersPanel';
import IngredientChip from '../components/pantry/IngredientChip';
import IngredientInput from '../components/pantry/IngredientInput';
import IngredientSuggestions from '../components/pantry/IngredientSuggestions';
import PantryLotsPanel from '../components/pantry/PantryLotsPanel';
import StaplesPanel from '../components/pantry/StaplesPanel';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';
import { getIngredient, inferIngredientCategory, registerIngredient, type IngredientCategory } from '@ikuck/shared/ingredients';
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
import { loadCustomIngredients } from '../storage/customIngredientsStorage';
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
import { useHouseStore } from '../house/houseStore';
import CandidatesInbox from '../components/pantry/CandidatesInbox';

const persistenceLabels: Record<PersistenceDomain, string> = {
  pantry: 'dispensa',
  'shopping-list': 'lista della spesa',
  activity: 'attività',
  diet: 'preferenze alimentari',
};

const blockingPersistenceStates: readonly PersistenceState[] = ['memory-only', 'sync-error'];

const PANTRY_CATEGORY_ORDER: readonly IngredientCategory[] = [
  'vegetable',
  'fruit',
  'nuts',
  'meat',
  'fish',
  'grain',
  'egg',
  'legume',
  'dairy',
  'spice',
  'sweet',
  'drink',
  'baking',
  'staple',
  'other',
];

const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  staple: 'Ingredienti di base',
  grain: 'Pasta e cereali',
  meat: 'Carne',
  fish: 'Pesce',
  egg: 'Uova',
  legume: 'Legumi',
  vegetable: 'Verdura',
  fruit: 'Frutta',
  nuts: 'Frutta secca',
  dairy: 'Latticini e formaggi',
  spice: 'Spezie',
  sweet: 'Dolci e dolcificanti',
  drink: 'Bevande',
  baking: 'Lievitanti',
  other: 'Altri ingredienti',
};

type PantryCategoryGroup = {
  key: IngredientCategory | 'other';
  label: string;
  items: ParsedIngredient[];
};

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
  const house = useHouseStore((state) => state.state?.house ?? null);
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

  useEffect(() => {
    if (!hasHydrated) return;
    const saved = loadCustomIngredients();
    for (const def of saved) {
      registerIngredient(def);
    }
    usePantryStore.getState().reconcileKnownFlags();
  }, [hasHydrated]);

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

  const groupedPantryItems = useMemo<PantryCategoryGroup[]>(() => {
    const byCategory = new Map<IngredientCategory | 'other', ParsedIngredient[]>();
    for (const item of pantryItems) {
      const category = getIngredient(item.id)?.category ?? inferIngredientCategory(item.label) ?? 'other';
      const bucket = byCategory.get(category);
      if (bucket === undefined) {
        byCategory.set(category, [item]);
      } else {
        bucket.push(item);
      }
    }

    const groups: PantryCategoryGroup[] = [];
    for (const category of PANTRY_CATEGORY_ORDER) {
      const items = byCategory.get(category);
      if (items !== undefined) {
        groups.push({
          key: category,
          label: CATEGORY_LABELS[category],
          items: [...items].sort((a, b) => a.label.localeCompare(b.label, 'it')),
        });
      }
    }
    return groups;
  }, [pantryItems]);
  const suggestedIngredients = useMemo(
    () => findHelpfulIngredients(availableIngredientIds, 5, {
      excludedIds: dismissedIngredientSuggestionIds,
      random: ingredientSuggestionSeed === 0 ? undefined : createSeededRandom(ingredientSuggestionSeed),
    }),
    [availableIngredientIds, dismissedIngredientSuggestionIds, ingredientSuggestionSeed],
  );

  if (!hasHydrated) {
    return (
      <main className="ik-page mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm text-center">
          <p role="status" className="font-semibold text-[var(--color-text)]">
            Caricamento della tua dispensa…
          </p>
        </div>
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
        <p className="ik-eyebrow">Organizza la tua cucina</p>
        <h1 className="mt-1">La tua dispensa</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--color-text-muted)] sm:text-lg">
          Tieni qui ingredienti, lotti, scadenze e preferenze: le ricette useranno sempre questi dati.
        </p>
      </header>

      {persistenceIssue !== undefined && (
        <div role="alert" className="ik-status-warning mb-5 max-w-3xl rounded-2xl p-4">
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
              <div className="w-full space-y-3 border-t border-[var(--color-warning)] pt-3">
                <fieldset role="radiogroup" aria-label="Seleziona la copia da ripristinare" className="grid gap-2 sm:grid-cols-2">
                  <legend className="mb-2 font-bold">Scegli quale copia diventerà attiva</legend>
                  {conflictCopies.map((copy) => (
                    <label key={copy.id} className="ik-surface flex min-h-12 cursor-pointer items-start gap-3 p-3 border-2 border-[var(--color-warning)]">
                      <input
                        type="radio"
                        name="pantry-conflict-copy"
                        value={copy.id}
                        checked={selectedConflictCopyId === copy.id}
                        onChange={() => setSelectedConflictCopy({ scope: activeScope, copyId: copy.id })}
                        className="mt-1 h-5 w-5 accent-[var(--color-primary)]"
                      />
                      <span className="min-w-0">
                        <span className="block font-bold">{copy.label}</span>
                        <span className="block text-sm leading-relaxed">{pantryCopySummary(copy)}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p className="text-sm">{conflictCopyCount === 1
                  ? 'La copia resta nel backup fino al completamento del recupero. Non verrà unita o eliminata.'
                  : 'Le copie non selezionate restano nel backup. Non verranno unite o eliminate.'}</p>
                {visibleRecoveryError !== null && <p role="status" className="font-semibold">{visibleRecoveryError}</p>}
                <button
                  type="button"
                  onClick={() => void handlePantryConflictRecovery()}
                  disabled={!selectedConflictCopyId}
                  className="ik-button-primary min-h-11 w-full sm:w-auto disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Usa questa copia
                </button>
              </div>
            ) : !pantryConflict ? (
              <button type="button" onClick={() => void retryPersistence(persistenceIssue.domain)} className="ik-button-secondary min-h-10">Riprova</button>
            ) : null}
          </div>
        </div>
      )}

      {house !== null && <CandidatesInbox houseId={house.id} />}

      <PageSection
        eyebrow="Ingredienti presenti"
        title="Cosa hai in casa?"
        titleId="pantry-items-title"
        description="Puoi aggiungere più ingredienti insieme: useremo solo quelli per proporti le ricette."
        action={
          <span className="badge badge-neutral">
            {pantryItems.length === 0 ? 'Dispensa vuota' : `${pantryItems.length} ${pantryItems.length === 1 ? 'ingrediente' : 'ingredienti'}`}
          </span>
        }
      >
        <div className="ik-kitchen-layout ik-kitchen-layout--two-columns min-w-0">
          <div className="ik-kitchen-column min-w-0">
            <IngredientInput onAdd={handleAdd} />
          </div>
          <div className="ik-kitchen-column min-w-0">
            {pantryItems.length > 0 ? (
              <>
                <ul aria-label="La tua dispensa" className="space-y-3">
                  {groupedPantryItems.map((group) => (
                    <li key={group.key} className="space-y-1">
                      <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--color-primary)]">
                        {group.label}
                      </h3>
                      <ul className="space-y-2">
                        {group.items.map((item) => (
                          <IngredientChip key={item.id} item={item} onRemove={removeIngredient} />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => window.location.href = '/recipes'}
                  className="ik-button-primary inline-flex min-h-12 w-full min-w-0 flex-col items-center justify-center gap-1 px-4 py-1 text-center text-base font-bold leading-tight sm:w-auto sm:flex-row sm:gap-2 sm:py-3"
                >
                  <ChefHat size={19} aria-hidden="true" />
                  Vai alle ricette
                </button>
              </>
            ) : (
              <>
                <EmptyState text="La tua dispensa è ancora vuota. Inserisci un ingrediente per iniziare." />
                <button
                  type="button"
                  disabled
                  className="ik-button-primary min-h-12 w-full min-w-0 flex-col items-center justify-center gap-1 px-4 py-1 text-center text-base font-bold leading-tight opacity-45 pointer-events-none sm:w-auto sm:flex-row sm:gap-2 sm:py-3"
                >
                  <ChefHat size={19} aria-hidden="true" />
                  Vai alle ricette
                </button>
              </>
            )}
          </div>
        </div>
      </PageSection>

      {!pantryConflict && archivedConflicts.length > 0 && (
        <details className="ik-disclosure mt-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
            <span className="font-black text-[var(--color-text)]">Copie archiviate della dispensa</span>
            <span className="badge badge-neutral">
              {archivedConflicts.length} {archivedConflicts.length === 1 ? 'recupero' : 'recuperi'}
            </span>
          </summary>
          <div className="mt-4 space-y-4 border-t border-[var(--color-border)] pt-4">
            <p className="max-w-3xl text-sm leading-relaxed text-[var(--color-text-muted)]">
              Puoi consultare tutte le copie conservate e sceglierne una da ripristinare. La dispensa attuale sarà conservata in un nuovo backup prima del ripristino.
            </p>
            {archivedConflicts.map((entry) => (
              <fieldset
                key={entry.id}
                role="radiogroup"
                aria-label={`Seleziona una copia archiviata del recupero ${entry.id}`}
                className="ik-surface grid gap-2 p-3 sm:grid-cols-2"
              >
                <legend className="px-1 font-bold text-[var(--color-text)]">Conflitto archiviato · {new Date(entry.createdAt).toLocaleDateString('it-IT')}</legend>
                {entry.copies.map((copy) => (
                  <label key={copy.id} className="ik-surface flex min-h-12 cursor-pointer items-start gap-3 p-3">
                    <input
                      type="radio"
                      name={`archived-pantry-copy-${entry.id}`}
                      value={copy.id}
                      checked={selectedArchivedCopy?.scope === activeScope
                        && selectedArchivedCopy.archiveId === entry.id && selectedArchivedCopy.copyId === copy.id}
                      onChange={() => setSelectedArchivedCopy({ scope: activeScope, archiveId: entry.id, copyId: copy.id })}
                      className="mt-1 h-5 w-5 accent-[var(--color-primary)]"
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
                  className="ik-button-primary min-h-11 w-full sm:col-span-2 sm:w-fit disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Ripristina copia archiviata
                </button>
              </fieldset>
            ))}
            {visibleArchiveRecoveryError !== null && <p role="status" className="font-semibold">{visibleArchiveRecoveryError}</p>}
          </div>
        </details>
      )}

      <details className="ik-disclosure ik-disclosure--ideas mt-7">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
          <span className="font-black text-[var(--color-text)]">Idee per ampliare la dispensa</span>
          <span className="badge badge-neutral">Facoltativo</span>
        </summary>
        <div className="border-t border-[var(--color-border)] pt-4">
          <IngredientSuggestions
            ingredients={suggestedIngredients}
            onAdd={handleSuggestedIngredient}
            onDismiss={dismissIngredientSuggestion}
            onRefresh={refreshIngredientSuggestions}
            showEmptyState={dismissedIngredientSuggestionIds.length > 0}
          />
        </div>
      </details>

      <details className="ik-disclosure mt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
          <span className="font-black text-[var(--color-text)]">Personalizza la dispensa</span>
          <span className="text-sm font-medium text-[var(--color-text-muted)]">Filtri, lotti e ingredienti di base</span>
        </summary>
        <div className="mt-4 space-y-5 border-t border-[var(--color-border)] pt-4">
          <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">Imposta solo ciò che serve alla tua cucina: queste opzioni affinano le proposte senza rallentare la ricerca.</p>
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