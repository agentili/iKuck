import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BRING_NAME_MAX_LENGTH, BRING_SPEC_MAX_LENGTH, type BringConnected, type BringImportResult, type BringList, type BringMutation, type BringSnapshot, type BringStatus } from '@ikuck/shared/bring';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { createBringApi } from '../../bring/bringApi';
import { syncVerifiedSession } from '../../sync/syncQueue';

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
  bring_list_not_allowed: 'Questa lista non è abilitata su questa installazione.',
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

const buildImportMessage = (result: BringImportResult): string => {
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`Importati ${result.imported} articoli nella lista iKuck.`);
  if (result.skipped > 0) parts.push(`${result.skipped} erano già presenti o non importabili.`);
  if (result.recently > 0) parts.push(`${result.recently} articoli acquistati non sono stati importati.`);
  if (parts.length === 0) return 'Nessun articolo da importare nella lista iKuck.';
  return parts.join(' ');
};

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
  const [importConfirm, setImportConfirm] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const writePending = useRef<symbol | null>(null);
  const importPending = useRef<symbol | null>(null);

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
      importPending.current = null;
      setStatus(null);
      setLists([]);
      setListsLoaded(false);
      setSnapshot(null);
      setListId('');
      setEmail('');
      setPassword('');
      setConsent(false);
      setImportConfirm(false);
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
      importPending.current = null;
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
    setImportConfirm(false);
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

  const refreshShoppingList = () => {
    const auth = useAuthStore.getState();
    const user = auth.user;
    const token = auth.csrfToken;
    if (user === null || token === null || user.emailVerifiedAt === '') return;
    const session = { userId: user.id, emailVerifiedAt: user.emailVerifiedAt, csrfToken: token };
    void syncVerifiedSession(session, {
      isSessionCurrent: () => {
        const currentAuth = useAuthStore.getState();
        return currentAuth.user?.id === session.userId && currentAuth.csrfToken === session.csrfToken;
      },
    });
  };

  const importList = () => {
    const connectionId = status?.connectionId ?? null;
    if (connectionId === null || listId === '' || snapshot === null) return;
    if (importPending.current !== null || !current()) return;
    const importId = Symbol('bring-import');
    importPending.current = importId;
    setImportConfirm(false);
    void run(
      (signal) => api.importList({ connectionId, listId }, csrfToken, signal),
      (result) => {
        setMessage(buildImportMessage(result));
        refreshShoppingList();
      },
    ).finally(() => {
      if (importPending.current === importId) importPending.current = null;
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
  const purchaseCount = snapshot === null ? 0 : snapshot.items.filter((item) => item.state === 'purchase').length;
  const recentlyCount = snapshot === null ? 0 : snapshot.items.filter((item) => item.state === 'recently').length;

  return (
    <section className="ik-surface rounded-3xl border-2 bg-white p-4 sm:p-6" aria-labelledby="bring-title">
      <h2 id="bring-title" className="text-3xl font-black">Lista Bring!</h2>
      <p className="mt-2 text-[var(--ik-ink-muted)]">La lista resta su Bring! e richiede Internet. La lista iKuck rimane separata.</p>
      {!online && <p role="status" className="mt-3">Sei offline: i dati Bring! mostrati potrebbero non essere aggiornati. Le modifiche sono disabilitate.</p>}
      {busy && <p role="status" className="mt-3">Operazione Bring! in corso…</p>}
      {error !== null && <p role="alert" className="mt-3 text-[var(--ik-tomato)]">{error}</p>}
      {message !== null && <p role="status" className="mt-3 text-[var(--ik-basil-dark)]">{message}</p>}

      {!sessionMatches ? (
        <p role="status" className="mt-4">Collega Bring! con una sessione verificata iKuck.</p>
      ) : (
        <>
          <button type="button" disabled={busy || !online} onClick={() => { void loadStatus(); }} className="ik-button-secondary mt-3 min-h-11 border px-3">
            Aggiorna collegamento e liste
          </button>

          {status === null && !busy && <p className="mt-4">Controlla il collegamento a Bring! per continuare.</p>}
          {status?.enabled === false ? (
            <p className="mt-4">Bring! non è configurato su questa installazione.</p>
          ) : (
            <>
              {disconnected && status !== null && <form onSubmit={connect} className="mt-4">
                <fieldset disabled={busy || !online} className="grid gap-3">
                  <legend className="font-bold">{reconnect ? 'Ricollega Bring!' : 'Collega Bring!'}</legend>
                  <p>Le credenziali sono inviate a Bring! tramite il backend iKuck. La password non viene conservata; i token sono cifrati sul server. API non ufficiale.</p>
                  <label className="grid gap-1">Email Bring!
                    <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required className="ik-input min-h-11 px-3" />
                  </label>
                  <label className="grid gap-1">Password Bring!
                    <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={256} required className="ik-input min-h-11 px-3" />
                  </label>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                    Autorizzo iKuck ad accedere e modificare le mie liste Bring! quando lo richiedo.
                  </label>
                  <button type="submit" disabled={!consent} className="ik-button-primary min-h-11 px-4">Collega Bring!</button>
                </fieldset>
              </form>}

              {status?.connected && status.connectionId !== null && <button type="button" disabled={busy || !online} className="ik-button-secondary mt-3 min-h-11 border px-3" onClick={disconnect}>
                Scollega Bring!
              </button>}

              {!disconnected && <fieldset disabled={busy || !online} className="mt-4 grid gap-4">
                <legend className="font-bold">Scegli cosa visualizzare su Bring!</legend>
                <label className="grid gap-1">Lista Bring!
                  <select value={listId} onChange={(event) => select(event.target.value)} className="ik-input min-h-11 px-3">
                    <option value="">Scegli una lista Bring!</option>
                    {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
                  </select>
                </label>
                {listId !== '' && <button type="button" className="ik-button-secondary min-h-11 border px-3" onClick={() => select(listId)}>Aggiorna lista Bring!</button>}
                {listsLoaded && lists.length === 0 && !busy && <p>Non ci sono liste Bring! disponibili.</p>}
                {listId === '' && lists.length > 0 && <p>Scegli una lista per leggerne gli articoli.</p>}
                {snapshot !== null && <>
                  {!snapshot.labelsAvailable && <p>Traduzioni non disponibili: sono mostrati i nomi originali Bring!.</p>}
                  <div className="mt-1">
                    <button type="button" disabled={busy || !online} className="ik-button-secondary min-h-11 border px-3" onClick={() => setImportConfirm(true)}>
                      Importa nella lista iKuck
                    </button>
                  </div>
                  {importConfirm && (
                    <div role="group" aria-labelledby="bring-import-title" className="mt-3 rounded-xl border border-[var(--ik-border)] p-3">
                      <p id="bring-import-title" className="font-bold">Importa nella lista iKuck</p>
                      <p className="mt-2">{purchaseCount} articoli da acquistare da importare</p>
                      {recentlyCount > 0 && <p className="mt-1">{recentlyCount} già acquistati su Bring! non verranno importati</p>}
                      <p className="mt-2">Copia una tantum: la lista su Bring! NON viene modificata e le due liste restano separate. Nessuna sincronizzazione continua.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" disabled={busy || !online} className="ik-button-primary min-h-11 px-4" onClick={importList}>
                          Conferma importazione
                        </button>
                        <button type="button" disabled={busy || !online} className="ik-button-secondary min-h-11 px-3" onClick={() => setImportConfirm(false)}>
                          Annulla
                        </button>
                      </div>
                    </div>
                  )}
                  <form className="grid gap-3" onSubmit={(event) => {
                    event.preventDefault();
                    if (status?.connectionId && listId !== '' && !addDisabled) {
                      write({ connectionId: status.connectionId, listId, action: 'add', name: name.trim(), specification }, true);
                    }
                  }}>
                    <label className="grid gap-1">Cosa aggiungere a Bring!
                      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={BRING_NAME_MAX_LENGTH} required className="ik-input min-h-11 px-3" />
                    </label>
                    <label className="grid gap-1">Specifica Bring!
                      <input value={specification} onChange={(event) => setSpecification(event.target.value)} maxLength={BRING_SPEC_MAX_LENGTH} placeholder="es. 2 l, senza lattosio" className="ik-input min-h-11 px-3" />
                    </label>
                    <button type="submit" disabled={addDisabled} className="ik-button-primary min-h-11 px-4">Aggiungi a Bring!</button>
                  </form>
                  {(['purchase', 'recently'] as const).map((group) => {
                    const items = snapshot.items.filter((item) => item.state === group);
                    if (items.length === 0) return null;
                    return (
                      <section key={group} aria-labelledby={`bring-${group}`}>
                        <h3 id={`bring-${group}`} className="font-bold">{group === 'purchase' ? 'Da acquistare su Bring!' : 'Acquistati su Bring!'}</h3>
                        <ul className="mt-3 grid gap-3">
                          {items.map((item, index) => (
                            <li key={JSON.stringify([item.name, item.specification, item.state, index])} data-bring-name={item.name} className="rounded-xl border border-[var(--ik-border)] p-3">
                              <p className="break-words font-bold">{item.label}</p>
                              {item.specification !== '' && <p className="break-words">{item.specification}</p>}
                              {!isMutableBringItem(item) && <p>Articolo non modificabile in sicurezza: gestiscilo nell’app Bring!.</p>}
                              {group === 'purchase' && isMutableBringItem(item) && <button type="button" className="ik-button-secondary mt-2 min-h-11 px-3" onClick={() => itemAction(item, 'complete')}>
                                Segna {item.label} acquistato su Bring!
                              </button>}
                              {group === 'recently' && isMutableBringItem(item) && <button type="button" className="ik-button-secondary mt-2 min-h-11 px-3" onClick={() => itemAction(item, 'restore')}>
                                Ripristina {item.label} su Bring!
                              </button>}
                              {isMutableBringItem(item) && <button type="button" className="ik-button-secondary mt-2 min-h-11 px-3" onClick={() => itemAction(item, 'remove')}>
                                Rimuovi {item.label} da Bring!
                              </button>}
                              {group === 'purchase' && isMutableBringItem(item) && <details className="mt-3">
                                <summary className="flex min-h-11 cursor-pointer items-center">Modifica specifica di {item.label}</summary>
                                <form className="mt-2 grid gap-2" onSubmit={(event) => {
                                  event.preventDefault();
                                  const value = new FormData(event.currentTarget).get('specification');
                                  if (typeof value === 'string') itemAction(item, 'update', value);
                                }}>
                                  <label className="grid gap-1">Nuova specifica di {item.label}
                                    <input name="specification" defaultValue={item.specification} maxLength={BRING_SPEC_MAX_LENGTH} className="ik-input min-h-11 px-3" />
                                  </label>
                                  <button type="submit" className="ik-button-primary min-h-11 px-3">Salva specifica di {item.label}</button>
                                </form>
                              </details>}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                  {snapshot.items.length === 0 && <p>La lista Bring! è vuota.</p>}
                </>}
              </fieldset>}
            </>
          )}
        </>
      )}
    </section>
  );
}
