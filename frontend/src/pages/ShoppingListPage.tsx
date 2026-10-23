import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../auth/authStore';
import { createBringApi } from '../bring/bringApi';
import BringIntegration from '../components/shopping/BringIntegration';
import ShoppingListPanel from '../components/shopping/ShoppingListPanel';
import { hydrateShoppingListStore, useShoppingListStore } from '../store/shoppingListStore';

const bringPageApi = createBringApi();

type ListSource = 'ikuck' | 'bring';

export default function ShoppingListPage() {
  const hasHydrated = useShoppingListStore((state) => state.hasHydrated);
  const items = useShoppingListStore((state) => state.items);
  const addItem = useShoppingListStore((state) => state.addItem);
  const togglePurchased = useShoppingListStore((state) => state.togglePurchased);
  const removeItem = useShoppingListStore((state) => state.removeItem);
  const restoreItem = useShoppingListStore((state) => state.restoreItem);
  const updateItem = useShoppingListStore((state) => state.updateItem);
  const clearPurchased = useShoppingListStore((state) => state.clearPurchased);
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? null;
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const canUseBring = user !== null && user.emailVerifiedAt.trim() !== '' && csrfToken !== null;
  const sessionKey = JSON.stringify([userId, csrfToken]);
  const choiceMadeFor = useRef<string | null>(null);
  const [sourceSelection, setSourceSelection] = useState<{ sessionKey: string; source: ListSource }>({ sessionKey, source: 'ikuck' });
  const source = sourceSelection.sessionKey === sessionKey ? sourceSelection.source : 'ikuck';
  const [checkedSessionKey, setCheckedSessionKey] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<{ sessionKey: string; message: string } | null>(null);
  const currentProviderError = providerError?.sessionKey === sessionKey ? providerError.message : null;
  const providerChecking = canUseBring && checkedSessionKey !== sessionKey && choiceMadeFor.current !== sessionKey;

  const chooseSource = (next: ListSource) => {
    choiceMadeFor.current = sessionKey;
    setSourceSelection({ sessionKey, source: next });
    setProviderError(null);
  };

  useEffect(() => {
    if (!canUseBring || userId === null || csrfToken === null) return;

    const controller = new AbortController();
    const stillCurrent = () => {
      const auth = useAuthStore.getState();
      return !controller.signal.aborted
        && auth.user?.id === userId
        && auth.user.emailVerifiedAt.trim() !== ''
        && auth.csrfToken === csrfToken;
    };

    void bringPageApi.status(controller.signal)
      .then((status) => {
        if (stillCurrent() && choiceMadeFor.current !== sessionKey) {
          setSourceSelection({ sessionKey, source: status.connected ? 'bring' : 'ikuck' });
        }
      })
      .catch(() => {
        if (stillCurrent() && choiceMadeFor.current !== sessionKey) {
          setProviderError({
            sessionKey,
            message: 'Non posso verificare il collegamento Bring!. Riprova oppure scegli esplicitamente la lista iKuck.',
          });
        }
      })
      .finally(() => {
        if (stillCurrent()) setCheckedSessionKey(sessionKey);
      });

    return () => controller.abort();
  }, [canUseBring, userId, csrfToken, sessionKey]);

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
        <div role="group" aria-label="Origine della lista" className="mb-4 flex flex-wrap gap-2">
          <button type="button" aria-pressed={source === 'ikuck'} onClick={() => chooseSource('ikuck')} className="ik-button-secondary min-h-11 px-4">iKuck</button>
          <button type="button" aria-pressed={source === 'bring'} onClick={() => chooseSource('bring')} className="ik-button-secondary min-h-11 px-4">Bring!</button>
        </div>
        {providerChecking ? (
          <p role="status">Verifico quale lista aprire…</p>
        ) : currentProviderError !== null ? (
          <p role="alert">{currentProviderError} Seleziona Bring! per riprovare il collegamento.</p>
        ) : source === 'ikuck' ? (
          <ShoppingListPanel items={items} onAdd={addItem} onTogglePurchased={togglePurchased} onRemove={removeItem} onRestoreItem={restoreItem} onUpdate={updateItem} onClearPurchased={clearPurchased} />
        ) : canUseBring ? (
          <BringIntegration key={`${user!.id}:${csrfToken!}`} userId={user!.id} csrfToken={csrfToken!} />
        ) : (
          <section className="ik-surface rounded-3xl p-4">
            <h2 className="text-2xl font-black">Lista Bring!</h2>
            <p>Per collegare Bring! accedi a un account iKuck verificato. La lista iKuck resta utilizzabile senza account e offline.</p>
            <Link to="/profile" className="ik-back-link inline-flex min-h-11 items-center">Accedi o verifica il tuo account</Link>
          </section>
        )}
      </div>
    </main>
  );
}
