import { hydrateShoppingListStore, useShoppingListStore } from '../../store/shoppingListStore';
import { hydrateActivityStore, useActivityStore } from '../../store/activityStore';

export default function LocalStorageRecoveryNotice() {
  const shoppingError = useShoppingListStore(state => state.hydrationError);
  const activityError = useActivityStore(state => state.hydrationError);
  if (!shoppingError && !activityError) return null;
  return <div role="alert" className="m-4 rounded-xl border border-amber-500 bg-amber-50 p-4 text-amber-950">
    <p>Non posso leggere {shoppingError && activityError ? 'spesa e attività' : shoppingError ? 'la spesa' : 'l’attività'} dalla memoria locale. I dati conservati non sono stati cancellati. Le modifiche a questi dati sono sospese fino al recupero.</p>
    <button type="button" className="mt-2 min-h-11 rounded-lg border px-4 font-bold" onClick={() => {
      if (shoppingError) void hydrateShoppingListStore();
      if (activityError) void hydrateActivityStore();
    }}>Riprova lettura dati</button>
  </div>;
}
