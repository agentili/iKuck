import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import LocalRecipeCard from '../components/suggestions/LocalRecipeCard';
import SuggestionControls from '../components/suggestions/SuggestionControls';
import AiRecipePanel from '../components/ai/AiRecipePanel';
import { generateRecipeFromPantry, saveAiRecipe, type GenerateRecipeFromPantryResponse } from '../ai/aiRecipeApi';
import { ApiClientError } from '../api/apiClient';
import {
  createAiRecipeCollectionOwner,
  isCurrentAiRecipeCollectionOwner,
  isSameAiRecipeCollectionOwner,
  type AiRecipeCollectionOwner,
} from '../ai/aiRecipeOwnership';
import type { GeneratedRecipe, GeneratedRecipeDraft, PantryIngredientReview } from '@ikuck/shared/contracts';
import { createSeededRandom, findRecipeSuggestions } from '../domain/suggestions';
import { ALLERGEN_LABELS } from '../domain/dietary';
import { RECIPES } from '../domain/recipes';
import { toDiaryPantryRecipe } from '../domain/diaryRecipes';
import { aggregatePantryLots } from '../domain/pantryLots';
import type { RecipeSuggestion } from '../domain/types';
import { hydratePantryStore, usePantryStore } from '../store/localPantryStore';
import QuickAddIngredientsDialog from '../components/pantry/QuickAddIngredientsDialog';
import IngredientChip from '../components/pantry/IngredientChip';
import { useDietProfileStore } from '../store/dietProfileStore';
import { useActivityStore } from '../store/activityStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope, type SyncScope } from '../sync/scopeContext';
import { useAuthStore } from '../auth/authStore';
import {
  persistenceDomains,
  retryPersistence,
  usePersistenceStatusStore,
  isPantrySnapshotConflictError,
  isPantrySnapshotConflictBackupError,
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

const isPantryConflictForScope = (error: unknown, scope: SyncScope): boolean => (
  isPantrySnapshotConflictError(error)
    && typeof error === 'object'
    && error !== null
    && 'scope' in error
    && error.scope === scope
);

export default function HomePage() {
  const hasHydrated = usePantryStore((state) => state.hasHydrated);
  const [hasSearched, setHasSearched] = useState(false);
  const [allowOneMissing, setAllowOneMissing] = useState(false);
  const [searchedAllowOneMissing, setSearchedAllowOneMissing] = useState(false);
  const [varietySeed, setVarietySeed] = useState(0);
  const [suggestions, setSuggestions] = useState<RecipeSuggestion[]>([]);
  const [focusResultsTitle, setFocusResultsTitle] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const addDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const recipeDialogRef = useRef<HTMLDialogElement>(null);
  const recipeDialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogScopeRef = useRef(getActiveDataScope());
  const closeQuickAdd = useCallback(() => {
    setQuickAddOpen(false);
    window.requestAnimationFrame(() => addDialogTriggerRef.current?.focus());
  }, []);
  const resultsTitleRef = useRef<HTMLHeadingElement>(null);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const addIngredients = usePantryStore((state) => state.addIngredients);
  const removeIngredient = usePantryStore((state) => state.removeIngredient);
  const pantryLots = usePantryStore((state) => state.pantryLots);
  const stapleIds = usePantryStore((state) => state.stapleIds);
  const dietProfile = useDietProfileStore((state) => state.profile);
  const events = useActivityStore((state) => state.events);
  const preferences = useActivityStore((state) => state.preferences);
  const shoppingItems = useShoppingListStore((state) => state.items);
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const diaryHasHydrated = useDinnerDiaryStore((state) => state.hasHydrated);
  const savedDiaryRecipes = useDinnerDiaryStore((state) => state.recipes);
  const activeScope = useSyncExternalStore(
    (listener) => subscribeActiveDataScope(() => listener()),
    getActiveDataScope,
    getActiveDataScope,
  );
  const diaryRecipes = useMemo(() => savedDiaryRecipes
    .filter((recipe) => recipe.scope === activeScope)
    .map(toDiaryPantryRecipe), [activeScope, savedDiaryRecipes]);
  const searchableRecipes = useMemo(() => [...RECIPES, ...diaryRecipes], [diaryRecipes]);
  const persistenceStatuses = usePersistenceStatusStore((state) => state.statuses);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const currentAiOwner = useMemo(
    () => createAiRecipeCollectionOwner(user?.id ?? null, verified, csrfToken, activeScope),
    [activeScope, csrfToken, user?.id, verified],
  );

  const [generationResult, setGenerationResult] = useState<{
    owner: AiRecipeCollectionOwner;
    requestId: number;
    response: GenerateRecipeFromPantryResponse;
  } | null>(null);
  const [generationError, setGenerationError] = useState<{
    owner: AiRecipeCollectionOwner;
    message: string;
  } | null>(null);
  const [generationOperation, setGenerationOperation] = useState<{
    owner: AiRecipeCollectionOwner;
    requestId: number;
  } | null>(null);
  const [saveOperation, setSaveOperation] = useState<{
    owner: AiRecipeCollectionOwner;
    requestId: number;
    candidateRequestId: number;
  } | null>(null);
  const [savedRecipeUpdate, setSavedRecipeUpdate] = useState<{
    owner: AiRecipeCollectionOwner;
    recipe: GeneratedRecipe;
  } | null>(null);
  const ownerEpochRef = useRef({ owner: currentAiOwner, epoch: 0 });
  const generationRequestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const candidateSaveRef = useRef<{
    requestId: number;
    owner: AiRecipeCollectionOwner;
    recipe: GeneratedRecipe;
  } | null>(null);
  const mountedRef = useRef(false);

  const refreshCurrentAiOwner = useCallback(() => {
    const { user: currentUser, csrfToken: currentCsrfToken } = useAuthStore.getState();
    const currentVerified = currentUser !== null
      && currentUser.emailVerifiedAt.trim().length > 0
      && currentCsrfToken !== null;
    const nextOwner = createAiRecipeCollectionOwner(
      currentUser?.id ?? null,
      currentVerified,
      currentCsrfToken,
      getActiveDataScope(),
    );
    const previous = ownerEpochRef.current;
    const sameOwner = (previous.owner === null && nextOwner === null)
      || isSameAiRecipeCollectionOwner(previous.owner, nextOwner);
    if (sameOwner) return;

    ownerEpochRef.current = { owner: nextOwner, epoch: previous.epoch + 1 };
    generationRequestIdRef.current += 1;
    saveRequestIdRef.current += 1;
    candidateSaveRef.current = null;
    setGenerationResult(null);
    setGenerationError(null);
    setGenerationOperation(null);
    setSaveOperation(null);
    setSavedRecipeUpdate(null);
  }, []);

  useLayoutEffect(() => {
    const unsubscribeAuth = useAuthStore.subscribe(() => refreshCurrentAiOwner());
    const unsubscribeScope = subscribeActiveDataScope(() => refreshCurrentAiOwner());
    refreshCurrentAiOwner();
    return () => {
      unsubscribeAuth();
      unsubscribeScope();
    };
  }, [refreshCurrentAiOwner]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ownerEpochRef.current = { ...ownerEpochRef.current, epoch: ownerEpochRef.current.epoch + 1 };
      generationRequestIdRef.current += 1;
      saveRequestIdRef.current += 1;
    };
  }, []);

  const visibleGenerationResult = generationResult !== null
    && isSameAiRecipeCollectionOwner(generationResult.owner, currentAiOwner)
    ? generationResult
    : null;
  const generateCandidate = visibleGenerationResult?.response ?? null;
  const generateError = generationError !== null
    && isSameAiRecipeCollectionOwner(generationError.owner, currentAiOwner)
    ? generationError.message
    : null;
  const isRecipeDialogOpen = generateCandidate?.kind === 'candidate' || generateError !== null;
  const isGenerating = generationOperation !== null
    && generationOperation.requestId === generationRequestIdRef.current
    && isSameAiRecipeCollectionOwner(generationOperation.owner, currentAiOwner);
  const isSavingRecipe = saveOperation !== null
    && visibleGenerationResult !== null
    && saveOperation.requestId === saveRequestIdRef.current
    && saveOperation.candidateRequestId === visibleGenerationResult.requestId
    && isSameAiRecipeCollectionOwner(saveOperation.owner, currentAiOwner);

  useLayoutEffect(() => {
    if (!isRecipeDialogOpen) return;
    const dialog = recipeDialogRef.current;
    if (dialog === null) return;
    const trigger = generateButtonRef.current;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    recipeDialogTitleRef.current?.focus();

    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      window.requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
      });
    };
  }, [isRecipeDialogOpen]);

  const persistenceIssue = persistenceDomains
    .map((domain) => ({ domain, status: persistenceStatuses[domain] }))
    .filter(({ domain, status }) => !(domain === 'pantry'
      && isPantrySnapshotConflictError(status.error)
      && !isPantryConflictForScope(status.error, activeScope)))
    .find(({ status }) => blockingPersistenceStates.includes(status.state));
  const malformedPantryBackup = persistenceIssue?.domain === 'pantry'
    && isPantrySnapshotConflictBackupError(persistenceIssue.status.error);
  const pantryConflict = persistenceIssue?.domain === 'pantry'
    && isPantrySnapshotConflictError(persistenceIssue.status.error);
  const pantryConflictCopyCount = pantryConflict
    && typeof persistenceIssue.status.error === 'object'
    && persistenceIssue.status.error !== null
    && 'copies' in persistenceIssue.status.error
    && Array.isArray(persistenceIssue.status.error.copies)
    ? persistenceIssue.status.error.copies.length
    : 0;
  const hasRecoverablePantryConflict = pantryConflict && !malformedPantryBackup && pantryConflictCopyCount > 0;

  const availableIngredientIds = useMemo(
    () => [...pantryItems.map((item) => item.id), ...stapleIds],
    [pantryItems, stapleIds],
  );
  const quantitySummaries = useMemo(
    () => aggregatePantryLots(pantryLots),
    [pantryLots],
  );
  const calculatedSuggestions = useMemo(() => {
    if (!hasSearched) return [];
    return findRecipeSuggestions({
      recipes: searchableRecipes,
      availableIds: availableIngredientIds,
      allowOneMissing: searchedAllowOneMissing,
      quantitySummaries,
      dietProfile,
      events,
      preferences,
      random: createSeededRandom(varietySeed),
    });
  }, [availableIngredientIds, dietProfile, events, hasSearched, preferences, quantitySummaries, searchedAllowOneMissing, searchableRecipes, varietySeed]);

  useEffect(() => {
    if (quickAddOpen && dialogScopeRef.current !== activeScope) closeQuickAdd();
  }, [activeScope, closeQuickAdd, quickAddOpen]);

  const openQuickAdd = () => {
    dialogScopeRef.current = activeScope;
    setQuickAddOpen(true);
  };

  useEffect(() => {
    void hydratePantryStore();
    if (!useDinnerDiaryStore.getState().hasHydrated) void hydrateDinnerDiaryStore();
  }, []);

  useEffect(() => {
    if (hasSearched) setSuggestions(calculatedSuggestions);
  }, [calculatedSuggestions, hasSearched]);

  useEffect(() => {
    if (!focusResultsTitle || !hasSearched) return;
    resultsTitleRef.current?.focus();
    setFocusResultsTitle(false);
  }, [focusResultsTitle, hasSearched]);

  if (!hasHydrated || !diaryHasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-[var(--ik-border)] bg-[var(--ik-surface)] px-5 py-4 font-semibold text-[var(--ik-ink-muted)]">
          Caricamento delle tue ricette…
        </p>
      </main>
    );
  }

  const calculateSuggestions = (seed: number, extended: boolean): RecipeSuggestion[] => findRecipeSuggestions({
    recipes: searchableRecipes,
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

  const generateFromPantry = async () => {
    const owner = currentAiOwner;
    if (owner === null || !user || !csrfToken || isGenerating || !isCurrentAiRecipeCollectionOwner(owner)) return;
    const ownerEpoch = ownerEpochRef.current.epoch;
    const requestId = ++generationRequestIdRef.current;
    candidateSaveRef.current = null;
    const isCurrentGeneration = (): boolean => mountedRef.current
      && ownerEpochRef.current.epoch === ownerEpoch
      && generationRequestIdRef.current === requestId
      && isSameAiRecipeCollectionOwner(ownerEpochRef.current.owner, owner)
      && isCurrentAiRecipeCollectionOwner(owner);

    saveRequestIdRef.current += 1;
    setSaveOperation(null);
    setGenerationOperation({ owner, requestId });
    setGenerationError(null);
    setGenerationResult(null);
    try {
      const ingredientNames = pantryItems.map((item) => item.label).filter(Boolean);
      if (ingredientNames.length === 0) {
        if (isCurrentGeneration()) {
          setGenerationError({ owner, message: 'Aggiungi almeno un ingrediente alla dispensa prima di generare una ricetta.' });
        }
        return;
      }
      const response = await generateRecipeFromPantry({
        ingredients: ingredientNames,
        dietProfile: {
          diet: dietProfile.diet,
          excludedAllergens: dietProfile.excludedAllergens,
          nutrition: dietProfile.nutrition,
        },
      }, owner.sessionTokenIdentity);
      if (!isCurrentGeneration()) return;
      setGenerationResult({ owner, requestId, response });
    } catch (error) {
      if (!isCurrentGeneration()) return;
      if (error instanceof ApiClientError) {
        setGenerationError({
          owner,
          message: error.status === 429 ? 'Hai raggiunto il limite giornaliero di generazioni. Riprova più tardi.' : 'Impossibile generare la ricetta in questo momento.',
        });
      } else {
        setGenerationError({ owner, message: 'Impossibile generare la ricetta in questo momento.' });
      }
    } finally {
      if (isCurrentGeneration()) setGenerationOperation(null);
    }
  };

  const saveGeneratedRecipe = async () => {
    const result = visibleGenerationResult;
    if (currentAiOwner === null
      || result === null
      || result.response.kind !== 'candidate'
      || isSavingRecipe
      || !isCurrentAiRecipeCollectionOwner(result.owner)) return;
    const { recipe: draft } = result.response;
    const owner = result.owner;
    const ownerEpoch = ownerEpochRef.current.epoch;
    const saveRequestId = ++saveRequestIdRef.current;
    const isCurrentSave = (): boolean => mountedRef.current
      && ownerEpochRef.current.epoch === ownerEpoch
      && saveRequestIdRef.current === saveRequestId
      && generationRequestIdRef.current === result.requestId
      && isSameAiRecipeCollectionOwner(ownerEpochRef.current.owner, owner)
      && isCurrentAiRecipeCollectionOwner(owner);
    const cachedCandidateSave = candidateSaveRef.current;
    let generatedRecipe: GeneratedRecipe;
    if (cachedCandidateSave !== null
      && cachedCandidateSave.requestId === result.requestId
      && isSameAiRecipeCollectionOwner(cachedCandidateSave.owner, owner)) {
      generatedRecipe = cachedCandidateSave.recipe;
    } else {
      const now = new Date().toISOString();
      generatedRecipe = {
        ...draft,
        id: crypto.randomUUID(),
        source: 'ai',
        createdAt: now,
        updatedAt: now,
      };
      candidateSaveRef.current = { requestId: result.requestId, owner, recipe: generatedRecipe };
    }
    setSaveOperation({ owner, requestId: saveRequestId, candidateRequestId: result.requestId });
    setGenerationError(null);
    try {
      const savedRecipe = await saveAiRecipe(generatedRecipe, owner.sessionTokenIdentity);
      if (!isCurrentSave()) return;
      setSavedRecipeUpdate({ owner, recipe: savedRecipe });
      if (candidateSaveRef.current?.requestId === result.requestId
        && isSameAiRecipeCollectionOwner(candidateSaveRef.current.owner, owner)) {
        candidateSaveRef.current = null;
      }
      setGenerationResult((current) => current?.requestId === result.requestId
        && isSameAiRecipeCollectionOwner(current.owner, owner)
        ? null
        : current);
    } catch (error) {
      if (!isCurrentSave()) return;
      if (error instanceof ApiClientError) {
        setGenerationError({
          owner,
          message: error.status === 429 ? 'Hai raggiunto il limite giornaliero di salvataggi.' : 'Impossibile salvare la ricetta.',
        });
      } else {
        setGenerationError({ owner, message: 'Impossibile salvare la ricetta.' });
      }
    } finally {
      if (isCurrentSave()) setSaveOperation(null);
    }
  };

  const discardGeneratedRecipe = () => {
    if (isSavingRecipe) return;
    generationRequestIdRef.current += 1;
    saveRequestIdRef.current += 1;
    candidateSaveRef.current = null;
    setGenerationResult(null);
    setGenerationError(null);
    setGenerationOperation(null);
    setSaveOperation(null);
  };

  const handleRecipeDialogKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      discardGeneratedRecipe();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = recipeDialogRef.current;
    if (dialog === null) return;
    const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      recipeDialogTitleRef.current?.focus();
    } else if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (currentIndex === -1 || currentIndex === focusableElements.length - 1)) {
      event.preventDefault();
      first.focus();
    }
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

  const noneAvailable = generateCandidate?.kind === 'none_available' ? generateCandidate : null;
  const candidate = generateCandidate?.kind === 'candidate' ? generateCandidate : null;

  return (
    <main id="main-content" className="ik-page ik-kitchen-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Cucina · {activeScope.startsWith('house:') ? 'Casa' : activeScope === 'guest' ? 'dati locali' : 'personale'}</p>
        <h1 className="mt-1 text-[1.8rem] font-black leading-[1.04] text-[var(--ik-ink)] sm:text-[2.4rem]">Cucina viva</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--ik-ink-muted)]">Aggiungi quello che hai, poi scegli cosa cucinare. La ricerca parte solo quando la avvii.</p>
      </header>

      {persistenceIssue !== undefined && (
        <div role="alert" className="mb-5 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-[var(--ik-radius-panel)] border-2 border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-[var(--ik-tomato)]">
          <p>
            {persistenceIssue.domain === 'pantry' && isPantrySnapshotConflictError(persistenceIssue.status.error)
              ? isPantrySnapshotConflictBackupError(persistenceIssue.status.error)
                ? 'Il backup della dispensa è stato conservato, ma i dati non sono leggibili. Non è disponibile alcuna copia sicura da scegliere; le modifiche e la sincronizzazione restano sospese.'
                : pantryConflictCopyCount === 1
                  ? 'La dispensa ha una copia recuperabile. È conservata; le scritture sono sospese finché non scegli una versione.'
                  : pantryConflictCopyCount > 1
                    ? `La dispensa ha ${pantryConflictCopyCount} copie recuperabili. Sono tutte conservate; le scritture sono sospese finché non scegli una versione.`
                    : 'La dispensa è in conflitto, ma non è disponibile una copia sicura da scegliere; le modifiche e la sincronizzazione restano sospese.'
              : persistenceIssue.status.state === 'memory-only'
                ? `Le modifiche alla ${persistenceLabels[persistenceIssue.domain]} sono disponibili solo in memoria.`
                : `La sincronizzazione della ${persistenceLabels[persistenceIssue.domain]} non è riuscita.`}
            {!pantryConflict && !malformedPantryBackup && <> {' '}Puoi riprovare quando vuoi.</>}
          </p>
          {hasRecoverablePantryConflict ? (
            <Link to="/pantry" className="inline-flex min-h-10 items-center rounded-xl border-2 border-[var(--ik-basil)] px-3 py-1.5 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)]">Scegli una copia della dispensa</Link>
          ) : !pantryConflict && !malformedPantryBackup ? (
            <button type="button" onClick={() => void retryPersistence(persistenceIssue.domain)} className="min-h-10 rounded-xl border-2 border-[var(--ik-basil)] px-3 py-1.5 font-bold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-sage)]">Riprova</button>
          ) : null}
        </div>
      )}

      <div className="ik-kitchen-layout mt-4">
        <section aria-labelledby="pantry-summary-title" className="ik-pantry-workbench ik-surface space-y-4 rounded-3xl border-2 p-4 sm:p-5">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Banco ingredienti</p>
            <h2 id="pantry-summary-title" className="mt-1 text-2xl font-black text-[var(--ik-ink)]">{hasPantryItems ? 'Quello che hai' : 'Partiamo da cosa hai'}</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">
              {hasPantryItems
                ? `${pantryItems.length} ${pantryItems.length === 1 ? 'ingrediente' : 'ingredienti'} · ambito ${activeScope.startsWith('house:') ? 'Casa' : activeScope === 'guest' ? 'locale' : 'personale'}`
                : 'Aggiungi ingredienti qui: la dispensa si aggiorna senza cambiare pagina.'}
            </p>
          </div>
          {pantryItems.length > 0 ? (
            <ul aria-label="Ingredienti disponibili" className="ik-home-pantry-items flex flex-wrap gap-2">
              {pantryItems.map((item) => <IngredientChip key={item.id} item={item} onRemove={removeIngredient} />)}
            </ul>
          ) : (
            <p role="status" className="rounded-2xl border border-dashed border-[var(--ik-sage)] bg-[var(--ik-mist)] px-4 py-3 text-sm font-medium text-[var(--ik-basil-dark)]">Nessun ingrediente ancora aggiunto.</p>
          )}
          <button
            ref={addDialogTriggerRef}
            type="button"
            onClick={openQuickAdd}
            className="ik-button-primary inline-flex min-h-12 w-full items-center justify-center rounded-xl px-4 py-3 text-base font-bold sm:w-auto"
          >Aggiungi ingredienti</button>
          {user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null && (
            <button
              ref={generateButtonRef}
              type="button"
              onClick={generateFromPantry}
              disabled={isGenerating || pantryItems.length === 0}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-xl px-4 py-3 text-base font-bold sm:w-auto border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] text-[var(--ik-ink)] hover:bg-[var(--ik-mist)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? 'Generazione in corso…' : 'Genera ricetta da dispensa'}
            </button>
          )}
          {noneAvailable !== null && (
            <div role="status" className="w-full rounded-xl border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-3 text-sm text-[var(--ik-ink-muted)]">
              {noneAvailable.message}
              {noneAvailable.ingredientReview !== undefined && <IngredientReviewSummary review={noneAvailable.ingredientReview} />}
            </div>
          )}
          <Link to="/pantry" className="inline-flex min-h-11 items-center rounded-xl px-3 py-2 font-bold text-[var(--ik-basil-dark)] underline decoration-[var(--ik-border-strong)] underline-offset-4 hover:bg-[var(--ik-mist)]">Apri tutta la dispensa</Link>
          <SuggestionControls allowOneMissing={allowOneMissing} disabled={!hasPantryItems} onAllowOneMissingChange={setAllowOneMissing} onSearch={() => search()} />
          {!hasPantryItems && <p className="text-sm text-[var(--ik-ink-muted)]">La ricerca è manuale e locale: nessuna chiamata parte aprendo la Home.</p>}
        </section>

        <section aria-label="Risultati delle ricette" className="ik-kitchen-results min-w-0">
          <div aria-live="polite" aria-atomic="false" className="mt-0">
            {hasSearched && (
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 id="results-title" ref={resultsTitleRef} tabIndex={-1} className="text-3xl font-black text-[var(--ik-ink)]">Ricette per te</h2>
                  <p className="mt-1 text-[var(--ik-ink-muted)]">Scelte usando quello che hai indicato nella dispensa.</p>
                </div>
                {suggestions.length > 0 && (
                  <button type="button" onClick={refreshSuggestions} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-4 py-2 font-semibold text-[var(--ik-ink)] hover:border-[var(--ik-basil-dark)]">
                    <RefreshCw size={17} aria-hidden="true" />
                    Altre idee
                  </button>
                )}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="space-y-7">
                {readySuggestions.length > 0 && (
                  <section aria-labelledby="ready-recipes-title" className="ik-results-group ik-results-group--ready rounded-3xl border-2 border-[var(--ik-sage)] bg-[var(--ik-mist)] p-4 sm:p-5">
                    <div className="mb-4 max-w-2xl">
                      <p className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Senza spesa</p>
                      <h3 id="ready-recipes-title" className="mt-1 text-2xl font-black text-[var(--ik-ink)]">Pronte da cucinare</h3>
                      <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)] sm:text-base">Hai tutti gli ingredienti necessari; controlla le quantità indicate nella ricetta.</p>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {readySuggestions.map((suggestion) => <LocalRecipeCard key={suggestion.recipe.id} suggestion={suggestion} />)}
                    </div>
                  </section>
                )}
                {onePurchaseSuggestions.length > 0 && (
                  <section aria-labelledby="one-purchase-recipes-title" className="ik-results-group ik-results-group--one-purchase rounded-3xl border-2 border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-4 sm:p-5">
                    <div className="mb-4 max-w-2xl">
                      <p className="text-sm font-bold uppercase tracking-[0.14em] text-[var(--ik-warn-ink)]">Un piccolo acquisto</p>
                      <h3 id="one-purchase-recipes-title" className="mt-1 text-2xl font-black text-[var(--ik-ink)]">Con un solo acquisto</h3>
                      <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)] sm:text-base">Manca un solo ingrediente: aggiungilo alla lista e la ricetta è pronta.</p>
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
              <div className="rounded-[var(--ik-radius-feature)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] p-6">
                <h3 className="text-xl font-bold text-[var(--ik-ink)]">Nessuna ricetta pronta con questi ingredienti</h3>
                {!allowOneMissing ? (
                  <button type="button" onClick={tryExtended} className="mt-4 min-h-11 rounded-xl bg-[var(--ik-basil-dark)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil)]">Prova con 1 ingrediente in più</button>
                ) : (
                  <div className="mt-3">
                    <p className="text-[var(--ik-ink-muted)]">Puoi aggiungere altri ingredienti nella sezione Dispensa.</p>
                    <Link to="/pantry" className="mt-3 inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil-dark)]">Gestisci la dispensa</Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null && (
        <section aria-labelledby="ai-recipes-title" className="mt-6">
          <AiRecipePanel
            ingredients={pantryItems.map((item) => item.label)}
            dietProfile={dietProfile}
            user={user}
            csrfToken={csrfToken}
            savedRecipeUpdate={savedRecipeUpdate}
          />
        </section>
      )}

      <QuickAddIngredientsDialog
        open={quickAddOpen}
        scope={activeScope}
        onClose={closeQuickAdd}
        onAdd={addIngredients}
      />

      {(candidate !== null || generateError !== null) && (
        <div className="ik-modal-backdrop fixed inset-0 z-50 grid place-items-center p-4">
          <dialog
            ref={recipeDialogRef}
            aria-modal="true"
            aria-labelledby="generated-recipe-dialog-title"
            className="ik-modal-surface ik-generated-recipe-dialog m-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-[var(--ik-radius-panel)] p-5 sm:p-6"
            onCancel={(event) => {
              event.preventDefault();
              discardGeneratedRecipe();
            }}
            onKeyDown={handleRecipeDialogKeyDown}
          >
            <div className="mb-4 flex shrink-0 items-start justify-between gap-4 border-b border-[var(--ik-border)] pb-3">
              <h2 id="generated-recipe-dialog-title" ref={recipeDialogTitleRef} tabIndex={-1} className="text-xl font-black text-[var(--ik-ink)]">
                {candidate !== null ? 'Anteprima ricetta' : 'Generazione non riuscita'}
              </h2>
              <button
                type="button"
                onClick={discardGeneratedRecipe}
                disabled={isSavingRecipe}
                aria-label={candidate !== null ? 'Scarta anteprima' : 'Chiudi'}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--ik-border)] text-[var(--ik-ink)] hover:bg-[var(--ik-mist)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {generateError !== null && (
              <div role="alert" className="mb-4 shrink-0 rounded-xl border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 text-sm text-[var(--ik-tomato)]">
                {generateError}
              </div>
            )}
            {candidate !== null && (
              <GenerateCandidatePreview recipe={candidate.recipe} ingredientReview={candidate.ingredientReview} onSave={saveGeneratedRecipe} onDiscard={discardGeneratedRecipe} isSaving={isSavingRecipe} />
            )}
          </dialog>
        </div>
      )}
    </main>
  );
}

