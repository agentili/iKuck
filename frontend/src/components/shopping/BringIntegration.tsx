import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH, type BringConnected, type BringList, type BringMutation, type BringSnapshot, type BringStatus } from '@ikuck/shared/bring';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { createBringApi } from '../../bring/bringApi';

const api = createBringApi();

const messages: Record<string, string> = {
  bring_busy: 'Un’operazione Bring! è già in corso. Attendi e aggiorna la lista.',
  bring_reconnect_required: 'Il collegamento è scaduto. Ricollega Bring!.',
  bring_not_connected: 'Collega Bring! per aprire la lista.',
  bring_stale_connection: 'Il collegamento è cambiato. Aggiorna e scegli di nuovo la lista.',
  bring_ambiguous_item: 'Questo nome compare più volte. Gestisci questi articoli nell’app Bring!.',
  bring_item_exists: 'L’articolo esiste con dettagli diversi. Aggiorna la lista e modifica la sua specifica.',
  bring_item_changed: 'L’articolo è cambiato. Aggiorna la lista prima di modificarlo.',
  bring_write_unconfirmed: 'Non posso confermare la modifica. Aggiorna la lista prima di riprovare.',
  bring_invalid_credentials: 'Non è stato possibile accedere a Bring!. Controlla email e password Bring!.',
  bring_list_not_found: 'Questa lista non è più accessibile. Aggiorna le liste.',
  bring_list_not_allowed: 'Questa lista non è abilitata: Bring! è attivo solo sulla lista di prova configurata.',
  rate_limited: 'Troppe richieste. Attendi prima di riprovare.',
};

const getErrorMessage = (failure: unknown): string => {
  if (failure instanceof ApiClientError) {
    return messages[failure.code] ?? 'Bring! non è disponibile. Riprova più tardi.';
  }
  return 'Bring! non è disponibile. Riprova più tardi.';
};

const normalizeItemName = (value: string) => value.trim().toLocaleLowerCase('it-IT');

const isMutableBringItem = (item: BringSnapshot['items'][number]) => item.mutable
  && item.name.length <= BRING_NAME_MAX_LENGTH
  && item.specification.length <= BRING_SPEC_MAX_LENGTH;

const hasVerifiedBringMutation = (input: BringMutation, snapshot: BringSnapshot) => {
  if (snapshot.connectionId !== input.connectionId || snapshot.listId !== input.listId) return false;
  if (input.action === 'add') {
    return snapshot.items.some((item) => item.state === 'purchase'
      && item.specification === input.specification
      && (normalizeItemName(item.name) === normalizeItemName(input.name)
        || normalizeItemName(item.label) === normalizeItemName(input.name)));
  }

  const matchingItems = snapshot.items.filter((item) => item.name === input.name);
  if (input.action === 'remove') return matchingItems.length === 0;
  if (matchingItems.length !== 1) return false;
  if (input.action === 'update') {
    return matchingItems[0]?.state === 'purchase' && matchingItems[0]?.specification === input.specification;
  }
  const expectedState = input.action === 'complete' ? 'recently' : 'purchase';
  return matchingItems[0]?.state === expectedState
    && matchingItems[0]?.specification === input.expectedSpecification;
};

