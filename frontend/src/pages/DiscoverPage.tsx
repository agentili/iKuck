import { useMemo, useState, useCallback, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { RECIPES } from '../domain/recipes';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { useAuthStore } from '../auth/authStore';
import { useSyncExternalStore } from 'react';
import { adaptPantryRecipe, adaptGeneratedRecipe, adaptSavedRecipe, searchRecipes } from '../domain/recipeSearch';
import { useEffect } from 'react';
import RecipeCard from '../components/ui/RecipeCard';
import ErrorBanner from '../components/ui/ErrorBanner';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';

const PAGE_SECTION_CLASS = [
  'bg-[var(--ik-surface)]',
  'text-[var(--ik-ink)]',
  '[&_h2]:text-[var(--ik-ink)]',
  '[&_.ik-eyebrow]:text-[var(--ik-basil-dark)]',
  '[&_p]:text-[var(--ik-ink-muted)]',
].join(' ');
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
  if (error instanceof Error && error.message.includes('network')) {
    return 'Servizio non raggiungibile: le ricette AI restano disponibili solo online.';
  }
  return 'Non è stato possibile caricare le ricette. Riprova.';
};

const newestFirst = (
  a: { createdAt: string; updatedAt?: string | null },
  b: { createdAt: string; updatedAt?: string | null },
): number => (
  new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
);

const filterRecipesByTag = (recipes: any[], filterId: string): any[] => {
  if (filterId === 'all') return recipes;

  const tagMap: Record<string, string[]> = {
    veloce: ['veloce'],
    vegetariano: ['vegetariano', 'vegetariana', 'vegano', 'vegana'],
    carne: ['carne', 'proteico'],
    pesce: ['pesce'],
    forno: ['forno'],
  };
  const categoryMap: Record<string, string> = {
    carne: 'meat',
    pesce: 'fish',
  };

  const tags = tagMap[filterId];
  const category = categoryMap[filterId];
  if (!tags && !category) return recipes;

  return recipes.filter((recipe) => {
    if (category !== undefined && recipe.category === category) return true;
    return recipe.tags?.some((tag: string) => tags?.includes(tag.trim().toLocaleLowerCase('it')));
  });
};

