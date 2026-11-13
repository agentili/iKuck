import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { useAuthStore } from '../auth/authStore';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import RecipeCard from '../components/ui/RecipeCard';

const INTERACTION_FOCUS_CLASS = [
  '[&_a:focus-visible]:outline',
  '[&_a:focus-visible]:outline-2',
  '[&_a:focus-visible]:outline-offset-2',
  '[&_a:focus-visible]:outline-[var(--ik-focus)]',
  '[&_button:focus-visible]:outline',
  '[&_button:focus-visible]:outline-2',
  '[&_button:focus-visible]:outline-offset-2',
  '[&_button:focus-visible]:outline-[var(--ik-focus)]',
].join(' ');
const RECIPE_GRID_CLASS = [
  'grid grid-cols-1 gap-4 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]',
  '[&_article]:border-[var(--ik-border)]',
  '[&_article]:bg-[var(--ik-surface)]',
  '[&_article]:text-[var(--ik-ink)]',
  '[&_article_h3]:text-[var(--ik-ink)]',
  '[&_article_p]:text-[var(--ik-ink-muted)]',
  '[&_article_button]:min-h-11',
  '[&_article_button]:text-[var(--ik-ink-muted)]',
  '[&_article_a]:border-[var(--ik-border-strong)]',
  '[&_article_a]:text-[var(--ik-ink)]',
].join(' ');

const scopeLabel = (scope: string): string => (
  scope.startsWith('house:') ? 'Casa' : scope === 'guest' ? 'dati locali' : 'personale'
);

const newestFirst = <T extends { createdAt: string; updatedAt?: string | null }>(recipes: T[]): T[] => (
  [...recipes].sort((a, b) => (
    new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
  ))
);

const filterRecipesByTag = <T extends object>(recipes: T[], filterId: string): T[] => {
  if (filterId === 'all') return recipes;

  const tagMap: Record<string, string[]> = {
    veloce: ['Veloce'],
    vegetariano: ['Vegetariano'],
    carne: ['Carne', 'Proteico'],
    pesce: ['Pesce'],
    forno: ['Forno'],
  };
  const tags = tagMap[filterId];
  return tags
    ? recipes.filter((recipe) => (recipe as T & { tags?: string[] }).tags?.some((tag) => tags.includes(tag)))
    : recipes;
};

function SavedError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-sm font-semibold text-[var(--ik-tomato)]"
    >
      {message}
    </div>
  );
}

function SavedEmptyState({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-5 text-[var(--ik-ink-muted)]"
    >
      <p className="text-sm leading-relaxed">{text}</p>
    </div>
  );
}

