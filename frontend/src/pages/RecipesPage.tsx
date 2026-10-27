import AiRecipePanel from '../components/ai/AiRecipePanel';
import { usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import PaginatedList from '../components/ui/PaginatedList';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LockKeyhole } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import type { SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { ApiClientError } from '../api/apiClient';
import { fetchAiRecipes } from '../ai/aiRecipeApi';
import { useAuthStore } from '../auth/authStore';
import { adaptPantryRecipe, adaptGeneratedRecipe, adaptSavedRecipe, searchRecipes } from '../domain/recipeSearch';
import { RECIPES } from '../domain/recipes';
import { readSavedRecipes } from '../storage/dinnerDiaryStorage';
import { hydrateDinnerDiaryStore } from '../store/dinnerDiaryStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import ErrorBanner from '../components/ui/ErrorBanner';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';
import RecipeCard from '../components/ui/RecipeCard';

const LIBRARY_GROUP_LABEL = 'Le tue ricette salvate';
const AI_GROUP_LABEL = 'Le tue ricette AI';
const SUGGESTED_GROUP_LABEL = 'Ricette suggerite';

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

export default function RecipesPage() {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  return <RecipesPageContent key={JSON.stringify([scope, userId, csrfToken])} />;
}

function RecipesPageContent() {
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
  const [aiOpen, setAiOpen] = useState(false);
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const dietProfile = useDietProfileStore((state) => state.profile);
  const [libraryRecipes, setLibraryRecipes] = useState<SavedRecipe[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [savedRecipes, setSavedRecipes] = useState<GeneratedRecipe[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedLibraryIds, setExpandedLibraryIds] = useState<Set<string>>(new Set());

  // RecipeDetailPage resolves /recipes/:id?scope= through the diary store, which
  // hydrates only on scope changes or when the diary page mounts: warm it up here
  // so «Apri ricetta» never lands on a not-found page straight from this list.
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
        if (!cancelled) setLibraryError('Non è stato possibile caricare le tue ricette salvate. Riprova.');
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

  const toggleLibraryExpanded = useCallback((id: string): void => {
    setExpandedLibraryIds((current) => {
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
          Ricette · {scopeLabel(activeScope)}
        </p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-gray-950 sm:text-5xl">Ricette</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-gray-700">
          Le tue ricette salvate, quelle generate con l’AI e il catalogo della casa.
        </p>
      </header>

      <div className="ik-kitchen-layout ik-kitchen-layout--two-columns mt-4">
        <div className="ik-kitchen-column min-w-0">
        <section aria-label="Ricerca tra le ricette" className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] p-4 sm:p-5 mb-6">
          <div className="min-w-0 flex-1">
            <label className="sr-only">Cerca ricette</label>
            <input
              id="recipe-search"
              type="search"
              aria-label="Cerca ricette"
              placeholder="Cerca per titolo o ingrediente…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="block min-h-11 w-full rounded-xl border-2 border-gray-300 bg-white px-4 py-2 text-gray-900 focus:border-emerald-700 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-emerald-700 sm:text-base"
            />
            <p className="mt-2 text-xs text-gray-600">
              Filtra live per titolo o ingrediente; nessun dato lascia il dispositivo.
            </p>
          </div>
        </section>
        </div>

        <div className="ik-kitchen-column min-w-0">
        <PageSection
          eyebrow="Dal diario"
          title={LIBRARY_GROUP_LABEL}
          titleId="library-recipes-title"
          description="Le ricette che hai salvato dal Diario, disponibili anche offline."
          action={
            libraryLoading && (
              <p role="status" className="text-sm font-semibold text-emerald-900">
                Carico le tue ricette salvate…
              </p>
            )
          }
        >
          {libraryError !== null && <ErrorBanner message={libraryError} />}
          {!libraryLoading && libraryError === null && libraryRecipes.length === 0 && (
            <EmptyState text="Nessuna ricetta salvata ancora." />
          )}
          {!libraryLoading && libraryError === null && filteredLibrary.length > 0 && (
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              <PaginatedList identity={`${activeScope}:${query}:filteredLibrary`} label="ricette salvate">{filteredLibrary.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
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
              ))}</PaginatedList>
            </div>
          )}
        </PageSection>

        <PageSection
          eyebrow="Generate con l’AI"
          title={AI_GROUP_LABEL}
          titleId="ai-recipes-title"
          action={
            savedLoading && (
              <p role="status" className="text-sm font-semibold text-emerald-900">
                Carico le tue ricette AI…
              </p>
            )
          }
        >
          {savedError !== null && <ErrorBanner message={savedError} />}
          {!verified && (
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/70 p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-700 text-white">
                  <LockKeyhole size={19} aria-hidden="true" />
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
          {verified && !savedLoading && savedError === null && savedRecipes.length === 0 && (
            <EmptyState text="Nessuna ricetta AI salvata ancora." />
          )}
          {verified && !savedLoading && savedError === null && filteredSaved.length > 0 && (
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              <PaginatedList identity={`${activeScope}:${query}:filteredSaved`} label="ricette AI">{filteredSaved.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  variant="ai"
                  title={recipe.title}
                  ingredients={recipe.ingredients}
                  steps={recipe.steps}
                  isExpanded={expandedIds.has(recipe.id)}
                  onToggle={() => toggleExpanded(recipe.id)}
                  detailsId={`saved-recipe-details-${recipe.id}`}
                />
              ))}</PaginatedList>
            </div>
          )}
        </PageSection>

        <PageSection
          eyebrow="Catalogo della casa"
          title={SUGGESTED_GROUP_LABEL}
          titleId="suggested-recipes-title"
          description="Ricette offline, sempre disponibili."
        >
          {isEmptySearch && (
            <EmptyState
              text={`Nessuna ricetta trovata per «${query}». Prova un altro titolo o ingrediente.`}
              action={{
                label: 'Trova ricette',
                href: '/',
                ariaLabel: 'Trova ricette',
              }}
            />
          )}
          {!isEmptySearch && (
            <div className="grid gap-4 grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
              <PaginatedList identity={`${activeScope}:${query}:filteredSuggested`} label="catalogo">{filteredSuggested.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  variant="catalogo"
                  title={recipe.title}
                  description={recipe.description}
                  openHref={`/recipes/${recipe.id}`}
                  openAriaLabel={`Apri ${recipe.title}`}
                />
              ))}</PaginatedList>
            </div>
          )}
        </PageSection>
        </div>
      </div>
      <details className="editorial-panel mt-8" onToggle={(event) => setAiOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer p-4 font-bold">Crea con AI</summary>
        {aiOpen && <div className="p-4"><AiRecipePanel key={`${activeScope}:${userId ?? 'guest'}:${csrfToken ?? ''}`} ingredients={pantryItems.map((item) => item.label)} dietProfile={dietProfile} user={user} csrfToken={csrfToken} /></div>}
      </details>
    </main>
  );
}
