import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import ShoppingListPanel from '../components/shopping/ShoppingListPanel';
import { hydrateShoppingListStore, useShoppingListStore } from '../store/shoppingListStore';

export default function ShoppingListPage() {
  const hasHydrated = useShoppingListStore((state) => state.hasHydrated);
  const items = useShoppingListStore((state) => state.items);
  const addItem = useShoppingListStore((state) => state.addItem);
  const togglePurchased = useShoppingListStore((state) => state.togglePurchased);
  const removeItem = useShoppingListStore((state) => state.removeItem);
  const restoreItem = useShoppingListStore((state) => state.restoreItem);
  const updateItem = useShoppingListStore((state) => state.updateItem);
  const clearPurchased = useShoppingListStore((state) => state.clearPurchased);

  useEffect(() => {
    void hydrateShoppingListStore();
  }, []);

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">Caricamento della lista…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto min-h-screen w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50">
        <ArrowLeft size={18} aria-hidden="true" /> Torna alla dispensa
      </Link>
      <div className="mt-6">
        <ShoppingListPanel items={items} onAdd={addItem} onTogglePurchased={togglePurchased} onRemove={removeItem} onRestoreItem={restoreItem} onUpdate={updateItem} onClearPurchased={clearPurchased} />
      </div>
    </main>
  );
}
