import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { getIngredient } from '@ikuck/shared/ingredients';
import { RECIPES } from '../../domain/recipes';
import { isDailyResultCurrent, type DailyRecipeSelection } from '../../domain/dailyRecipe';
import { getDailyRecipe, localDateKey } from '../../storage/dailyRecipeStorage';
import { hydratePantryStore, usePantryStore } from '../../store/localPantryStore';
import { hydrateDietProfileStore, useDietProfileStore } from '../../store/dietProfileStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

export function DailyRecipeCard() {
  const scope = useSyncExternalStore((listener) => subscribeActiveDataScope(() => listener()), getActiveDataScope, getActiveDataScope);
  const items = usePantryStore((s) => s.pantryItems);
  const staples = usePantryStore((s) => s.stapleIds);
  const pantryReady = usePantryStore((s) => s.hasHydrated);
  const profile = useDietProfileStore((s) => s.profile);
  const dietReady = useDietProfileStore((s) => s.hasHydrated);
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
    <section aria-label="Ricetta del giorno" className="mx-4 my-3 rounded-2xl border border-[var(--sc-peach-soft)] bg-white p-4">
      <h2 className="font-bold text-[var(--sc-ink)]">Ricetta del giorno</h2>
      {visibleState === null ? <p>Caricamento…</p> : visibleState.error ? <p role="alert">Non è possibile salvare la proposta su questo dispositivo.</p> : selection === null ? <p>Nessuna ricetta compatibile disponibile nel catalogo.</p> : <>
        <h3 className="mt-1 text-lg font-bold">{selection.recipe.title}</h3>
        <p>{selection.recipe.durationMinutes === null ? 'Tempo non disponibile' : `${selection.recipe.durationMinutes} minuti`}</p>
        {selection.missingIngredientIds.length === 0 ? <p>Ingredienti presenti; verifica le quantità.</p> : <p>Ingredienti mancanti: {selection.missingIngredientIds.map((id) => getIngredient(id)?.label ?? id).join(', ')}. Verifica le quantità.</p>}
        {selection.reasons.length > 0 && <p>Proposta alternativa: {selection.reasons.includes('missing') ? 'richiede più di un ingrediente mancante' : ''}{selection.reasons.length > 1 ? '; ' : ''}{selection.reasons.includes('duration') ? 'supera 30 minuti o ha un tempo non disponibile' : ''}.</p>}
        <Link className="mt-2 inline-flex min-h-11 items-center underline" to={`/recipes/${selection.recipe.id}`}>Vedi ricetta</Link>
      </>}
    </section>
  );
}
