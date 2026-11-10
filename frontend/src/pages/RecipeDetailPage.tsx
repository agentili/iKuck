import { ArrowLeft, ChefHat, Clock, Heart, ShoppingCart, Star, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { CookEvent, RecipeNutrition } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand, DinnerConsumptionIngredient, PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { planPantryConsumption } from '@ikuck/shared/pantryConsumption';
import { ApiClientError, apiRequest } from '../api/apiClient';
import { getIngredient } from '@ikuck/shared/ingredients';
import { ALLERGEN_LABELS } from '../domain/dietary';
import { getRecipeMetadata } from '../domain/recipeMetadata';
import { getRecipeById } from '../domain/recipes';
import { toDiaryPantryRecipe } from '../domain/diaryRecipes';
import { getQuantityWarning } from '../domain/pantryLots';
import type { PantryRecipe, RecipeCategory } from '../domain/types';
import { usePantryStore } from '../store/localPantryStore';
import DinnerConsumptionSelection from '../components/dinnerDiary/DinnerConsumptionSelection';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useActivityStore } from '../store/activityStore';
import { useAuthStore } from '../auth/authStore';
import { useDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope } from '../sync/scopeContext';
import NotFoundPage from './NotFoundPage';
import RecipeNutritionSummary from '../components/diet/RecipeNutritionSummary';
import RecipeImage from '../components/suggestions/RecipeImage';
import PageSection from '../components/ui/PageSection';

const ratingLabel = (value: number): string => `${value} ${value === 1 ? 'stella' : 'stelle'}`;

const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  meat: 'Carne',
  fish: 'Pesce',
  eggs: 'Uova',
  legumes: 'Legumi',
  vegetables: 'Verdure',
  diary: 'Dal diario',
};

const RECIPE_DETAIL_FOCUS_CLASS = [
  '[&_a:focus-visible]:outline',
  '[&_a:focus-visible]:outline-2',
  '[&_a:focus-visible]:outline-offset-2',
  '[&_a:focus-visible]:outline-[var(--ik-focus)]',
  '[&_button:focus-visible]:outline',
  '[&_button:focus-visible]:outline-2',
  '[&_button:focus-visible]:outline-offset-2',
  '[&_button:focus-visible]:outline-[var(--ik-focus)]',
  '[&_input:focus-visible]:outline',
  '[&_input:focus-visible]:outline-2',
  '[&_input:focus-visible]:outline-offset-2',
  '[&_input:focus-visible]:outline-[var(--ik-focus)]',
  '[&_select:focus-visible]:outline',
  '[&_select:focus-visible]:outline-2',
  '[&_select:focus-visible]:outline-offset-2',
  '[&_select:focus-visible]:outline-[var(--ik-focus)]',
  '[&_textarea:focus-visible]:outline',
  '[&_textarea:focus-visible]:outline-2',
  '[&_textarea:focus-visible]:outline-offset-2',
  '[&_textarea:focus-visible]:outline-[var(--ik-focus)]',
].join(' ');

const isRecipeNutrition = (value: unknown): value is RecipeNutrition => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RecipeNutrition>;
  return (candidate.source === 'catalog_estimate' || candidate.source === 'usda')
    && typeof candidate.isComplete === 'boolean'
    && Array.isArray(candidate.missingNutrients)
    && candidate.missingNutrients.every((item) => typeof item === 'string')
    && ['caloriesPerServing', 'proteinGramsPerServing', 'carbohydrateGramsPerServing', 'fatGramsPerServing']
      .every((key) => candidate[key as keyof RecipeNutrition] === null || typeof candidate[key as keyof RecipeNutrition] === 'number');
};

const createLocalId = (prefix: string): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
};

const localDateString = (date = new Date()): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// The selection stores per-portion amounts, so a whole-recipe amount is divided once.
const perServingAmount = (amount: string, servings: number | null): string => {
  const trimmed = amount.trim();
  if (servings === null || !Number.isInteger(servings) || servings <= 1) return trimmed;
  const parsed = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)$/i);
  if (parsed === null) return trimmed;
  const total = Number(parsed[1].replace(',', '.'));
  const perServing = total / servings;
  const formatted = Number.isInteger(perServing) ? String(perServing) : String(Number(perServing.toPrecision(6)));
  return `${formatted} ${parsed[2].toLowerCase()}`;
};

