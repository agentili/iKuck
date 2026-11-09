import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../auth/authStore';
import { createBringApi } from '../bring/bringApi';
import { isSousChef } from '../config/features';
import BringIntegration from '../components/shopping/BringIntegration';
import ShoppingListPanel from '../components/shopping/ShoppingListPanel';
import { hydrateShoppingListStore, useShoppingListStore } from '../store/shoppingListStore';

const bringPageApi = createBringApi();

type ListSource = 'ikuck' | 'bring';

export default function ShoppingListPage() {
  const sousChef = isSousChef();
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
  const activeSource = sousChef && (providerChecking || currentProviderError !== null) ? null : source;

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
      <main id={sousChef ? 'main-content' : undefined} className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8">
        <p role="status" className={sousChef
          ? 'rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] px-5 py-4 font-semibold text-[var(--ik-ink)]'
          : 'rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700'}>Caricamento della lista…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-4xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <header className={sousChef ? 'ik-page-intro mb-5 max-w-2xl' : ''}>
        <Link to="/" className={sousChef
          ? 'ik-back-link -ml-2 inline-flex min-h-11 items-center gap-2 rounded-[var(--ik-radius-control)] px-2 py-2 font-semibold underline underline-offset-2 hover:bg-[var(--ik-sage)]'
          : 'ik-back-link inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50'}>
          <ArrowLeft size={18} aria-hidden="true" /> {sousChef ? 'Torna a Chef' : 'Torna alle ricette'}
        </Link>
        {sousChef && (providerChecking || currentProviderError !== null || source === 'bring') && (
          <h1 className="mt-2 text-[1.5rem] font-extrabold leading-tight text-[var(--ik-ink)] sm:text-[1.8rem]">Spesa</h1>
        )}
      </header>
      <div className={sousChef ? 'min-w-0' : 'mt-6'}>
        <div role="group" aria-label="Origine della lista" className={sousChef
          ? 'mb-5 min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 sm:p-4'
          : 'mb-4 flex flex-wrap gap-2'}>
          {sousChef && <p className="mb-2 text-sm font-bold text-[var(--ik-ink)]">Scegli la lista</p>}
          <div className={sousChef ? 'grid min-w-0 gap-2 sm:flex sm:flex-wrap' : 'contents'}>
            {(['ikuck', 'bring'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={activeSource === option}
                onClick={() => chooseSource(option)}
                className={sousChef
                  ? `min-h-11 min-w-0 rounded-[var(--ik-radius-control)] border-2 px-4 py-2 text-left font-bold sm:text-center ${activeSource === option
                    ? 'border-[var(--ik-basil)] bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'
                    : 'border-[var(--ik-border-strong)] bg-[var(--ik-surface)] text-[var(--ik-ink)] hover:bg-[var(--ik-sage)]'}`
                  : 'ik-button-secondary min-h-11 px-4'}
              >{option === 'ikuck' ? 'iKuck' : 'Bring!'}</button>
            ))}
          </div>
          {sousChef && <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Liste separate: iKuck funziona anche offline, Bring! richiede Internet.</p>}
        </div>
        {sousChef && choiceMadeFor.current === sessionKey && currentProviderError === null && (
          <p role="status" aria-label="Origine selezionata" className="mb-4 text-sm font-semibold text-[var(--ik-basil-dark)]">
            {source === 'ikuck' ? 'Lista iKuck selezionata. Disponibile anche offline.' : 'Lista Bring! selezionata. Richiede Internet.'}
          </p>
        )}
        {providerChecking ? (
          <p role="status" className={sousChef
            ? 'rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4 py-3 font-semibold text-[var(--ik-ink)]'
            : ''}>Verifico quale lista aprire…</p>
        ) : currentProviderError !== null ? (
          <>
            <p role="alert" className={sousChef
              ? 'rounded-[var(--ik-radius-panel)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 font-semibold text-[var(--ik-tomato)]'
              : ''}>{currentProviderError} Seleziona Bring! per riprovare il collegamento.</p>
            {sousChef && (
              <button type="button" onClick={() => chooseSource('ikuck')} className="ik-button-secondary mt-3 min-h-11 w-full rounded-[var(--ik-radius-control)] border border-[var(--ik-border-strong)] bg-[var(--ik-surface)] px-4 py-2 text-left font-bold hover:bg-[var(--ik-sage)] sm:w-auto">
                Apri la lista locale offline
              </button>
            )}
          </>
        ) : source === 'ikuck' ? (
          <ShoppingListPanel items={items} onAdd={addItem} onTogglePurchased={togglePurchased} onRemove={removeItem} onRestoreItem={restoreItem} onUpdate={updateItem} onClearPurchased={clearPurchased} />
        ) : canUseBring ? (
          <BringIntegration key={`${user!.id}:${csrfToken!}`} userId={user!.id} csrfToken={csrfToken!} />
        ) : (
          <section className={sousChef
            ? 'max-w-2xl rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4 text-[var(--ik-ink)] sm:p-5'
            : 'ik-surface rounded-3xl p-4'}>
            <h2 className={sousChef ? 'text-xl font-extrabold' : 'text-2xl font-black'}>Lista Bring!</h2>
            <p className={sousChef ? 'mt-2 leading-relaxed text-[var(--ik-ink-muted)]' : ''}>Per collegare Bring! accedi a un account iKuck verificato. La lista iKuck resta utilizzabile senza account e offline.</p>
            <Link to="/profile" className={sousChef
              ? 'ik-back-link mt-3 inline-flex min-h-11 items-center font-bold underline underline-offset-2'
              : 'ik-back-link inline-flex min-h-11 items-center'}>Accedi o verifica il tuo account</Link>
            {sousChef && (
              <button type="button" onClick={() => chooseSource('ikuck')} className="ik-button-secondary mt-2 block min-h-11 w-full rounded-[var(--ik-radius-control)] border border-[var(--ik-border-strong)] bg-[var(--ik-surface)] px-4 py-2 text-left font-bold hover:bg-[var(--ik-sage)] sm:w-auto">
                Apri la lista locale offline
              </button>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
