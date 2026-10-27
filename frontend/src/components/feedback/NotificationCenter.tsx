import { subscribeSyncStatus } from '../../sync/syncQueue';
import { useAuthStore } from '../../auth/authStore';
import { useEffect, useState } from 'react';
import { X, Bell } from 'lucide-react';
import { usePersistenceStatusStore, type PersistenceDomain } from '../../store/persistenceStatusStore';
import { usePantryStore } from '../../store/localPantryStore';
import { getActiveDataScope, getPersonalDataScope, subscribeActiveDataScope, subscribePersonalDataScope } from '../../sync/scopeContext';
import { usePantryMergeNoticeStore } from '../../store/pantryMergeNoticeStore';
import { expiryNotices } from './expiryNotices';

type Notice = { id: number; key: string; message: string; error: boolean; expiresAt: number | null };
export default function NotificationCenter() {
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    const transient = notices.filter((notice) => notice.expiresAt !== null);
    if (transient.length === 0) return;
    const deadline = Math.min(...transient.map((notice) => notice.expiresAt!));
    const timer = setTimeout(() => {
      setNotices((current) => {
        const remaining = current.filter((notice) => notice.expiresAt === null || notice.expiresAt > Date.now()
          || Boolean(document.activeElement?.closest(`[data-notice-id="${notice.id}"]`)));
        return remaining.length === current.length ? current : remaining;
      });
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [notices]);
  useEffect(() => {
    let nextId = 0;
    let generation = 0;
    let disposed = false;
    const saving = new Set<PersistenceDomain>();
    const pendingSync = new Set<PersistenceDomain>();
    const seen = new Set<string>();
    const notify = (message: string, error = false, key = message, transient = false) => {
      if (disposed) return;
      setNotices((current) => current.some((notice) => notice.key === key && notice.message === message)
        ? current : [...current.filter((notice) => notice.key !== key), { id: ++nextId, key, message, error, expiresAt: transient ? Date.now() + 6000 : null }].slice(-5));
    };
    const offline = () => notify('Sei offline. Puoi continuare a usare i tuoi dati locali.');
    window.addEventListener('offline', offline);
    const networkError = () => notify('Connessione non disponibile. Riprova quando torni online.', true);
    window.addEventListener('app:network-error', networkError);
    const stopStatus = usePersistenceStatusStore.subscribe((current, previous) => {
      for (const domain of ['pantry', 'shopping-list', 'activity', 'diet'] as const) {
        const state = current.statuses[domain].state;
        const before = previous.statuses[domain].state;
        if (state === before) continue;
        if (state === 'saving') saving.add(domain);
        if (state === 'sync-pending') pendingSync.add(domain);
        if (state === 'sync-error' && (before !== 'sync-pending' || pendingSync.has(domain))) notify('Sincronizzazione non riuscita. Riprova quando torni online.', true, 'sync-error');
        if (state === 'memory-only' && (before !== 'saving' || saving.has(domain))) notify('Salvataggio sul dispositivo non riuscito. Mantieni aperta l’app e riprova.', true, 'persistence-error');
        if (domain === 'activity' && state === 'saved' && before === 'saving' && saving.has(domain)) notify('Attività e preferenze salvate sul dispositivo.', false, 'activity-saved', true);
        if (state !== 'saving') saving.delete(domain);
        if (state !== 'sync-pending') pendingSync.delete(domain);
      }
    });
    let stopSync = () => {};
    const bindSync = () => {
      stopSync();
      stopSync = () => {};
      const user = useAuthStore.getState().user;
      if (user === null) return;
      const currentGeneration = generation;
      const scope = getActiveDataScope();
      const personalScope = getPersonalDataScope();
      stopSync = subscribeSyncStatus(`account:${user.id}`, (status) => {
        if (disposed || currentGeneration !== generation || scope !== getActiveDataScope()
          || personalScope !== getPersonalDataScope() || useAuthStore.getState().user?.id !== user.id) return;
        if (status.state === 'success') notify('Sincronizzazione eseguita.', false, 'sync-success', true);
        if (status.state === 'error') notify('Sincronizzazione non riuscita. Riprova quando torni online.', true, 'sync-error');
      });
    };
    bindSync();
    const stopAuth = useAuthStore.subscribe((current, previous) => {
      if (current.user?.id !== previous.user?.id) resetContext();
    });
    const checkExpiry = () => {
      const expired = expiryNotices(usePantryStore.getState().pantryLots);
      const currentKeys = new Set(expired.map((notice) => notice.key));
      setNotices((current) => current.filter((notice) => !notice.key.startsWith('expiry:') || currentKeys.has(notice.key.slice(7))));
      for (const notice of expired) {
        if (!seen.has(notice.key)) {
          seen.add(notice.key);
          notify(notice.message, false, `expiry:${notice.key}`);
        }
      }
    };
    function resetContext() {
      generation += 1;
      saving.clear();
      pendingSync.clear();
      seen.clear();
      setNotices([]);
      bindSync();
    }
    checkExpiry();
    const stopPantry = usePantryStore.subscribe(checkExpiry);
    const stopScope = subscribeActiveDataScope(resetContext);
    const stopPersonalScope = subscribePersonalDataScope(resetContext);
    let expiryTimer: ReturnType<typeof setTimeout>;
    const refreshExpiry = () => {
      clearTimeout(expiryTimer);
      checkExpiry();
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      expiryTimer = setTimeout(refreshExpiry, midnight.getTime() - Date.now());
    };
    refreshExpiry();
    window.addEventListener('focus', refreshExpiry);
    const stopMerge = usePantryMergeNoticeStore.subscribe((current, previous) => {
      if (current.summary !== null && current.summary !== previous.summary) notify('Copia della dispensa recuperata.', false, 'pantry-recovered', true);
    });
    return () => { disposed = true; generation += 1; clearTimeout(expiryTimer); stopAuth(); stopSync(); stopStatus(); stopPantry(); stopScope(); stopPersonalScope(); stopMerge(); window.removeEventListener('focus', refreshExpiry); window.removeEventListener('offline', offline); window.removeEventListener('app:network-error', networkError); };
  }, []);
  return <aside className="notification-center" aria-label="Notifiche" style={{ pointerEvents: 'none' }}><div aria-live="polite" aria-atomic="false">{notices.map((notice) => <div key={notice.id} data-notice-id={notice.id} className={`app-notice ${notice.error ? 'notice-error' : ''}`}><Bell size={18} aria-hidden="true" /><p>{notice.message}</p><button type="button" aria-label="Chiudi notifica" style={{ pointerEvents: 'auto' }} onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}><X size={18} aria-hidden="true" /></button></div>)}</div></aside>;
}
