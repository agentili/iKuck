import { useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useAuthStore } from '../auth/authStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { ApiClientError } from '../api/apiClient';
import { useEffect } from 'react';
import RecipeCard from '../components/ui/RecipeCard';
import ErrorBanner from '../components/ui/ErrorBanner';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';

const LIBRARY_GROUP_LABEL = 'Le tue ricette salvate';

const scopeLabel = (scope: string): string => (
  scope.startsWith('house:') ? 'Casa' : scope === 'guest' ? 'dati locali' : 'personale'
);

const filterRecipesByTag = (recipes: any[], filterId: string): any[] => {
  if (filterId === 'all') return recipes;
  
  const tagMap: Record<string, string[]> = {
    'veloce': ['Veloce'],
    'vegetariano': ['Vegetariano'],
    'carne': ['Carne', 'Proteico'],
    'pesce': ['Pesce'],
    'forno': ['Forno'],
  };
  
  const tags = tagMap[filterId];
  if (!tags) return recipes;
  
  return recipes.filter(recipe => 
    recipe.tags?.some((tag: string) => tags.includes(tag))
  );
};

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
        setLibraryRecipes([...recipes].sort((a, b) => 
          new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
        ));
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

        setSavedRecipes([...recipes].sort((a, b) => 
          new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
        ));
      } catch (loadError: unknown) {
        if (!cancelled) setSavedError(loadError instanceof ApiClientError ? loadError.message : 'Errore nel caricamento');
      } finally {
        if (!cancelled) setSavedLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [userId, csrfToken, verified, activeScope]);

  const librarySearchable = useMemo(() => libraryRecipes.map((r) => ({
    id: r.id,
    title: r.title,
    ingredientNames: r.ingredients.map((i: any) => i.name ?? i.ingredientId),
    createdAt: r.createdAt,
  })), [libraryRecipes]);

  const savedSearchable = useMemo(() => savedRecipes.map((r) => ({
    id: r.id,
    title: r.title,
    ingredientNames: r.ingredients.map((i: any) => i.name),
    createdAt: r.createdAt,
  })), [savedRecipes]);

  const filteredLibraryIds = useMemo(
    () => new Set(librarySearchable
      .filter((recipe) => {
        const normalizedQuery = query.toLowerCase().trim();
        if (!normalizedQuery) return true;
        return [recipe.title, ...recipe.ingredientNames].some((text) => 
          text.toLowerCase().includes(normalizedQuery)
        );
      })
      .map((item) => item.id)),
    [librarySearchable, query],
  );
  const filteredLibrary = useMemo(
    () => filterRecipesByTag(libraryRecipes.filter((recipe) => filteredLibraryIds.has(recipe.id)), activeFilter),
    [libraryRecipes, filteredLibraryIds, activeFilter],
  );
  const filteredSavedIds = useMemo(
    () => new Set(savedSearchable
      .filter((recipe) => {
        const normalizedQuery = query.toLowerCase().trim();
        if (!normalizedQuery) return true;
        return [recipe.title, ...recipe.ingredientNames].some((text) => 
          text.toLowerCase().includes(normalizedQuery)
        );
      })
      .map((item) => item.id)),
    [savedSearchable, query],
  );
  const filteredSaved = useMemo(
    () => filterRecipesByTag(savedRecipes.filter((recipe) => filteredSavedIds.has(recipe.id)), activeFilter),
    [savedRecipes, filteredSavedIds, activeFilter],
  );

  const isEmptyFilter = query.length === 0
    && activeFilter !== 'all'
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

  const applyFilter = useCallback((filterId: string) => {
    setActiveFilter(filterId);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent, filterId: string) => {
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
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-6xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">
          Salvate · {scopeLabel(activeScope)}
        </p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-5xl">Le tue ricette</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700">
          Le ricette che hai salvato dal Diario e quelle generate con l'AI.
        </p>
      </header>

      {/* Search Bar */}
      <section className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] p-4 sm:p-5 mb-6">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              id="recipe-search"
              type="search"
              aria-label="Cerca ricette"
              placeholder="Cerca per titolo o ingrediente…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="block min-h-11 w-full rounded-xl border-2 border-gray-300 bg-white pl-12 pr-4 py-2 text-gray-900 focus:border-emerald-700 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-emerald-700 sm:text-base"
            />
          </div>
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="p-2 rounded-xl text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="Pulisci ricerca"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-600">
          Filtra live per titolo o ingrediente; nessun dato lascia il dispositivo.
        </p>
      </section>

      {/* Filter Chips */}
      <div className="flex flex-wrap gap-2 mb-6" role="group" aria-label="Filtri categoria">
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => applyFilter(filter.id)}
            onKeyDown={(e) => handleKeyDown(e, filter.id)}
            aria-pressed={activeFilter === filter.id}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-colors focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--sc-terracotta)] ${
              activeFilter === filter.id
                ? 'bg-[var(--sc-terracotta)] text-[var(--sc-cream)]'
                : 'bg-[var(--sc-peach-soft)] text-[var(--sc-terracotta)] hover:bg-[var(--sc-apricot-soft)]'
            }`}
          >
            {filter.icon && <span aria-hidden="true">{filter.icon}</span>}
            {filter.label}
          </button>
        ))}
      </div>

      {/* Empty filter state */}
      {isEmptyFilter && (
        <div className="text-center py-12 px-4" role="status">
          <p className="text-[var(--sc-ink-soft)] mb-2">Nessuna ricetta corrisponde al filtro selezionato.</p>
          <button
            type="button"
            onClick={() => applyFilter('all')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium bg-[var(--sc-terracotta)] text-[var(--sc-cream)] hover:bg-[var(--sc-terracotta-strong)]"
          >
            Mostra tutte
          </button>
        </div>
      )}

      <div className="space-y-8">
        {/* Diary Recipes */}
        <PageSection
          eyebrow="Dal diario"
          title={LIBRARY_GROUP_LABEL}
          titleId="library-recipes-title"
          description="Le ricette che hai salvato dal Diario, disponibili anche offline."
          action={libraryLoading && <p role="status" className="text-sm font-semibold text-emerald-900">Carico le ricette salvate…</p>}
        >
          {libraryError !== null && <ErrorBanner message={libraryError} />}
          {!libraryLoading && libraryError === null && filteredLibrary.length === 0 && (
            <EmptyState text={activeFilter !== 'all' ? "Nessuna ricetta salvata nel diario corrisponde al filtro." : "Nessuna ricetta salvata nel diario."} />
          )}
          {!libraryLoading && libraryError === null && filteredLibrary.length > 0 && (
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              {filteredLibrary.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
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
            </div>
          )}
        </PageSection>

        {/* AI Recipes */}
        <PageSection
          eyebrow="Generate con l'AI"
          title="Le tue ricette AI"
          titleId="ai-recipes-title"
          action={savedLoading && <p role="status" className="text-sm font-semibold text-emerald-900">Carico le ricette AI…</p>}
        >
          {savedError !== null && <ErrorBanner message={savedError} />}
          {!verified && (
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/70 p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-700 text-white">
                  🔒
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-black text-gray-950">Ricette AI riservate agli account verificati</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-700">
                    Le ricette AI richiedono un account verificato: accedi per vedere e gestire le tue ricette salvate.
                  </p>
                  <Link
                    to="/profile"
                    className="mt-3 inline-flex min-h-11 items-center rounded-xl border-2 border-emerald-700 px-4 py-2 font-bold text-emerald-900 hover:bg-emerald-50"
                  >
                    Accedi al tuo account
                  </Link>
                </div>
              </div>
            </div>
          )}
          {verified && !savedLoading && savedError === null && filteredSaved.length === 0 && (
            <EmptyState text={activeFilter !== 'all' ? "Nessuna ricetta AI salvata corrisponde al filtro." : "Nessuna ricetta AI salvata ancora."} />
          )}
          {verified && !savedLoading && savedError === null && filteredSaved.length > 0 && (
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              {filteredSaved.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  variant="ai"
                  title={recipe.title}
                  ingredients={recipe.ingredients}
                  steps={recipe.steps}
                  isExpanded={expandedIds.has(recipe.id)}
                  onToggle={() => { const next = new Set(expandedIds); next.has(recipe.id) ? next.delete(recipe.id) : next.add(recipe.id); setExpandedIds(next); }}
                  detailsId={`saved-recipe-details-${recipe.id}`}
                />
              ))}
            </div>
          )}
        </PageSection>
      </div>
    </main>
  );
}