function GenerateCandidatePreview({ recipe, ingredientReview, onSave, onDiscard, isSaving }: { recipe: GeneratedRecipeDraft; ingredientReview?: PantryIngredientReview; onSave: () => void; onDiscard: () => void; isSaving: boolean }) {
  return (
    <div aria-busy={isSaving} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <h3 className="text-lg font-bold text-[var(--ik-ink)]">{recipe.title}</h3>
        <p className="mt-4 text-sm text-[var(--ik-ink-muted)]">{recipe.description}</p>
        {ingredientReview !== undefined && <IngredientReviewSummary review={ingredientReview} />}
        <div className="mt-4">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Ingredienti</h4>
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-[var(--ik-ink)]">
            {recipe.ingredients.map((ing, i) => (
              <li key={i}>{ing.name} {ing.amount}</li>
            ))}
          </ul>
        </div>
        <div className="mt-4">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--ik-basil-dark)]">Procedimento</h4>
          <ol className="mt-1 list-inside list-decimal space-y-1 text-sm text-[var(--ik-ink)]">
            {recipe.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
      {isSaving && (
        <p role="status" className="mt-4 shrink-0 text-sm text-[var(--ik-ink-muted)]">
          Salvataggio in corso: attendi la risposta prima di chiudere.
        </p>
      )}
      <div className="mt-5 flex shrink-0 gap-3 border-t border-[var(--ik-border)] pt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving}
          className="flex-1 min-h-11 rounded-xl bg-[var(--ik-basil-dark)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil)] disabled:opacity-50"
        >
          Salva nel ricettario
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={isSaving}
          className="flex-1 min-h-11 rounded-xl border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:bg-[var(--ik-mist)]"
        >
          Scarta
        </button>
      </div>
    </div>
  );
}

