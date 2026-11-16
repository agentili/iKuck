import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { useAuthStore } from '../auth/authStore';
import { adaptPantryRecipe, adaptGeneratedRecipe, adaptSavedRecipe, searchRecipes } from '../domain/recipeSearch';
import { RECIPES } from '../domain/recipes';
import {
  createAiRecipeCollectionOwner,
  isCurrentAiRecipeCollectionOwner,
  isSameAiRecipeCollectionOwner,
  type AiRecipeCollectionOwner,
} from '../ai/aiRecipeOwnership';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import ErrorBanner from '../components/ui/ErrorBanner';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';
import RecipeCard from '../components/ui/RecipeCard';
import AiRecipePanel from '../components/ai/AiRecipePanel';
import { hydrateDietProfileStore, useDietProfileStore } from '../store/dietProfileStore';

const PAGE_SECTION_CLASS = 'bg-[var(--ik-surface)] [&_h2]:text-[2rem] [&_h2]:leading-[1.12] [&_h2]:tracking-[-0.02em]';
const PAGE_INTERACTION_FOCUS_CLASS = [
  '[&_a:focus-visible]:outline',
  '[&_a:focus-visible]:outline-2',
  '[&_a:focus-visible]:outline-offset-2',
  '[&_a:focus-visible]:outline-[var(--ik-focus)]',
  '[&_button:focus-visible]:outline',
  '[&_button:focus-visible]:outline-2',
  '[&_button:focus-visible]:outline-offset-2',
  '[&_button:focus-visible]:outline-[var(--ik-focus)]',
].join(' ');

const scopeLabel = (scope: string): string => (
  scope.startsWith('house:') ? 'Casa' : scope === 'guest' ? 'dati locali' : 'personale'
);

const errorMessage = (error: unknown): string => {
  const code = error instanceof ApiClientError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 'network_error') return 'Servizio non raggiungibile: le ricette AI restano disponibili solo online.';
  return 'Non è stato possibile caricare le tue ricette AI. Riprova.';
};

const newestFirst = (
  a: { createdAt: string; updatedAt?: string | null },
  b: { createdAt: string; updatedAt?: string | null },
): number => (
  new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
);

interface SavedAiCollection {
  owner: AiRecipeCollectionOwner;
  recipes: GeneratedRecipe[];
  loading: boolean;
  error: string | null;
}

