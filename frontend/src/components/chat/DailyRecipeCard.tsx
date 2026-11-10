import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getIngredient } from '@ikuck/shared/ingredients';
import { RECIPES } from '../../domain/recipes';
import { isDailyResultCurrent, type DailyRecipeSelection } from '../../domain/dailyRecipe';
import { getDailyRecipe, localDateKey } from '../../storage/dailyRecipeStorage';
import { hydratePantryStore, usePantryStore } from '../../store/localPantryStore';
import { hydrateDietProfileStore, useDietProfileStore } from '../../store/dietProfileStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

export function DailyRecipeCard() {
  const scope = useSyncExternalStore((listener) => subscribeActiveDataScope(() => listener()), getActiveDataScope, getActiveDataScope);
  const items = usePantryStore((state) => state.pantryItems);
  const staples = usePantryStore((state) => state.stapleIds);
  const pantryReady = usePantryStore((state) => state.hasHydrated);
  const profile = useDietProfileStore((state) => state.profile);
  const dietReady = useDietProfileStore((state) => state.hasHydrated);
  const availableIds = useMemo(() => [...items.filter((item) => item.known).map((item) => item.id), ...staples], [items, staples]);
  const [date, setDate] = useState(localDateKey);
  const [state, setState] = useState<{ scope: string; date: string; selection: DailyRecipeSelection | null; error: boolean } | null>(null);

  useEffect(() => { void hydratePantryStore(); void hydrateDietProfileStore(); }, [scope]);
  useEffect(() => {
    const timer = window.setInterval(() => setDate(localDateKey()), 30000);
    const refresh = () => setDate(localDateKey());
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    let current = true;
    setState(null);
    if (pantryReady && dietReady) {
      void getDailyRecipe({ scope, date, recipes: RECIPES, availableIds, profile }).then(
        (selection) => { if (current && getActiveDataScope() === scope) setState({ scope, date, selection, error: false }); },
        () => { if (current && getActiveDataScope() === scope) setState({ scope, date, selection: null, error: true }); },
      );
    }
    return () => { current = false; };
  }, [scope, date, availableIds, profile, pantryReady, dietReady]);

  const visibleState = state !== null && pantryReady && dietReady && isDailyResultCurrent(state, scope, date) ? state : null;
  const selection = visibleState?.selection ?? null;
  return (
    <section
      aria-label="Ricetta del giorno"
      className="chef-chat-recipe-card mx-4 my-2 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 shadow-[var(--ik-shadow-card)]"
    >
      {visibleState === null ? (
        <p className="mt-2 text-sm text-[var(--ik-ink-muted)]" role="status" aria-live="polite">Caricamento ricetta del giorno…</p>
      ) : visibleState.error ? (
        <p className="mt-2 rounded-xl border border-[var(--ik-tomato-soft)] bg-[var(--ik-tomato-soft)] p-3 text-sm text-[var(--ik-tomato)]" role="alert">
          Non è possibile salvare la proposta su questo dispositivo.
        </p>
      ) : selection === null ? (
        <p className="mt-2 text-sm text-[var(--ik-ink-muted)]" role="status">Nessuna ricetta compatibile disponibile nel catalogo.</p>
      ) : (
        <details key={`${scope}:${date}:${selection.recipe.id}`}>
          <summary className="min-h-11 cursor-pointer rounded-lg text-[var(--ik-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">
            <h3 className="inline text-xl font-bold leading-tight">{selection.recipe.title}</h3>
            <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">{selection.recipe.durationMinutes === null ? 'Tempo non disponibile' : `${selection.recipe.durationMinutes} minuti`}</p>
            {selection.missingIngredientIds.length > 0 && (
              <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Da aggiungere: {selection.missingIngredientIds.map((id) => getIngredient(id)?.label ?? id).join(', ')}.</p>
            )}
          </summary>
          <div className="mt-4 space-y-4 border-t border-[var(--ik-border)] pt-4 text-sm text-[var(--ik-ink)]">
            <p>{selection.recipe.description}</p>
            {selection.recipe.servings !== null && <p>{selection.recipe.servings} porzioni</p>}
            <div>
              <h4 className="mb-2 font-bold">Ingredienti</h4>
              <ul className="list-disc space-y-1 pl-5">
                {selection.recipe.ingredients.map((ingredient) => (
                  <li key={ingredient.ingredientId}>
                    {ingredient.amount} {ingredient.name ?? getIngredient(ingredient.ingredientId)?.label ?? ingredient.ingredientId}{ingredient.optional ? ' (facoltativo)' : ''}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 font-bold">Procedimento</h4>
              <ol className="list-decimal space-y-2 pl-5">
                {selection.recipe.steps.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
