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

      <div className="ik-kitchen-layout mt-4">
        <section aria-label="Ricerca tra le ricette" className="rounded-3xl border-2 p-4 sm:p-5 mb-6">
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

        <section aria-labelledby="library-recipes-title" className="space-y-4 rounded-3xl border-2 p-4 sm:p-5 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Dal diario</p>
              <h2 id="library-recipes-title" className="mt-1 text-2xl font-black text-gray-950">{LIBRARY_GROUP_LABEL}</h2>
              <p className="mt-1 text-sm leading-relaxed text-gray-700">
                Le ricette che hai salvato dal Diario, disponibili anche offline.
              </p>
            </div>
            {libraryLoading && (
              <p role="status" className="text-sm font-semibold text-emerald-900">
                Carico le tue ricette salvate…
              </p>
            )}
          </div>

          {libraryError !== null && (
            <p role="alert" className="rounded-xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900">
              {libraryError}
            </p>
          )}

          {!libraryLoading && libraryError === null && libraryRecipes.length === 0 && (
            <p className="rounded-xl border-2 border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
              Nessuna ricetta salvata ancora.
            </p>
          )}

          {!libraryLoading && libraryError === null && filteredLibrary.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {filteredLibrary.map((recipe) => (
                <article key={recipe.id} className="rounded-2xl border-2 border-emerald-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="text-xl font-black text-gray-950">{recipe.title}</h3>
                      <span className="whitespace-nowrap rounded-full border-2 border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                        Salvata
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleLibraryExpanded(recipe.id)}
                      aria-expanded={expandedLibraryIds.has(recipe.id)}
                      aria-controls={`library-recipe-details-${recipe.id}`}
                      className="shrink-0 rounded-xl p-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                    >
                      {expandedLibraryIds.has(recipe.id) ? 'Nascondi dettagli' : 'Mostra dettagli'}
                    </button>
                  </div>
                  {recipe.description.trim().length > 0 && (
                    <p className="mb-3 text-sm leading-relaxed text-gray-600">{recipe.description}</p>
                  )}
                  {expandedLibraryIds.has(recipe.id) && (
                    <div id={`library-recipe-details-${recipe.id}`} className="space-y-3">
                      <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">Ingredienti</h4>
                      <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                        {recipe.ingredients.map((ingredient, index) => (
                          <li key={`${ingredient.name}-${index}`}>
                            <span>{ingredient.name}</span>
                            {ingredient.amount.trim().length > 0 && (
                              <span className="ml-1 text-gray-500">{ingredient.amount}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">Procedimento</h4>
                      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
                        {recipe.steps.map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <Link
                    to={`/recipes/${encodeURIComponent(recipe.id)}?scope=${encodeURIComponent(activeScope)}`}
                    aria-label={`Apri ${recipe.title}`}
                    className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white"
                  >
                    Apri ricetta
                  </Link>
                </article>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="ai-recipes-title" className="space-y-4 rounded-3xl border-2 p-4 sm:p-5 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Generate con l’AI</p>
              <h2 id="ai-recipes-title" className="mt-1 text-2xl font-black text-gray-950">{AI_GROUP_LABEL}</h2>
            </div>
            {savedLoading && (
              <p role="status" className="text-sm font-semibold text-emerald-900">
                Carico le tue ricette AI…
              </p>
            )}
          </div>

          {savedError !== null && (
            <p role="alert" className="rounded-xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900">
              {savedError}
            </p>
          )}

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
            <p className="rounded-xl border-2 border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
              Nessuna ricetta AI salvata ancora.
            </p>
          )}

          {verified && !savedLoading && savedError === null && filteredSaved.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {filteredSaved.map((recipe) => (
                <article key={recipe.id} className="rounded-2xl border-2 border-emerald-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-black text-gray-950">{recipe.title}</h3>
                      <span className="rounded-full border-2 border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                        AI
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(recipe.id)}
                      aria-expanded={expandedIds.has(recipe.id)}
                      aria-controls={`saved-recipe-details-${recipe.id}`}
                      className="rounded-xl p-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                    >
                      {expandedIds.has(recipe.id) ? 'Nascondi dettagli' : 'Mostra dettagli'}
                    </button>
                  </div>
                  {expandedIds.has(recipe.id) && (
                    <div id={`saved-recipe-details-${recipe.id}`} className="space-y-3">
                      <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">Ingredienti</h4>
                      <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                        {recipe.ingredients.map((ingredient) => (
                          <li key={ingredient.name}>{ingredient.name}</li>
                        ))}
                      </ul>
                      <h4 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">Procedimento</h4>
                      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
                        {recipe.steps.map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="suggested-recipes-title" className="space-y-4 rounded-3xl border-2 p-4 sm:p-5 mb-6">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Catalogo della casa</p>
            <h2 id="suggested-recipes-title" className="mt-1 text-2xl font-black text-gray-950">{SUGGESTED_GROUP_LABEL}</h2>
            <p className="mt-1 text-sm leading-relaxed text-gray-700">
              Ricette offline, sempre disponibili.
            </p>
          </div>

          {isEmptySearch && (
            <div className="rounded-xl border-2 border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-700">
                Nessuna ricetta trovata per «{query}». Prova un altro titolo o ingrediente.
              </p>
              <Link
                to="/"
                className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white"
              >
                Trova ricette
              </Link>
            </div>
          )}

          {!isEmptySearch && (
            <div className="grid gap-4 lg:grid-cols-2">
              {filteredSuggested.map((recipe) => (
                <article key={recipe.id} className="rounded-2xl border-2 border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <h3 className="text-xl font-black text-gray-950">{recipe.title}</h3>
                    <span className="rounded-full border-2 border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-bold text-gray-900">
                      Catalogo
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-gray-600">{recipe.description}</p>
                  <Link
                    to={`/recipes/${recipe.id}`}
                    aria-label={`Apri ${recipe.title}`}
                    className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white"
                  >
                    Apri ricetta
                  </Link>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