export default function RecipesPage() {
  const dietProfile = useDietProfileStore((state) => state.profile);
  const dietReady = useDietProfileStore((state) => state.hasHydrated);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const activeScope = useSyncExternalStore(
    (listener: () => void) => subscribeActiveDataScope(listener),
    getActiveDataScope,
    getActiveDataScope,
  );

  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const userId = user?.id ?? null;
  const currentAiOwner = useMemo(
    () => createAiRecipeCollectionOwner(userId, verified, csrfToken, activeScope),
    [userId, verified, csrfToken, activeScope],
  );

  const [query, setQuery] = useState('');
  const [libraryRecipes, setLibraryRecipes] = useState<SavedRecipe[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [savedAiCollection, setSavedAiCollection] = useState<SavedAiCollection | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedLibraryIds, setExpandedLibraryIds] = useState<Set<string>>(new Set());

  const currentSavedAiCollection = isSameAiRecipeCollectionOwner(savedAiCollection?.owner, currentAiOwner)
    ? savedAiCollection
    : null;
  const savedRecipes = useMemo(() => currentSavedAiCollection?.recipes ?? [], [currentSavedAiCollection]);
  const savedLoading = currentAiOwner !== null && (currentSavedAiCollection?.loading ?? true);
  const savedError = currentSavedAiCollection?.error ?? null;

  // RecipeDetailPage resolves /recipes/:id?scope= through the diary store, which
  // needs hydration before opening saved recipes: warm it up here
  // so «Apri ricetta» never lands on a not-found page straight from this list.
  useEffect(() => {
    void hydrateDinnerDiaryStore();
    void hydrateDietProfileStore();
  }, [activeScope]);

  useEffect(() => {
    let cancelled = false;
    const capturedScope = activeScope;

    setLibraryRecipes([]);
    setLibraryError(null);
    setLibraryLoading(true);
    void (async (): Promise<void> => {
      try {
        const recipes = await readSavedRecipes(capturedScope);
        if (cancelled || getActiveDataScope() !== capturedScope) return;
        setLibraryRecipes([...recipes].sort(newestFirst));
      } catch {
        if (!cancelled) setLibraryError('Non è stato possibile caricare le tue ricette salvate. Riprova.');
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeScope]);

  useEffect(() => {
    let cancelled = false;
    const capturedOwner = currentAiOwner;
    if (capturedOwner === null || !isCurrentAiRecipeCollectionOwner(capturedOwner)) return undefined;

    setSavedAiCollection((current) => {
      if (!isCurrentAiRecipeCollectionOwner(capturedOwner)) return current;
      if (current !== null && isSameAiRecipeCollectionOwner(current.owner, capturedOwner)) {
        return { ...current, loading: true, error: null };
      }
      return { owner: capturedOwner, recipes: [], loading: true, error: null };
    });
    void (async (): Promise<void> => {
      try {
        const recipes = await fetchAiRecipes();
        if (cancelled || !isCurrentAiRecipeCollectionOwner(capturedOwner)) return;
        setSavedAiCollection((current) => {
          if (!isCurrentAiRecipeCollectionOwner(capturedOwner)) return current;
          const existingRecipes = current !== null && isSameAiRecipeCollectionOwner(current.owner, capturedOwner)
            ? current.recipes
            : [];
          return {
            owner: capturedOwner,
            recipes: [...new Map([...recipes, ...existingRecipes].map((recipe) => [recipe.id, recipe])).values()].sort(newestFirst),
            loading: false,
            error: null,
          };
        });
      } catch (loadError: unknown) {
        if (cancelled || !isCurrentAiRecipeCollectionOwner(capturedOwner)) return;
        setSavedAiCollection((current) => {
          if (!isCurrentAiRecipeCollectionOwner(capturedOwner)) return current;
          const existing = current !== null && isSameAiRecipeCollectionOwner(current.owner, capturedOwner)
            ? current
            : null;
          return {
            owner: capturedOwner,
            recipes: existing?.recipes ?? [],
            loading: false,
            error: errorMessage(loadError),
          };
        });
      } finally {
        if (!cancelled && isCurrentAiRecipeCollectionOwner(capturedOwner)) {
          setSavedAiCollection((current) => current !== null && isSameAiRecipeCollectionOwner(current.owner, capturedOwner)
            ? { ...current, loading: false }
            : current);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [currentAiOwner]);

  const handleRecipeSaved = useCallback((recipe: GeneratedRecipe): void => {
    const capturedOwner = currentAiOwner;
    if (capturedOwner === null || !isCurrentAiRecipeCollectionOwner(capturedOwner)) return;
    setSavedAiCollection((current) => {
      if (!isCurrentAiRecipeCollectionOwner(capturedOwner)) return current;
      const existing = current !== null && isSameAiRecipeCollectionOwner(current.owner, capturedOwner)
        ? current
        : null;
      return {
        owner: capturedOwner,
        recipes: [recipe, ...(existing?.recipes ?? []).filter((item) => item.id !== recipe.id)],
        loading: existing?.loading ?? false,
        error: existing?.error ?? null,
      };
    });
  }, [currentAiOwner]);

  const suggestedRecipes = useMemo(
    () => [...RECIPES].sort((a, b) => a.title.localeCompare(b.title, 'it')),
    [],
  );

  const librarySearchable = useMemo(() => libraryRecipes.map(adaptSavedRecipe), [libraryRecipes]);
  const savedSearchable = useMemo(() => savedRecipes.map(adaptGeneratedRecipe), [savedRecipes]);
  const suggestedSearchable = useMemo(() => suggestedRecipes.map(adaptPantryRecipe), [suggestedRecipes]);

  const filteredLibraryIds = useMemo(
    () => new Set(searchRecipes(librarySearchable, query).map((item) => item.id)),
    [librarySearchable, query],
  );
  const filteredLibrary = useMemo(
    () => libraryRecipes.filter((recipe) => filteredLibraryIds.has(recipe.id)),
    [libraryRecipes, filteredLibraryIds],
  );
  const filteredSavedIds = useMemo(
    () => new Set(searchRecipes(savedSearchable, query).map((item) => item.id)),
    [savedSearchable, query],
  );
  const filteredSaved = useMemo(
    () => savedRecipes.filter((recipe) => filteredSavedIds.has(recipe.id)),
    [savedRecipes, filteredSavedIds],
  );
  const filteredSuggestedIds = useMemo(
    () => new Set(searchRecipes(suggestedSearchable, query).map((item) => item.id)),
    [suggestedSearchable, query],
  );
  const filteredSuggested = useMemo(
    () => suggestedRecipes.filter((recipe) => filteredSuggestedIds.has(recipe.id)),
    [suggestedRecipes, filteredSuggestedIds],
  );

  const isEmptySearch = query.length > 0
    && !libraryLoading
    && libraryError === null
    && (!verified || (!savedLoading && savedError === null))
    && filteredLibrary.length === 0
    && (!verified || filteredSaved.length === 0)
    && filteredSuggested.length === 0;

  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleLibraryExpanded = useCallback((id: string): void => {
    setExpandedLibraryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <main id="main-content" className={`ik-page ik-recipes-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 text-[var(--ik-ink)] sm:px-6 sm:pt-8 lg:px-8 ${PAGE_INTERACTION_FOCUS_CLASS}`}>
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em]">
          Ricette · {scopeLabel(activeScope)}
        </p>
        <h1 className="mt-1 text-[clamp(2rem,4.8vw,3rem)] font-black leading-[1.04] tracking-[-0.03em] text-[var(--ik-ink)]">Ricette</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--ik-ink-muted)]">
          Le tue ricette salvate, quelle generate con l’AI e il catalogo della casa.
        </p>

      </header>

      <div className="mb-6">
        <AiRecipePanel
          key={`${activeScope}:${userId ?? 'guest'}`}
          generationMode="title"
          generationReady={dietReady}
          ingredients={[]}
          dietProfile={dietProfile}
          user={user}
          csrfToken={csrfToken}
          onRecipeSaved={handleRecipeSaved}
        />
        {!verified && (
          <aside
            aria-labelledby="recipes-ai-access-title"
            className="mt-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5"
          >
            <h2 id="recipes-ai-access-title" className="text-xl font-black text-[var(--ik-ink)]">
              Ricette AI riservate agli account verificati
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">
              Le ricette AI richiedono un account verificato: accedi per vedere e gestire le tue ricette salvate.
            </p>
            <Link
              to="/profile"
              className="ik-button-secondary mt-3 inline-flex min-h-11 items-center border-2 px-4 py-2 font-bold hover:bg-[var(--ik-mist)]"
            >
              Accedi al tuo account
            </Link>
          </aside>
        )}
      </div>

      <div className="ik-kitchen-layout ik-kitchen-layout--two-columns mt-4">
        <div className="ik-kitchen-column min-w-0">
        <section aria-label="Ricerca tra le ricette" className="mb-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <label htmlFor="recipe-search" className="sr-only">Cerca ricette</label>
            <input
              id="recipe-search"
              type="search"
              aria-label="Cerca ricette"
              placeholder="Cerca per titolo o ingrediente…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ik-input block min-h-12 w-full border-2 px-4 py-2 text-[var(--ik-ink)] placeholder:text-[var(--ik-ink-muted)] focus:border-[var(--ik-basil)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:text-base"
            />
            <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">
              Filtra live per titolo o ingrediente; nessun dato lascia il dispositivo.
            </p>
          </div>
        </section>
        </div>

        <div className="ik-kitchen-column min-w-0">
        <PageSection
          title="La tua raccolta"
          titleId="recipe-collection-title"
          className={PAGE_SECTION_CLASS}
          description="Tutte le ricette salvate, generate con l’AI e del catalogo in un’unica raccolta."
        >
          {libraryLoading && <p role="status">Carico le tue ricette salvate…</p>}
          {savedLoading && <p role="status">Carico le tue ricette AI…</p>}
          {libraryError !== null && <ErrorBanner message={libraryError} />}
          {savedError !== null && <ErrorBanner message={savedError} />}
          {isEmptySearch && (
            <EmptyState
              text={`Nessuna ricetta trovata per «${query}». Prova un altro titolo o ingrediente.`}
              action={{ label: 'Trova ricette', href: '/', ariaLabel: 'Trova ricette' }}
            />
          )}
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              {filteredLibrary.map((recipe) => (
                <RecipeCard
                  key={`library:${recipe.id}`}
                  recipeId={recipe.id}
                  variant="salvata"
                  title={recipe.title}
                  description={recipe.description}
                  ingredients={recipe.ingredients}
                  showIngredientAmounts
                  steps={recipe.steps}
                  isExpanded={expandedLibraryIds.has(recipe.id)}
                  onToggle={() => toggleLibraryExpanded(recipe.id)}
                  detailsId={`library-recipe-details-${recipe.id}`}
                  openHref={`/recipes/${encodeURIComponent(recipe.id)}?scope=${encodeURIComponent(activeScope)}`}
                  openAriaLabel={`Apri ${recipe.title}`}
                />
              ))}
              {filteredSaved.map((recipe) => (
                <RecipeCard
                  key={`ai:${recipe.id}`}
                  recipeId={recipe.id}
                  variant="ai"
                  title={recipe.title}
                  ingredients={recipe.ingredients}
                  steps={recipe.steps}
                  isExpanded={expandedIds.has(recipe.id)}
                  onToggle={() => toggleExpanded(recipe.id)}
                  detailsId={`saved-recipe-details-${recipe.id}`}
                />
              ))}
              {filteredSuggested.map((recipe) => (
                <RecipeCard
                  key={`catalog:${recipe.id}`}
                  recipeId={recipe.id}
                  variant="catalogo"
                  title={recipe.title}
                  description={recipe.description}
                  openHref={`/recipes/${recipe.id}`}
                  openAriaLabel={`Apri ${recipe.title}`}
                />
              ))}
          </div>
        </PageSection>
        </div>
      </div>
    </main>
  );
}