export default function DiscoverPage() {
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
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [libraryRecipes, setLibraryRecipes] = useState<any[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [savedRecipes, setSavedRecipes] = useState<any[]>([]);
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
        setLibraryRecipes([...recipes].sort(newestFirst));
      } catch {
        if (!cancelled) setLibraryError('Non è stato possibile caricare le ricette salvate. Riprova.');
      } finally {
        if (!cancelled) setLibraryLoading(false);
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
        if (cancelled) return;

        const { user: currentUser, csrfToken: currentToken } = useAuthStore.getState();
        const stillVerified = currentUser !== null
          && currentUser.emailVerifiedAt.trim().length > 0
          && currentToken !== null;
        if (
          currentUser?.id !== capturedUserId
          || currentToken !== capturedCsrfToken
          || stillVerified !== capturedVerified
          || getActiveDataScope() !== capturedScope
        ) {
          return;
        }

        setSavedRecipes([...recipes].sort(newestFirst));
      } catch (loadError: unknown) {
        if (!cancelled) setSavedError(errorMessage(loadError));
      } finally {
        if (!cancelled) setSavedLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, csrfToken, verified, activeScope]);

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
    () => filterRecipesByTag(libraryRecipes.filter((recipe) => filteredLibraryIds.has(recipe.id)), activeFilter),
    [libraryRecipes, filteredLibraryIds, activeFilter],
  );
  const filteredSavedIds = useMemo(
    () => new Set(searchRecipes(savedSearchable, query).map((item) => item.id)),
    [savedSearchable, query],
  );
  const filteredSaved = useMemo(
    () => filterRecipesByTag(savedRecipes.filter((recipe) => filteredSavedIds.has(recipe.id)), activeFilter),
    [savedRecipes, filteredSavedIds, activeFilter],
  );
  const filteredSuggestedIds = useMemo(
    () => new Set(searchRecipes(suggestedSearchable, query).map((item) => item.id)),
    [suggestedSearchable, query],
  );
  const filteredSuggested = useMemo(
    () => filterRecipesByTag(suggestedRecipes.filter((recipe) => filteredSuggestedIds.has(recipe.id)), activeFilter),
    [suggestedRecipes, filteredSuggestedIds, activeFilter],
  );

  const recipeSourcesLoaded = !libraryLoading && (!verified || !savedLoading);
  const recipeSourcesAvailable = libraryError === null && (!verified || savedError === null);
  const isEmptySearch = query.trim().length > 0
    && recipeSourcesLoaded
    && recipeSourcesAvailable
    && filteredLibrary.length === 0
    && filteredSaved.length === 0
    && filteredSuggested.length === 0;

  const isEmptyFilter = query.trim().length === 0
    && activeFilter !== 'all'
    && recipeSourcesLoaded
    && recipeSourcesAvailable
    && filteredLibrary.length === 0
    && filteredSaved.length === 0
    && filteredSuggested.length === 0;

  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filters = [
    { id: 'all', label: 'Tutte', icon: null },
    { id: 'veloce', label: '< 20 min', icon: '⚡' },
    { id: 'vegetariano', label: 'Vegetariano', icon: '🌱' },
    { id: 'carne', label: 'Carne', icon: '🥩' },
    { id: 'pesce', label: 'Pesce', icon: '🐟' },
    { id: 'forno', label: 'Forno', icon: '🔥' },
  ];

  const applyFilter = useCallback((filterId: string) => {
    setActiveFilter(filterId);
  }, []);

  const handleFilterKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, filterId: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      applyFilter(filterId);
    }
  }, [applyFilter]);

  return (
    <main id="main-content" className={`ik-page ik-discover-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 text-[var(--ik-ink)] sm:px-6 sm:pt-8 lg:px-8 ${PAGE_INTERACTION_FOCUS_CLASS}`}>
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em]">
          Ambito: {scopeLabel(activeScope)}
        </p>
        <h1 className="mt-1 text-[clamp(2rem,4.8vw,3rem)] font-black leading-[1.04] tracking-[-0.03em] text-[var(--ik-ink)]">Cerca ricette</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--ik-ink-muted)]">
          Cerca per titolo, ingrediente o filtra per categoria.
        </p>
      </header>

      <section aria-label="Ricerca ricette" className="mb-5 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 sm:p-5">
        <div className="flex min-w-0 gap-3">
          <div className="relative min-w-0 flex-1">
            <label htmlFor="recipe-search" className="sr-only">Cerca ricette</label>
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--ik-ink-muted)]" aria-hidden="true" />
            <input
              id="recipe-search"
              type="search"
              aria-label="Cerca ricette"
              placeholder="Cerca per titolo o ingrediente…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ik-input block min-h-12 w-full border-2 py-2 pl-12 pr-4 text-[var(--ik-ink)] placeholder:text-[var(--ik-ink-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:text-base"
            />
          </div>
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-[var(--ik-ink-muted)] hover:bg-[var(--ik-mist)] hover:text-[var(--ik-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
              aria-label="Pulisci ricerca"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">
          Titolo e ingredienti vengono confrontati sul dispositivo. Le ricette AI richiedono un account verificato.
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

      {/* Empty filter state */}
      {isEmptyFilter && (
        <div className="mb-6 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-8 text-center" role="status">
          <p className="mb-3 text-[var(--ik-ink-muted)]">Nessuna ricetta corrisponde al filtro selezionato.</p>
          <button
            type="button"
            onClick={() => applyFilter('all')}
            className="ik-button-primary inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-2 text-sm font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
          >
            Mostra tutte
          </button>
        </div>
      )}

      {/* Results */}
      <div className="space-y-8">
        <PageSection title="Ricette" titleId="recipes-title" className={PAGE_SECTION_CLASS}>
          {libraryLoading && <p role="status">Carico le ricette salvate…</p>}
          {savedLoading && <p role="status">Carico le ricette AI…</p>}
          {libraryError !== null && <ErrorBanner message={libraryError} />}
          {savedError !== null && <ErrorBanner message={savedError} />}
          {isEmptySearch && <div className="space-y-3">
            <EmptyState text={`Nessuna ricetta trovata per «${query}». Prova un altro titolo o ingrediente.`} />
            <button type="button" onClick={() => setQuery('')} className="ik-button-secondary min-h-11 px-4 py-2">Pulisci la ricerca</button>
          </div>}
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
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
              {filteredSuggested.map((recipe) => (
                <RecipeCard
                  key={`filteredSuggested:${recipe.id}`}
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
    </main>
  );
}