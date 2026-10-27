import { useAuthStore } from '../auth/authStore';
import BringIntegration from '../components/shopping/BringIntegration';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import { Link } from 'react-router-dom';
import ShoppingListPanel from '../components/shopping/ShoppingListPanel';
import { hydrateShoppingListStore, useShoppingListStore } from '../store/shoppingListStore';



export default function ShoppingListPage() {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  return <ShoppingListPageContent key={JSON.stringify([scope, userId, csrfToken])} />;
}

function ShoppingListPageContent() {
  const [bringOpen, setBringOpen] = useState(false);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const verified = user !== null && user.emailVerifiedAt.trim() !== '' && csrfToken !== null;
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
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-4xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <Link to="/" className="ik-back-link inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50">
        <ArrowLeft size={18} aria-hidden="true" /> Torna alle ricette
      </Link>
      <div className="mt-6">
          <ShoppingListPanel items={items} onAdd={addItem} onTogglePurchased={togglePurchased} onRemove={removeItem} onRestoreItem={restoreItem} onUpdate={updateItem} onClearPurchased={clearPurchased} />
      </div>
      <details className="editorial-panel mt-8" onToggle={(event) => setBringOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer p-4 font-bold">Bring!</summary>
        {bringOpen && <div className="p-4">{verified
          ? <BringIntegration key={`${user.id}:${csrfToken}`} userId={user.id} csrfToken={csrfToken} />
          : <p>Per collegare Bring! serve un account verificato. <Link to="/profile" className="underline">Accedi o verifica il tuo account</Link>. La tua lista locale resta disponibile anche offline.</p>}
        </div>}
      </details>
    </main>
  );
}