export default function BringIntegration({ userId, csrfToken }: { userId: string; csrfToken: string }) {
  const sessionMatches = useAuthStore((auth) => (
    auth.user?.id === userId
      && auth.user.emailVerifiedAt.trim().length > 0
      && auth.csrfToken === csrfToken
  ));
  const [status, setStatus] = useState<BringStatus | null>(null);
  const [lists, setLists] = useState<BringList[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const [listId, setListId] = useState('');
  const [snapshot, setSnapshot] = useState<BringSnapshot | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [specification, setSpecification] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writePending = useRef<symbol | null>(null);

  const current = useCallback(() => {
    const auth = useAuthStore.getState();
    return mounted.current
      && auth.user?.id === userId
      && auth.user.emailVerifiedAt.trim().length > 0
      && auth.csrfToken === csrfToken;
  }, [userId, csrfToken]);

  const run = useCallback(async <T,>(work: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void) => {
    if (!current()) return;
    if (!navigator.onLine) {
      setError('Bring! richiede Internet. La lista iKuck resta disponibile offline.');
      return;
    }

    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const id = ++generation.current;
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const result = await work(active.signal);
      if (current() && generation.current === id && !active.signal.aborted) apply(result);
    } catch (failure) {
      if (current() && generation.current === id && !active.signal.aborted) {
        const code = failure instanceof ApiClientError ? failure.code : '';
        setError(getErrorMessage(failure));
        if (code === 'bring_reconnect_required' || code === 'bring_not_connected' || code === 'bring_stale_connection') {
          setReconnect(true);
          setSnapshot(null);
          setLists([]);
          setListId('');
        }
      }
    } finally {
      if (current() && generation.current === id) setBusy(false);
    }
  }, [current]);

  const loadLists = useCallback((connectionId: string) => run(
    (signal) => api.lists(connectionId, signal),
    (result) => {
      setLists(result.lists);
      setListsLoaded(true);
      setListId('');
      setSnapshot(null);
    },
  ), [run]);

  const loadStatus = useCallback(() => run((signal) => api.status(signal), (result) => {
    setStatus(result);
    setReconnect(false);
    setLists([]);
    setListsLoaded(false);
    setSnapshot(null);
    setListId('');
    if (result.connected && result.connectionId !== null) void loadLists(result.connectionId);
  }), [run, loadLists]);

  useEffect(() => {
    mounted.current = true;
    if (sessionMatches) void loadStatus();
    else {
      controller.current?.abort();
      generation.current += 1;
      writePending.current = null;
      setStatus(null);
      setLists([]);
      setListsLoaded(false);
      setSnapshot(null);
      setListId('');
      setEmail('');
      setPassword('');
      setConsent(false);
      setBusy(false);
    }

    const onNetwork = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {
        controller.current?.abort();
        generation.current += 1;
        setBusy(false);
        setMessage(null);
      }
    };
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);

    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
      writePending.current = null;
      window.removeEventListener('online', onNetwork);
      window.removeEventListener('offline', onNetwork);
    };
  }, [loadStatus, sessionMatches]);

  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!consent || !sessionMatches) return;
    const credentials = { email, password, confirmExternalAccess: true as const };
    setPassword('');
    void run((signal) => api.connect(credentials, csrfToken, signal), (result: BringConnected) => {
      setStatus(result);
      setLists(result.lists);
      setListsLoaded(true);
      setSnapshot(null);
      setListId('');
      setReconnect(false);
      setConsent(false);
      setMessage('Bring! collegato. Scegli la lista da aprire.');
    });
  };

  const select = (nextListId: string) => {
    setListId(nextListId);
    setSnapshot(null);
    if (nextListId !== '' && status?.connectionId) {
      void run((signal) => api.items(status.connectionId!, nextListId, signal), setSnapshot);
    }
  };

  const disconnect = () => {
    if (status?.connectionId === null || status?.connectionId === undefined) return;
    void run((signal) => api.disconnect(status.connectionId!, csrfToken, signal), () => {
      setStatus({ enabled: true, connected: false, connectionId: null });
      setLists([]);
      setListsLoaded(false);
      setSnapshot(null);
      setListId('');
      setReconnect(false);
      setMessage('Bring! scollegato da iKuck. Le liste su Bring! non sono state cancellate.');
    });
  };

  const write = (input: BringMutation, clearForm = false) => {
    if (writePending.current !== null || !current()) return;
    const writeId = Symbol('bring-write');
    writePending.current = writeId;
    void run(async (signal) => {
      const result = await api.write(input, csrfToken, signal);
      if (!hasVerifiedBringMutation(input, result)) {
        throw new ApiClientError(503, 'bring_write_unconfirmed', 'Bring write could not be confirmed');
      }
      return result;
    }, (result) => {
      setSnapshot(result);
      setMessage('Modifica confermata su Bring!.');
      if (clearForm) {
        setName('');
        setSpecification('');
      }
    }).finally(() => {
      if (writePending.current === writeId) writePending.current = null;
    });
  };

  const itemAction = (item: BringSnapshot['items'][number], action: BringMutation['action'], nextSpecification = item.specification) => {
    if (status?.connectionId === null || status?.connectionId === undefined || listId === '' || !isMutableBringItem(item)) return;
    write({
      connectionId: status.connectionId,
      listId,
      action,
      name: item.name,
      specification: nextSpecification,
      expectedSpecification: item.specification,
    });
  };

  const duplicatePurchaseItem = snapshot?.items.some((item) => item.state === 'purchase'
    && (normalizeItemName(item.name) === normalizeItemName(name)
      || normalizeItemName(item.label) === normalizeItemName(name))) ?? false;
  const addDisabled = !snapshot?.labelsAvailable
    || normalizeItemName(name).length === 0
    || name.trim().length > BRING_NAME_MAX_LENGTH
    || specification.length > BRING_SPEC_MAX_LENGTH
    || duplicatePurchaseItem;

  const disconnected = status === null || !status.connected || status.connectionId === null || reconnect;

  return (
    <section
      className="min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4 text-[var(--ik-ink)] shadow-[var(--ik-shadow-surface)] sm:p-6"
      aria-labelledby="bring-title"
    >
      <header className="min-w-0">
        <h2 id="bring-title" className="text-2xl font-black leading-tight sm:text-3xl">Lista Bring!</h2>
        <p className="mt-2 max-w-2xl leading-relaxed text-[var(--ik-ink-muted)]">La lista resta su Bring! e richiede Internet. La lista iKuck rimane separata.</p>
      </header>

      <div className="mt-4 grid gap-2">
        {!online && <p role="status" aria-label="Connessione offline" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] px-3 py-2.5 text-sm font-semibold leading-relaxed text-[var(--ik-warn-ink)]">Sei offline: i dati Bring! mostrati potrebbero non essere aggiornati. Le modifiche sono disabilitate.</p>}
        {busy && <p role="status" aria-label="Operazione Bring! in corso" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] px-3 py-2.5 text-sm font-semibold leading-relaxed text-[var(--ik-ink)]">Operazione Bring! in corso…</p>}
        {error !== null && <p role="alert" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-3 py-2.5 text-sm font-semibold leading-relaxed text-[var(--ik-tomato)]">{error}</p>}
        {message !== null && <p role="status" aria-label="Aggiornamento Bring!" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-basil)] bg-[var(--ik-sage)] px-3 py-2.5 text-sm font-semibold leading-relaxed text-[var(--ik-basil-dark)]">{message}</p>}
      </div>
      {sessionMatches && status?.connected && status.connectionId !== null && !reconnect && (
        <p role="status" aria-label="Stato collegamento Bring!" className="mt-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-basil)] bg-[var(--ik-sage)] px-3 py-2.5 text-sm font-semibold text-[var(--ik-basil-dark)]">
          Collegamento Bring! attivo.
        </p>
      )}

      {!sessionMatches ? (
        <p role="status" aria-label="Sessione verificata richiesta" className="mt-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm font-semibold leading-relaxed">Collega Bring! con una sessione verificata iKuck.</p>
      ) : (
        <>
          <button type="button" disabled={busy || !online} onClick={() => { void loadStatus(); }} className="ik-button-secondary mt-4 min-h-11 w-full border bg-[var(--ik-surface)] px-4 font-bold hover:bg-[var(--ik-sage)] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto">
            Aggiorna collegamento e liste
          </button>

          {status === null && !busy && <p className="mt-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm leading-relaxed text-[var(--ik-ink-muted)]">Controlla il collegamento a Bring! per continuare.</p>}
          {status?.enabled === false ? (
            <p className="mt-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm leading-relaxed">Bring! non è configurato su questa installazione.</p>
          ) : (
            <>
              {disconnected && status !== null && <form onSubmit={connect} className="mt-4">
                <fieldset disabled={busy || !online} className="grid min-w-0 gap-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4 sm:grid-cols-2">
                  <legend className="px-1 font-bold sm:col-span-2">{reconnect ? 'Ricollega Bring!' : 'Collega Bring!'}</legend>
                  <p className="rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 text-sm leading-relaxed text-[var(--ik-ink-muted)] sm:col-span-2">Le credenziali sono inviate a Bring! tramite il backend iKuck. La password non viene conservata; i token sono cifrati sul server. API non ufficiale.</p>
                  <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)]">Email Bring!
                    <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]" />
                  </label>
                  <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)]">Password Bring!
                    <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={256} required className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]" />
                  </label>
                  <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm font-semibold leading-relaxed text-[var(--ik-ink)] sm:col-span-2">
                    <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="size-5 shrink-0 accent-[var(--ik-basil)]" />
                    <span>Autorizzo iKuck ad accedere e modificare le mie liste Bring! quando lo richiedo.</span>
                  </label>
                  <button type="submit" disabled={!consent} className="ik-button-primary min-h-11 px-4 font-bold disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2">Collega Bring!</button>
                </fieldset>
              </form>}

              {status?.connected && status.connectionId !== null && <button type="button" disabled={busy || !online} className="ik-button-secondary mt-3 min-h-11 w-full border bg-[var(--ik-surface)] px-4 font-bold hover:bg-[var(--ik-sage)] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto" onClick={disconnect}>
                Scollega Bring!
              </button>}

              {!disconnected && <fieldset disabled={busy || !online} className="mt-4 grid min-w-0 gap-4 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4">
                <legend className="px-1 font-bold">Scegli cosa visualizzare su Bring!</legend>
                <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)]">Lista Bring!
                  <select value={listId} onChange={(event) => select(event.target.value)} className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]">
                    <option value="">Scegli una lista Bring!</option>
                    {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
                  </select>
                </label>
                {listId !== '' && <button type="button" className="ik-button-secondary min-h-11 w-full border bg-[var(--ik-surface)] px-4 font-bold hover:bg-[var(--ik-sage)] sm:w-auto" onClick={() => select(listId)}>Aggiorna lista Bring!</button>}
                {listsLoaded && lists.length === 0 && !busy && <p className="rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 text-sm leading-relaxed text-[var(--ik-ink-muted)]">Non ci sono liste Bring! disponibili.</p>}
                {listId === '' && lists.length > 0 && <p className="rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 text-sm leading-relaxed text-[var(--ik-ink-muted)]">Scegli una lista per leggerne gli articoli.</p>}
                {snapshot !== null && <>
                  {!snapshot.labelsAvailable && <p className="rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm leading-relaxed text-[var(--ik-warn-ink)]">Traduzioni non disponibili: sono mostrati i nomi originali Bring!.</p>}
                  <form className="grid min-w-0 gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] p-4 sm:grid-cols-2" onSubmit={(event) => {
                    event.preventDefault();
                    if (status?.connectionId && listId !== '' && !addDisabled) {
                      write({ connectionId: status.connectionId, listId, action: 'add', name: name.trim(), specification }, true);
                    }
                  }}>
                    <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)]">Cosa aggiungere a Bring!
                      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={BRING_NAME_MAX_LENGTH} required className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]" />
                    </label>
                    <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)]">Specifica Bring!
                      <input value={specification} onChange={(event) => setSpecification(event.target.value)} maxLength={BRING_SPEC_MAX_LENGTH} placeholder="es. 2 l, senza lattosio" className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]" />
                    </label>
                    <button type="submit" disabled={addDisabled} className="ik-button-primary min-h-11 w-full px-4 font-bold disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2 sm:w-auto">Aggiungi a Bring!</button>
                  </form>
                  {(['purchase', 'recently'] as const).map((group) => {
                    const items = snapshot.items.filter((item) => item.state === group);
                    if (items.length === 0) return null;
                    return (
                      <section key={group} aria-labelledby={`bring-${group}`} className="min-w-0">
                        <h3 id={`bring-${group}`} className="text-lg font-bold">{group === 'purchase' ? 'Da acquistare su Bring!' : 'Acquistati su Bring!'}</h3>
                        <ul className="mt-3 grid min-w-0 gap-3">
                          {items.map((item, index) => (
                            <li key={JSON.stringify([item.name, item.specification, item.state, index])} data-bring-name={item.name} className="min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 text-[var(--ik-ink)] sm:p-4">
                              <p className="break-words font-bold">{item.label}</p>
                              {item.specification !== '' && <p className="mt-1 break-words text-sm text-[var(--ik-ink-muted)]">{item.specification}</p>}
                              {!isMutableBringItem(item) && <p className="mt-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm font-semibold leading-relaxed text-[var(--ik-warn-ink)]">Articolo non modificabile in sicurezza: gestiscilo nell’app Bring!.</p>}
                              <div className="mt-3 grid min-w-0 gap-2 sm:flex sm:flex-wrap">
                                {group === 'purchase' && isMutableBringItem(item) && <button type="button" className="ik-button-secondary min-h-11 w-full border bg-[var(--ik-surface)] px-3 font-semibold hover:bg-[var(--ik-sage)] sm:w-auto" onClick={() => itemAction(item, 'complete')}>
                                  Segna {item.label} acquistato su Bring!
                                </button>}
                                {group === 'recently' && isMutableBringItem(item) && <button type="button" className="ik-button-secondary min-h-11 w-full border bg-[var(--ik-surface)] px-3 font-semibold hover:bg-[var(--ik-sage)] sm:w-auto" onClick={() => itemAction(item, 'restore')}>
                                  Ripristina {item.label} su Bring!
                                </button>}
                                {isMutableBringItem(item) && <button type="button" className="ik-button-secondary min-h-11 w-full border bg-[var(--ik-surface)] px-3 font-semibold hover:bg-[var(--ik-tomato-soft)] sm:w-auto" onClick={() => itemAction(item, 'remove')}>
                                  Rimuovi {item.label} da Bring!
                                </button>}
                              </div>
                              {group === 'purchase' && isMutableBringItem(item) && <details className="mt-3 border-t border-[var(--ik-border)] pt-2">
                                <summary className="flex min-h-11 cursor-pointer items-center rounded-[var(--ik-radius-control)] px-2 font-semibold text-[var(--ik-basil-dark)] underline underline-offset-2 hover:bg-[var(--ik-mist)]">Modifica specifica di {item.label}</summary>
                                <form className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2" onSubmit={(event) => {
                                  event.preventDefault();
                                  const value = new FormData(event.currentTarget).get('specification');
                                  if (typeof value === 'string') itemAction(item, 'update', value);
                                }}>
                                  <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--ik-ink)] sm:col-span-2">Nuova specifica di {item.label}
                                    <input name="specification" defaultValue={item.specification} maxLength={BRING_SPEC_MAX_LENGTH} className="ik-input min-h-11 w-full min-w-0 border-2 px-3 text-base focus-visible:border-[var(--ik-basil)]" />
                                  </label>
                                  <button type="submit" className="ik-button-primary min-h-11 w-full px-3 font-bold sm:col-span-2 sm:w-auto">Salva specifica di {item.label}</button>
                                </form>
                              </details>}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                  {snapshot.items.length === 0 && <p role="status" aria-label="Lista Bring! vuota" className="rounded-[var(--ik-radius-panel)] border border-dashed border-[var(--ik-border-strong)] bg-[var(--ik-surface)] p-4 text-sm font-semibold text-[var(--ik-ink-muted)]">La lista Bring! è vuota.</p>}
                </>}
              </fieldset>}
            </>
          )}
        </>
      )}
    </section>
  );
}