const buildConsumptionIngredients = (recipe: PantryRecipe | undefined): DinnerConsumptionIngredient[] => (
  recipe === undefined ? [] : recipe.ingredients.map((item) => ({
    ingredientId: item.ingredientId,
    name: item.name ?? getIngredient(item.ingredientId)?.label ?? item.ingredientId,
    amount: perServingAmount(item.amount, recipe.servings),
    optional: item.optional === true,
    used: item.optional !== true,
  }))
);

const gramsPerServingFromAmount = (amount: string, servings: number | null): number | null => {
  const match = amount.trim().match(/^(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (match === null || servings === null || servings <= 0) return null;
  const grams = Number(match[1].replace(',', '.')) * (match[2].toLowerCase() === 'kg' ? 1000 : 1);
  return Number.isFinite(grams) && grams > 0 ? grams / servings : null;
};

export default function RecipeDetailPage() {
  const { recipeId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const returnLinkLabel = 'Torna a Chef';
  const requestedScope = searchParams.get('scope');
  const activeScope = getActiveDataScope();
  const savedDiaryRecipes = useDinnerDiaryStore((state) => state.recipes);
  const savedDiaryRecipe = requestedScope === activeScope
    ? savedDiaryRecipes.find((item) => item.scope === activeScope && item.value.id === recipeId)
    : undefined;
  const recipe = requestedScope === null
    ? getRecipeById(recipeId)
    : savedDiaryRecipe === undefined ? undefined : toDiaryPantryRecipe(savedDiaryRecipe);
  const metadata = recipe === undefined ? undefined : getRecipeMetadata(recipe.id);
  const [shoppingMessage, setShoppingMessage] = useState<string | null>(null);
  const [activityMessage, setActivityMessage] = useState<string | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(null);
  const [nutritionMessage, setNutritionMessage] = useState<string | null>(null);
  const [nutrition, setNutrition] = useState<RecipeNutrition | null>(metadata?.nutrition ?? null);
  const [isRefreshingNutrition, setIsRefreshingNutrition] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [privateNote, setPrivateNote] = useState('');
  const [cookedServings, setCookedServings] = useState(() => recipe === undefined || recipe.servings === null ? '' : String(recipe.servings));
  const [selectionRecipeId, setSelectionRecipeId] = useState<string | null>(recipe?.id ?? null);
  const [consumptionIngredients, setConsumptionIngredients] = useState<DinnerConsumptionIngredient[]>(() => buildConsumptionIngredients(recipe));
  const [consumptionNoneUsed, setConsumptionNoneUsed] = useState(false);
  const [confirmingDinner, setConfirmingDinner] = useState(false);
  const [confirmedPlan, setConfirmedPlan] = useState<PantryConsumptionPlan | null>(null);
  const [confirmedNoIngredientsUsed, setConfirmedNoIngredientsUsed] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const availableIds = usePantryStore((state) => state.getAvailableIngredientIds());
  const pantryLots = usePantryStore((state) => state.pantryLots);
  const quantitySummaries = usePantryStore((state) => state.getPantryQuantitySummary());
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const preferences = useActivityStore((state) => state.preferences);
  const recordCookEvent = useActivityStore((state) => state.recordCookEvent);
  const setRecipePreference = useActivityStore((state) => state.setRecipePreference);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const currentPreference = recipe === undefined ? undefined : preferences.find((item) => item.recipeId === recipe.id);
  const canRefreshNutrition = user !== null && user.emailVerifiedAt.trim() !== '' && csrfToken !== null;
  const missingIngredientIds = recipe === undefined
    ? []
    : recipe.ingredients.filter((item) => !item.optional && !availableIds.includes(item.ingredientId)).map((item) => item.ingredientId);
  const quantityWarnings = recipe === undefined
    ? []
    : recipe.ingredients
      .filter((item) => !item.optional && availableIds.includes(item.ingredientId))
      .filter((item) => getQuantityWarning(item, quantitySummaries.find((summary) => summary.ingredientId === item.ingredientId)))
      .map((item) => item.ingredientId);
  const availabilityTone = quantityWarnings.length > 0 || missingIngredientIds.length > 0
    ? 'border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] text-[var(--ik-warn-ink)]'
    : 'border-[var(--ik-border-strong)] bg-[var(--ik-sage)] text-[var(--ik-ink)]';

  useEffect(() => {
    setFavorite(currentPreference?.favorite ?? false);
    setRating(currentPreference?.rating ?? null);
    setPrivateNote(currentPreference?.note ?? '');
  }, [currentPreference]);

  useEffect(() => {
    setNutrition(metadata?.nutrition ?? null);
    setNutritionMessage(null);
  }, [metadata, recipeId]);

  // Reset the dinner confirmation whenever the shown recipe changes.
  const nextSelectionRecipeId = recipe?.id ?? null;
  if (nextSelectionRecipeId !== selectionRecipeId) {
    setSelectionRecipeId(nextSelectionRecipeId);
    setCookedServings(recipe === undefined || recipe.servings === null ? '' : String(recipe.servings));
    setConsumptionIngredients(buildConsumptionIngredients(recipe));
    setConsumptionNoneUsed(false);
    setConfirmedPlan(null);
    setConfirmedNoIngredientsUsed(false);
    setActivityError(null);
    setActivityMessage(null);
  }

  if (!recipe) return <NotFoundPage />;

  const servingsValue = recipe.servings ?? Number(cookedServings);
  const validServings = Number.isInteger(servingsValue) && servingsValue >= 1 ? servingsValue : null;

  const addMissingToShoppingList = () => {
    const added = addMissingRecipeIngredients(recipe, availableIds);
    setShoppingMessage(added > 0
      ? `${added} ${added === 1 ? 'ingrediente aggiunto' : 'ingredienti aggiunti'} alla lista.`
      : 'Non ci sono nuovi ingredienti mancanti da aggiungere.');
  };

  const confirmDinner = async () => {
    if (recipe === undefined || confirmingDinner) return;
    if (validServings === null) {
      setActivityError('Indica un numero di porzioni intero maggiore di zero.');
      return;
    }
    const ingredients = consumptionNoneUsed ? [] : consumptionIngredients;
    if (!consumptionNoneUsed && !ingredients.some((ingredient) => ingredient.used && ingredient.ingredientId !== null)) {
      setActivityError('Seleziona gli ingredienti utilizzati oppure spunta «Nessun ingrediente della dispensa utilizzato».');
      return;
    }
    const scope = getActiveDataScope();
    const cookedAt = new Date().toISOString();
    const event: CookEvent = {
      id: createLocalId('event'),
      recipeId: recipe.id,
      recipeTitle: recipe.title,
      servings: validServings,
      cookedAt,
      note: null,
      createdAt: cookedAt,
      updatedAt: cookedAt,
    };
    const entry: DinnerEntry = {
      id: event.id,
      date: localDateString(),
      text: recipe.title,
      servings: validServings,
      note: null,
      recipes: [{ recipeId: recipe.id, title: recipe.title, source: recipe.source === 'diary' ? 'diary' : 'catalog' }],
      authorId: scope === 'guest' ? null : user?.id ?? null,
      createdAt: cookedAt,
      updatedAt: cookedAt,
    };
    const command: DinnerConsumptionCommand = {
      operationId: createLocalId('consume'),
      entryId: entry.id,
      scope,
      servings: validServings,
      ingredients,
    };
    const plan = consumptionNoneUsed ? null : planPantryConsumption({ lots: pantryLots, command, updatedAt: cookedAt });
    if (plan !== null && plan.unresolvedIngredients.length > 0) {
      setActivityError('Chiarisci ogni ingrediente o quantità ambigua prima di confermare la cena.');
      return;
    }
    setActivityError(null);
    setActivityMessage(null);
    setConfirmingDinner(true);
    try {
      const eventId = await recordCookEvent(recipe, validServings, null, { command, event, entry });
      if (getActiveDataScope() !== scope) return;
      if (eventId === null) {
        setActivityError('Non è stato possibile registrare la cena: la dispensa non è stata aggiornata. Riprova.');
        return;
      }
      setConfirmedPlan(plan);
      setConfirmedNoIngredientsUsed(consumptionNoneUsed);
      setActivityMessage('Ricetta aggiunta alla cronologia.');
    } finally {
      setConfirmingDinner(false);
    }
  };

  const savePreference = () => {
    if (recipe === undefined) return;
    const saved = setRecipePreference(recipe.id, favorite, rating, privateNote);
    setPreferenceMessage(saved ? 'Preferenza salvata.' : 'Controlla la valutazione inserita.');
  };

  const refreshNutrition = async () => {
    if (!canRefreshNutrition || csrfToken === null || isRefreshingNutrition) return;
    setIsRefreshingNutrition(true);
    setNutritionMessage(null);
    try {
      const response = await apiRequest<{ nutrition?: unknown }>('/v1/recipes/nutrition', {
        method: 'POST',
        csrfToken,
        body: {
          ingredients: recipe.ingredients
            .filter((item) => !item.optional)
            .map((item) => ({
              query: item.name ?? getIngredient(item.ingredientId)?.label ?? item.ingredientId,
              grams: gramsPerServingFromAmount(item.amount, recipe.servings),
            })),
        },
      });
      if (!isRecipeNutrition(response?.nutrition)) throw new Error('Invalid nutrition response');
      setNutrition(response.nutrition);
      setNutritionMessage('Valori USDA aggiornati.');
    } catch (error) {
      setNutrition(metadata?.nutrition ?? null);
      setNutritionMessage(error instanceof ApiClientError && error.status === 503
        ? 'La stima USDA non è disponibile in questo momento: resta visibile la stima indicativa.'
        : 'Non è stato possibile aggiornare i valori: resta visibile la stima indicativa.');
    } finally {
      setIsRefreshingNutrition(false);
    }
  };

  return (
    <main id="main-content" className={`ik-page mx-auto min-h-screen w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8 ${RECIPE_DETAIL_FOCUS_CLASS}`}>
      <Link to="/" className="ik-back-link inline-flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-control)] px-2 py-2 font-semibold text-[var(--ik-basil-dark)] hover:bg-[var(--ik-mist)]">
        <ArrowLeft size={18} aria-hidden="true" />
        {returnLinkLabel}
      </Link>

      <header className="ik-recipe-hero mt-5 overflow-hidden p-4 text-[var(--ik-porcelain)] sm:p-6 lg:p-8">
        <RecipeImage recipeId={recipe.id} recipeTitle={recipe.title} variant="detail" />
        <div className="max-w-3xl">
          <p className="font-bold text-[var(--ik-recipe-category)]">{CATEGORY_LABELS[recipe.category]}</p>
          <h1 className="mt-2 text-[1.8rem] font-black leading-tight tracking-tight text-[var(--ik-porcelain)] sm:text-[2.4rem] lg:text-[3rem]">{recipe.title}</h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-[var(--ik-porcelain)] sm:text-lg">{recipe.description}</p>
          <dl className="mt-5 grid gap-2 sm:grid-cols-3">
            <div className="flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-pill)] border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-3 py-2 text-sm font-semibold text-[var(--ik-ink)]">
              <Clock size={18} aria-hidden="true" />
              <dt className="sr-only">Tempo</dt>
              <dd>{recipe.durationMinutes === null ? 'Tempo non indicato' : `${recipe.durationMinutes} min`}</dd>
            </div>
            <div className="flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-pill)] border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-3 py-2 text-sm font-semibold text-[var(--ik-ink)]">
              <Users size={18} aria-hidden="true" />
              <dt className="sr-only">Porzioni</dt>
              <dd>{recipe.servings === null ? 'Porzioni non indicate' : `${recipe.servings} porzioni`}</dd>
            </div>
            <div className="flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-pill)] border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-3 py-2 text-sm font-semibold text-[var(--ik-ink)]">
              <ChefHat size={18} aria-hidden="true" />
              <dt className="sr-only">Difficoltà</dt>
              <dd>{recipe.difficulty === 'easy' ? 'Facile' : recipe.difficulty === 'medium' ? 'Media' : 'Difficoltà non specificata'}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section aria-label="Disponibilità della ricetta" aria-live="polite" className={`mt-5 rounded-[var(--ik-radius-panel)] border p-4 sm:p-5 ${availabilityTone}`}>
        <p className="text-lg font-bold">{quantityWarnings.length > 0 ? 'Verifica le quantità' : missingIngredientIds.length > 0 ? 'Ingredienti mancanti' : 'Ingredienti disponibili'}</p>
        {quantityWarnings.length > 0 && <p className="mt-1 text-sm leading-relaxed">La quantità potrebbe non bastare per: {quantityWarnings.map((id) => getIngredient(id)?.label ?? id).join(', ')}. Verifica prima di cucinare.</p>}
        {missingIngredientIds.length > 0 && <p className="mt-1 text-sm leading-relaxed">Da acquistare: {missingIngredientIds.map((id) => getIngredient(id)?.label ?? recipe.ingredients.find((item) => item.ingredientId === id)?.name ?? id).join(', ')}.</p>}
        {missingIngredientIds.length === 0 && quantityWarnings.length === 0 && <p className="mt-1 text-sm leading-relaxed">Gli ingredienti risultano presenti in dispensa; verifica le quantità effettive.</p>}
      </section>

      <div className="grid gap-4 py-6 sm:gap-6 sm:py-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <PageSection
          title="Ingredienti"
          titleId="ingredients-title"
          className="bg-[var(--ik-surface)]"
          actionClassName="min-w-0 w-full sm:w-auto sm:shrink-0"
          action={
            <div className="min-w-0 w-full sm:w-auto">
              <button type="button" onClick={addMissingToShoppingList} className="ik-button-primary inline-flex min-h-12 w-full items-center justify-center gap-2 px-4 py-2 text-center text-sm font-bold sm:w-auto">
                <ShoppingCart size={17} aria-hidden="true" /> Aggiungi mancanti alla spesa
              </button>
            </div>
          }
        >
          {shoppingMessage !== null && (
            <div className="mt-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4 text-sm font-semibold text-[var(--ik-ink)]">
              <p role="status">{shoppingMessage}</p>
              <Link to="/shopping-list" className="mt-2 inline-flex min-h-11 items-center rounded-[var(--ik-radius-control)] font-bold text-[var(--ik-basil-dark)] underline underline-offset-2">Apri la lista della spesa</Link>
            </div>
          )}
          <ul className="divide-y divide-[var(--ik-border)]">
            {recipe.ingredients.map((item) => {
              const isMissing = missingIngredientIds.includes(item.ingredientId);
              const quantityNeedsReview = quantityWarnings.includes(item.ingredientId);
              return (
                <li key={item.ingredientId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span className="min-w-0 font-semibold text-[var(--ik-ink)]">{item.name ?? getIngredient(item.ingredientId)?.label ?? item.ingredientId}</span>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:justify-end">
                    <span className="text-sm font-semibold text-[var(--ik-ink-muted)]">{item.amount}{item.optional ? ' · facoltativo' : ''}</span>
                    {!item.optional && (
                      <span className={`rounded-[var(--ik-radius-pill)] px-3 py-1 text-xs font-bold ${quantityNeedsReview || isMissing ? 'bg-[var(--ik-yolk-soft)] text-[var(--ik-warn-ink)]' : 'bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'}`}>
                        {quantityNeedsReview ? 'Verifica quantità' : isMissing ? 'Da acquistare' : 'In dispensa'}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </PageSection>

        <PageSection title="Preparazione" titleId="steps-title" className="bg-[var(--ik-surface)]">
          <ol className="space-y-3">
            {recipe.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 sm:gap-4 sm:p-4">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--ik-basil)] font-black text-[var(--ik-porcelain)]" aria-hidden="true">{index + 1}</span>
                <p className="pt-1 leading-relaxed text-[var(--ik-ink)]">{step}</p>
              </li>
            ))}
          </ol>
        </PageSection>
      </div>

      <section aria-labelledby="dinner-confirm-title" className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-6">
        <h2 id="dinner-confirm-title" className="text-2xl font-black text-[var(--ik-ink)] sm:text-3xl">Conferma la cena</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ik-ink-muted)] sm:text-base">
          Dichiarate cosa avete usato dalla dispensa: solo gli ingredienti selezionati vengono scalati quando confermate.
        </p>
        <label htmlFor="cooked-servings" className="mt-4 grid max-w-xs gap-2 text-sm font-semibold text-[var(--ik-ink)]">
          Porzioni cucinate
          <input id="cooked-servings" type="number" min="1" step="1" value={cookedServings} onChange={(event) => setCookedServings(event.target.value)} className="ik-input min-h-12 w-full border-2 px-3 py-2" />
        </label>
        <DinnerConsumptionSelection
          mode="recipe"
          ingredients={consumptionIngredients}
          lots={pantryLots}
          servings={validServings}
          noneUsed={consumptionNoneUsed}
          onIngredientsChange={setConsumptionIngredients}
          onNoneUsedChange={setConsumptionNoneUsed}
          disabled={confirmingDinner}
          confirmedPlan={confirmedPlan}
          confirmedNoIngredientsUsed={confirmedNoIngredientsUsed}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => { void confirmDinner(); }} disabled={confirmingDinner} className="ik-button-primary min-h-12 w-full px-5 py-2 font-bold sm:w-auto">
            {confirmingDinner ? 'Confermo…' : 'Conferma cena'}
          </button>
        </div>
        {activityMessage !== null && <p role="status" className="mt-3 rounded-[var(--ik-radius-control)] bg-[var(--ik-sage)] p-3 text-sm font-semibold text-[var(--ik-basil-dark)]">{activityMessage}</p>}
        {activityError !== null && <p role="alert" className="mt-3 rounded-[var(--ik-radius-control)] bg-[var(--ik-tomato-soft)] p-3 text-sm font-semibold text-[var(--ik-tomato)]">{activityError}</p>}
      </section>

      <section aria-labelledby="recipe-actions-title" className="ik-surface--quiet mt-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] p-4 sm:p-6">
        <h2 id="recipe-actions-title" className="text-2xl font-black text-[var(--ik-ink)]">La tua esperienza</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" aria-pressed={favorite} onClick={() => setFavorite((value) => !value)} className="ik-button-secondary inline-flex min-h-12 w-full items-center justify-center gap-2 border-2 bg-[var(--ik-surface)] px-4 py-2 font-bold sm:w-auto">
            <Heart size={18} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
            {favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
          </button>
        </div>
        <div className="mt-5 grid gap-3 border-t border-[var(--ik-border)] pt-4">
          <span className="text-sm font-bold text-[var(--ik-ink)]">Valuta questa ricetta</span>
          <div role="group" aria-label="Valutazione" className="flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button key={value} type="button" aria-pressed={rating === value} aria-label={`Valuta ${recipe.title}: ${ratingLabel(value)}`} onClick={() => setRating(value)} className="grid min-h-11 min-w-11 place-items-center rounded-[var(--ik-radius-control)] text-[var(--ik-yolk)] hover:bg-[var(--ik-surface)]">
                <Star size={22} fill={rating !== null && value <= rating ? 'currentColor' : 'none'} aria-hidden="true" />
              </button>
            ))}
          </div>
          <label htmlFor="private-recipe-note" className="text-sm font-semibold text-[var(--ik-ink)]">Nota privata sulla ricetta</label>
          <textarea id="private-recipe-note" value={privateNote} onChange={(event) => setPrivateNote(event.target.value)} maxLength={500} rows={3} placeholder="Cosa vuoi ricordare?" className="ik-input min-h-24 resize-y border-2 px-3 py-2" />
          <button type="button" onClick={savePreference} className="ik-button-primary min-h-12 w-full px-4 py-2 font-bold sm:w-fit">Salva preferenza</button>
          {preferenceMessage !== null && <p role="status" className="text-sm font-semibold text-[var(--ik-basil-dark)]">{preferenceMessage}</p>}
        </div>
      </section>

      {metadata !== undefined && nutrition !== null && (
        <section aria-labelledby="nutrition-title" className="mt-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-6">
          <h2 id="nutrition-title" className="text-2xl font-black text-[var(--ik-ink)]">Nutrizione stimata per porzione</h2>
          <RecipeNutritionSummary nutrition={nutrition} />
          <p className="mt-3 text-sm font-semibold text-[var(--ik-ink-muted)]">
            Allergeni dichiarati: {metadata.allergens.length === 0 ? 'nessuno' : metadata.allergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}
          </p>
          {canRefreshNutrition && (
            <div className="mt-4">
              <button type="button" onClick={() => { void refreshNutrition(); }} disabled={isRefreshingNutrition} className="ik-button-primary min-h-12 w-full px-4 py-2 text-sm font-bold disabled:cursor-wait disabled:opacity-60 sm:w-auto">
                {isRefreshingNutrition ? 'Aggiornamento in corso…' : 'Aggiorna stima USDA'}
              </button>
              {nutritionMessage !== null && <p role="status" className="mt-2 text-sm font-semibold text-[var(--ik-ink-muted)]">{nutritionMessage}</p>}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