function IngredientReviewSummary({ review }: { review: PantryIngredientReview }) {
  const count = review.consideredIngredients.length;
  const usedCount = review.assessments.filter((item) => item.disposition === 'used').length;
  const notSelectedCount = review.assessments.filter((item) => item.disposition === 'not_selected').length;
  const excludedCount = review.assessments.filter((item) => item.disposition === 'excluded').length;
  const explanation = (item: PantryIngredientReview['excludedIngredients'][number]): string => {
    switch (item.reason) {
      case 'composition_unverified': return 'composizione non verificabile dal solo nome';
      case 'diet_incompatible': return 'non compatibile con la dieta selezionata';
      case 'excluded_allergen': return `allergeni esclusi dal profilo: ${item.allergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}`;
    }
  };
  const uncertainUsed = review.assessments.filter((item) => item.disposition === 'used' && item.allergenCoverage !== 'complete');

  return (
    <div className="mt-4 rounded-xl border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm text-[var(--ik-ink-muted)]">
      {count > 0 && (
        <p>
          Ingredienti valutati: {count}. Usati nella proposta: {usedCount}; non usati nella proposta: {notSelectedCount}; esclusi per sicurezza: {excludedCount}.
        </p>
      )}
      {uncertainUsed.map((item, index) => (
        <div key={`${item.inputIndex}-${index}`} className="mt-2">
          <p>{item.warning ?? (item.evidence === 'provider_declared'
            ? "Composizione proposta, non verifica del prodotto: controlla l'etichetta. L'assenza di altri allergeni non è verificata."
            : "Composizione non completamente verificata dal solo nome: controlla l'etichetta. L'assenza di altri allergeni non è verificata.")}</p>
          {item.presentAllergens.length > 0 && (
            <p>{item.evidence === 'provider_declared' ? 'Allergeni dichiarati nella proposta' : 'Allergeni implicati dal nome'}: {item.presentAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
          {item.possibleAllergens.length > 0 && (
            <p>Rischio possibile per {item.name}: {item.possibleAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
        </div>
      ))}
      {(review.recipeIngredientWarnings ?? []).map((item) => (
        <div key={`recipe-ingredient-${item.ingredientIndex}`} className="mt-2">
          <p>{item.name}: {item.warning}</p>
          {item.presentAllergens.length > 0 && (
            <p>Allergeni implicati dal nome: {item.presentAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
          {item.possibleAllergens.length > 0 && (
            <p>Rischio possibile per {item.name}: {item.possibleAllergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}.</p>
          )}
        </div>
      ))}
      {review.excludedIngredients.length > 0 && (
        <ul className="mt-2 space-y-1">
          {review.excludedIngredients.map((item, index) => (
            <li key={`${item.name}-${index}`}><strong>{item.name}</strong>: {explanation(item)}.</li>
          ))}
        </ul>
      )}
    </div>
  );
}