export default function SavedPage() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const activeScope = useSyncExternalStore(
    (listener: () => void) => subscribeActiveDataScope(listener),
    getActiveDataScope,
    getActiveDataScope,
  );

  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const userId = user?.id ?? null;

  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [libraryRecipes, setLibraryRecipes] = useState<SavedRecipe[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [savedRecipes, setSavedRecipes] = useState<GeneratedRecipe[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void hydrateDinnerDiaryStore();
  }, []);

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
        setLibraryRecipes(newestFirst(recipes));
      } catch {
        if (!cancelled && getActiveDataScope() === capturedScope) {
          setLibraryError('Non è stato possibile caricare le ricette salvate. Riprova.');
        }
      } finally {
        if (!cancelled && getActiveDataScope() === capturedScope) setLibraryLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeScope]);

  useEffect(() => {
    let cancelled = false;
    const capturedUserId = userId;
    const capturedCsrfToken = csrfToken;
    const capturedVerified = verified;
    const capturedScope = activeScope;
    const isCurrentRequest = (): boolean => {
      if (cancelled || getActiveDataScope() !== capturedScope) return false;
      const { user: currentUser, csrfToken: currentToken } = useAuthStore.getState();
      return currentUser?.id === capturedUserId
        && currentToken === capturedCsrfToken
        && (currentUser !== null && currentUser.emailVerifiedAt.trim().length > 0 && currentToken !== null) === capturedVerified;
    };

    setSavedRecipes([]);
    setSavedError(null);
    if (!capturedVerified || capturedUserId === null) {
      setSavedLoading(false);
      return undefined;
    }

    setSavedLoading(true);
    void (async (): Promise<void> => {
      try {
        const recipes = await fetchAiRecipes();
        if (!isCurrentRequest()) return;
        setSavedRecipes(newestFirst(recipes));
      } catch (loadError: unknown) {
        if (isCurrentRequest()) {
          setSavedError(loadError instanceof ApiClientError ? loadError.message : 'Errore nel caricamento');
        }
      } finally {
        if (isCurrentRequest()) setSavedLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, csrfToken, verified, activeScope]);

  const librarySearchable = useMemo(() => libraryRecipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    ingredientNames: recipe.ingredients.map((ingredient) => ingredient.name ?? ingredient.ingredientId ?? ''),
  })), [libraryRecipes]);

  const savedSearchable = useMemo(() => savedRecipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    ingredientNames: recipe.ingredients.map((ingredient) => ingredient.name),
  })), [savedRecipes]);

  const filterMatches = useCallback((recipe: { id: string; title: string; ingredientNames: string[] }): boolean => {
    const normalizedQuery = query.toLocaleLowerCase('it').trim();
    return normalizedQuery.length === 0
      || [recipe.title, ...recipe.ingredientNames].some((text) => text.toLocaleLowerCase('it').includes(normalizedQuery));
  }, [query]);

  const filteredLibraryIds = useMemo(
    () => new Set(librarySearchable.filter(filterMatches).map((recipe) => recipe.id)),
    [librarySearchable, filterMatches],
  );
  const filteredLibrary = useMemo(
    () => filterRecipesByTag(libraryRecipes.filter((recipe) => filteredLibraryIds.has(recipe.id)), activeFilter),
    [libraryRecipes, filteredLibraryIds, activeFilter],
  );
  const filteredSavedIds = useMemo(
    () => new Set(savedSearchable.filter(filterMatches).map((recipe) => recipe.id)),
    [savedSearchable, filterMatches],
  );
  const filteredSaved = useMemo(
    () => filterRecipesByTag(savedRecipes.filter((recipe) => filteredSavedIds.has(recipe.id)), activeFilter),
    [savedRecipes, filteredSavedIds, activeFilter],
  );

  const sourcesLoaded = !libraryLoading && (!verified || !savedLoading);
  const sourcesAvailable = libraryError === null && (!verified || savedError === null);
  const hasNoSearchResults = query.trim().length > 0
    && sourcesLoaded
    && sourcesAvailable
    && filteredLibrary.length === 0
    && filteredSaved.length === 0;
  const isEmptyFilter = query.trim().length === 0
    && activeFilter !== 'all'
    && sourcesLoaded
    && sourcesAvailable
    && filteredLibrary.length === 0
    && filteredSaved.length === 0;

  const filters = [
    { id: 'all', label: 'Tutte', icon: null },
    { id: 'veloce', label: '< 20 min', icon: '⚡' },
    { id: 'vegetariano', label: 'Vegetariano', icon: '🌱' },
    { id: 'carne', label: 'Carne', icon: '🥩' },
    { id: 'pesce', label: 'Pesce', icon: '🐟' },
    { id: 'forno', label: 'Forno', icon: '🔥' },
  ];

  const applyFilter = useCallback((filterId: string) => setActiveFilter(filterId), []);
  const handleFilterKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, filterId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      applyFilter(filterId);
    }
  }, [applyFilter]);
  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <main id="main-content" className={`ik-page ik-saved-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 text-[var(--ik-ink)] sm:px-6 sm:pt-8 lg:px-8 ${INTERACTION_FOCUS_CLASS}`}>
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold text-[var(--ik-basil-dark)]">
          Ambito: {scopeLabel(activeScope)}
        </p>
        <h1 className="mt-1 text-[clamp(2rem,4.8vw,3rem)] font-black leading-[1.04] tracking-[-0.03em] text-[var(--ik-ink)]">
          Le tue ricette
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--ik-ink-muted)]">
          Ritrova qui le ricette del Diario e quelle generate con l’AI.
        </p>
      </header>

      <section
        aria-label="Ricerca ricette salvate"
        className="mb-5 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5"
      >
        <div className="flex min-w-0 gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--ik-ink-muted)]" aria-hidden="true" />
            <input
              id="recipe-search"
              type="search"
              aria-label="Cerca ricette"
              placeholder="Cerca per titolo o ingrediente…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ik-input block min-h-12 w-full border-2 border-[var(--ik-border-strong)] bg-[var(--ik-surface)] py-2 pl-12 pr-4 text-[var(--ik-ink)] placeholder:text-[var(--ik-ink-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:text-base"
            />
          </div>
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[var(--ik-radius-control)] text-[var(--ik-ink-muted)] hover:bg-[var(--ik-mist)] hover:text-[var(--ik-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
              aria-label="Pulisci ricerca"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">
          La ricerca confronta titoli e ingredienti sul dispositivo.
        </p>
      </section>

      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filtri categoria">
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => applyFilter(filter.id)}
            onKeyDown={(event) => handleFilterKeyDown(event, filter.id)}
            aria-pressed={activeFilter === filter.id}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-[var(--ik-radius-pill)] border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] ${
              activeFilter === filter.id
                ? 'ik-button-primary border-transparent'
                : 'border-[var(--ik-border)] bg-[var(--ik-sage)] text-[var(--ik-ink)] hover:border-[var(--ik-border-strong)] hover:bg-[var(--ik-mist)]'
            }`}
          >
            {filter.icon && <span aria-hidden="true">{filter.icon}</span>}
            {filter.label}
          </button>
        ))}
      </div>

      {isEmptyFilter && (
        <div className="mb-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-6" role="status">
          <p className="mb-3 text-[var(--ik-ink-muted)]">Nessuna ricetta corrisponde al filtro selezionato.</p>
          <button
            type="button"
            onClick={() => applyFilter('all')}
            className="ik-button-primary inline-flex min-h-11 items-center justify-center rounded-[var(--ik-radius-control)] px-4 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
          >
            Mostra tutte
          </button>
        </div>
      )}

      {hasNoSearchResults && (
        <div className="mb-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-6" role="status">
          <p className="mb-3 text-[var(--ik-ink-muted)]">Nessuna ricetta corrisponde alla ricerca.</p>
          <button
            type="button"
            onClick={() => setQuery('')}
            className="ik-button-primary inline-flex min-h-11 items-center justify-center rounded-[var(--ik-radius-control)] px-4 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
          >
            Pulisci la ricerca
          </button>
        </div>
      )}

      <div className="space-y-7">
        <section role="region" aria-labelledby="recipes-title" className="space-y-4">
          <h2 id="recipes-title" className="text-2xl font-black">Ricette</h2>
          {libraryLoading && <p role="status">Carico le ricette salvate…</p>}
          {savedLoading && <p role="status">Carico le ricette AI…</p>}
          {libraryError !== null && <SavedError message={libraryError} />}
          {savedError !== null && <SavedError message={savedError} />}
          {!libraryLoading && !savedLoading && !hasNoSearchResults && !isEmptyFilter && filteredLibrary.length === 0 && filteredSaved.length === 0 && <SavedEmptyState text={query.trim() ? 'Nessuna ricetta corrisponde alla ricerca.' : 'Nessuna ricetta salvata ancora.'} />}
          <div className={RECIPE_GRID_CLASS}>
              {filteredLibrary.map((recipe) => (
                <RecipeCard
                  key={`filteredLibrary:${recipe.id}`}
                  recipeId={recipe.id}
                  variant="salvata"
                  title={recipe.title}
                  description={recipe.description}
                  ingredients={recipe.ingredients}
                  showIngredientAmounts
                  steps={recipe.steps}
                  isExpanded={expandedIds.has(recipe.id)}
                  onToggle={() => toggleExpanded(recipe.id)}
                  detailsId={`library-recipe-details-${recipe.id}`}
                  openHref={`/recipes/${encodeURIComponent(recipe.id)}?scope=${encodeURIComponent(activeScope)}`}
                  openAriaLabel={`Apri ${recipe.title}`}
                />
              ))}
              {filteredSaved.map((recipe) => (
                <RecipeCard
                  key={`filteredSaved:${recipe.id}`}
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
          </div>
        </section>
      </div>
    </main>
  );
}
