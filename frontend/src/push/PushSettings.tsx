import { ApiClientError } from '../api/apiClient';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PushPreferences, PushStatus } from '@ikuck/shared/contracts';
import { useAuthStore } from '../auth/authStore';
import { browserSubscription, clearLocalPush, deleteDeviceSubscription, enableDevicePush, getDeviceSubscriptions, getPushStatus, reconcilePushAccount, savePushPreferences, sendPushTest, supportsPush } from './client';

const buttonClass = 'min-h-11 rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold disabled:opacity-60';
export default function PushSettings() {
  const user = useAuthStore((s) => s.user);
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [draft, setDraft] = useState<PushPreferences>({ enabled: false, fridayTime: '19:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome' });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setStatus(null); setDeviceId(null); setMessage('');
    if (!user) return;
    void (async () => {
      try {
        await reconcilePushAccount(user.id);
        const next = await getPushStatus();
        const browser = await browserSubscription();
        const devices = next.enabled ? await getDeviceSubscriptions() : [];
        if (!active) return;
        const device = devices.find((item) => item.endpoint === browser?.endpoint);
        if (next.enabled && browser && !device) {
          await clearLocalPush();
          if (!active) return;
          setMessage('Questo dispositivo non è più abilitato. Attiva di nuovo le notifiche.');
        }
        setStatus(next);
        setDraft(next.preferencesConfigured ? next.preferences : { ...next.preferences, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || next.preferences.timeZone });
        setDeviceId(device?.id ?? null);
      } catch { if (active) setMessage('Impossibile leggere le impostazioni delle notifiche. Riprova quando sei online.'); }
    })();
    return () => { active = false; };
  }, [user]);
  const run = async (operation: () => Promise<void>) => {
    const expectedUser = user?.id;
    setBusy(true); setMessage('');
    try { await operation(); }
    catch (error) {
      if (useAuthStore.getState().user?.id !== expectedUser) return;
      if (error instanceof ApiClientError && ['push_subscription_expired', 'subscription_not_found'].includes(error.code)) {
        await clearLocalPush().catch(() => {});
        if (useAuthStore.getState().user?.id !== expectedUser) return;
        setDeviceId(null);
        setMessage('L’iscrizione è scaduta. Attiva di nuovo le notifiche su questo dispositivo.');
      } else if (error instanceof ApiClientError && error.code === 'invalid_payload') {
        setMessage('Controlla l’orario e il fuso IANA, ad esempio Europe/Rome.');
      } else if (error instanceof ApiClientError && error.code === 'push_device_limit') {
        setMessage('Hai raggiunto il limite di 20 dispositivi. Disattiva le notifiche su un dispositivo che non usi più.');
      } else {
        setMessage(error instanceof Error && error.message.startsWith('Permesso negato') ? error.message : 'Operazione non riuscita. Controlla la connessione e riprova.');
      }
    } finally { setBusy(false); }
  };
  const enable = async () => {
    if (!user || !csrfToken || !status?.publicKey) return;
    const id = await enableDevicePush(status.publicKey, user.id, csrfToken);
    if (useAuthStore.getState().user?.id !== user.id) { await clearLocalPush(); return; }
    try { await savePushPreferences({ ...draft, enabled: true }, csrfToken); }
    catch (error) { await deleteDeviceSubscription(id, csrfToken).catch(() => {}); await clearLocalPush(); throw error; }
    setDeviceId(id); setDraft({ ...draft, enabled: true }); setMessage('Notifiche attive su questo dispositivo.');
  };
  return <section aria-labelledby="push-settings-title" className="ik-surface ik-profile-surface mt-5 rounded-3xl border-2 p-5">
    <h2 id="push-settings-title" className="text-xl font-black">Notifiche</h2>
    <p className="mt-2">Un promemoria il venerdì per creare o completare il piano della settimana successiva. Arriva solo se manca almeno una ricetta, dal lunedì alla domenica.</p>
    {!user ? <p className="mt-3"><Link to="/profile" className="underline">Accedi con un account verificato</Link> per attivare le notifiche.</p> : <>
      {status && !status.enabled && <p className="mt-3">Le notifiche non sono ancora disponibili su questo server.</p>}
      {!supportsPush() && <p className="mt-3">Questo browser non supporta le notifiche push. Su iPhone e iPad usa un sistema compatibile (iOS/iPadOS 16.4 o successivo) e aggiungi iKuck alla schermata Home da Safari.</p>}
      {supportsPush() && Notification.permission === 'denied' && <p className="mt-3">Notifiche bloccate. Consenti le notifiche nelle impostazioni del browser e ricarica la pagina.</p>}
      {status?.enabled && <Link to="/plan" className="mt-3 inline-flex min-h-11 items-center font-bold underline">Apri piano settimanale</Link>}
      {status?.enabled && <form className="mt-4 grid gap-3" onSubmit={(event) => { event.preventDefault(); if (csrfToken) void run(async () => { await savePushPreferences(draft, csrfToken); const next = await getPushStatus(); setStatus(next); setMessage('Preferenze salvate.'); }); }}>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />Promemoria attivo per il mio account</label>
        <label className="grid gap-1">Orario del venerdì<input type="time" required value={draft.fridayTime} disabled={busy} onChange={(event) => setDraft({ ...draft, fridayTime: event.target.value })} className="ik-input min-h-11" /></label>
        <label className="grid gap-1">Fuso personale (se la Casa non ne ha uno)<input required value={draft.timeZone} disabled={busy} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} className="ik-input min-h-11" /></label>
        <p>Fuso usato: {status.effectiveTimeZone}. Le modifiche ancora offline verranno considerate dopo la sincronizzazione.</p>
        <button className={buttonClass} disabled={busy || !csrfToken}>Salva preferenze</button>
      </form>}
      {status?.enabled && supportsPush() && <div className="mt-4 flex flex-wrap gap-3">
        {deviceId ? <>
          <p className="w-full">Questo dispositivo è abilitato.</p>
          <button type="button" className={buttonClass} disabled={busy || !csrfToken} onClick={() => { if (csrfToken) void run(async () => { await sendPushTest(deviceId, csrfToken); setMessage('Notifica di prova inviata.'); }); }}>Invia notifica di prova</button>
          <button type="button" className={buttonClass} disabled={busy || !csrfToken} onClick={() => { if (csrfToken) void run(async () => { await deleteDeviceSubscription(deviceId, csrfToken); await clearLocalPush(); setDeviceId(null); setMessage('Notifiche disattivate su questo dispositivo.'); }); }}>Disattiva su questo dispositivo</button>
        </> : <button type="button" className={buttonClass} disabled={busy || !csrfToken || Notification.permission === 'denied'} onClick={() => void run(enable)}>Attiva notifiche</button>}
      </div>}
    </>}
    {message && <p role="status" className="mt-3">{message}</p>}
  </section>;
}
