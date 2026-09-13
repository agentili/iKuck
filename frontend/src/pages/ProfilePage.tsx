import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, apiRequest } from '../api/apiClient';
import AccountPanel from '../components/account/AccountPanel';
import { useAuthStore } from '../auth/authStore';
import { importLocalData } from '../sync/syncQueue';
import GoogleSignInButton from '../components/account/GoogleSignInButton';

interface ProfileResponse {
  profile: {
    displayName: string | null;
  };
}

const operationError = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'network_error') {
    return 'Sei offline: i dati locali restano disponibili e l’operazione verrà riprovata.';
  }
  return 'Non è stato possibile completare l’operazione. Riprova.';
};

export default function ProfilePage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const logout = useAuthStore((state) => state.logout);
  const linkGoogle = useAuthStore((state) => state.linkGoogle);
  const clearSession = useAuthStore((state) => state.clearSession);
  const [displayName, setDisplayName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLinkingGoogle, setIsLinkingGoogle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) return;

    let active = true;
    void apiRequest<ProfileResponse>('/v1/profile')
      .then((response) => {
        if (active) setDisplayName(response.profile.displayName ?? '');
      })
      .catch((loadError: unknown) => {
        if (active) setError(operationError(loadError));
      });

    return () => {
      active = false;
    };
  }, [user]);

  if (user === null) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-2xl px-4 py-8 sm:px-6">
        <div className="mb-5"><Link to="/" className="font-semibold text-gray-700 underline underline-offset-2">← Torna alla dispensa</Link></div>
        <section className="rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-3xl font-black text-gray-950">Accedi per vedere il profilo</h1>
          <p className="mt-3 text-gray-600">La dispensa ospite resta sul dispositivo. Accedi solo quando vuoi sincronizzarla.</p>
          <div className="mt-6"><AccountPanel /></div>
        </section>
      </main>
    );
  }

  const saveProfile = async () => {
    if (csrfToken === null) return;
    setIsLoading(true);
    setMessage(null);
    setError(null);
    try {
      const response = await apiRequest<ProfileResponse>('/v1/profile', {
        method: 'PATCH',
        csrfToken,
        body: { displayName: displayName.trim() || null },
      });
      setDisplayName(response.profile.displayName ?? '');
      setMessage('Profilo aggiornato.');
    } catch (saveError) {
      setError(operationError(saveError));
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (csrfToken === null) return;
    setIsImporting(true);
    setMessage(null);
    setError(null);
    try {
      await importLocalData({
        userId: user.id,
        emailVerifiedAt: user.emailVerifiedAt,
        csrfToken,
      });
      setMessage('La tua dispensa è stata sincronizzata.');
    } catch (importError) {
      setError(operationError(importError));
    } finally {
      setIsImporting(false);
    }
  };

  const handleExport = async () => {
    setMessage(null);
    setError(null);
    try {
      const data = await apiRequest<unknown>('/v1/profile/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'ikuck-export.json';
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('Esportazione pronta.');
    } catch (exportError) {
      setError(operationError(exportError));
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete || csrfToken === null) return;
    setIsDeleting(true);
    setMessage(null);
    setError(null);
    try {
      await apiRequest('/v1/profile', { method: 'DELETE', csrfToken });
      clearSession();
      navigate('/');
    } catch (deleteError) {
      setError(operationError(deleteError));
      setIsDeleting(false);
    }
  };

  const handleGoogleLink = async (credential: string) => {
    setIsLinkingGoogle(true);
    setMessage(null);
    setError(null);
    try {
      await linkGoogle(credential);
      setMessage('Account Google collegato. D’ora in poi potrai accedere con Google.');
    } catch (linkError) {
      setError(operationError(linkError));
    } finally {
      setIsLinkingGoogle(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-5"><Link to="/" className="font-semibold text-gray-700 underline underline-offset-2">← Torna alla dispensa</Link></div>
      <section className="rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-emerald-700">Account verificato</p>
            <h1 className="mt-1 text-3xl font-black text-gray-950">Il tuo profilo</h1>
            <p className="mt-2 text-gray-600">{user.email}</p>
          </div>
          <button type="button" onClick={() => void logout().then(() => navigate('/'))} className="rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Esci</button>
        </div>

        {message !== null && <p role="status" className="mt-5 rounded-xl bg-emerald-50 p-3 font-semibold text-emerald-900">{message}</p>}
        {error !== null && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-3 font-semibold text-rose-900">{error}</p>}

        <div className="mt-7 grid gap-4 border-t border-gray-200 pt-6">
          <h2 className="text-xl font-black text-gray-950">Dettagli</h2>
          <label className="grid gap-1 text-sm font-semibold text-gray-800">
            Nome visualizzato
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900" />
          </label>
          <button type="button" onClick={() => void saveProfile()} disabled={isLoading || csrfToken === null} className="min-h-11 w-fit rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:opacity-60">Salva profilo</button>
        </div>

        <div className="mt-7 grid gap-3 border-t border-gray-200 pt-6">
          <h2 className="text-xl font-black text-gray-950">I tuoi dati</h2>
          <p className="text-gray-600">La sincronizzazione parte solo quando la richiedi. La dispensa ospite non viene caricata automaticamente al login.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => void handleImport()} disabled={isImporting || csrfToken === null} className="min-h-11 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:opacity-60">{isImporting ? 'Sincronizzazione…' : 'Importa la dispensa'}</button>
            <button type="button" onClick={() => void handleExport()} className="min-h-11 rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Esporta i miei dati</button>
          </div>
        </div>

        <div className="mt-7 grid gap-3 border-t border-gray-200 pt-6">
          <h2 className="text-xl font-black text-gray-950">Accesso con Google</h2>
          <p className="text-gray-600">Collega lo stesso indirizzo Google verificato per usare il pulsante di accesso rapido.</p>
          <div className="max-w-sm">
            <GoogleSignInButton onCredential={(credential) => void handleGoogleLink(credential)} onUnavailable={() => setError('Accesso Google non ancora configurato per questo ambiente.')} />
          </div>
          {isLinkingGoogle && <p className="text-sm font-semibold text-gray-600">Collegamento in corso…</p>}
        </div>

        <div className="mt-7 border-t border-rose-200 pt-6">
          <h2 className="text-xl font-black text-rose-950">Zona delicata</h2>
          <p className="mt-2 text-gray-600">Eliminare l’account rimuove i dati remoti e chiude la sessione. I dati ospite già presenti sul dispositivo non vengono cancellati.</p>
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className="mt-4 min-h-11 rounded-xl border-2 border-rose-300 px-4 py-2 font-bold text-rose-900 hover:border-rose-600">Elimina account</button>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="basis-full font-semibold text-rose-900">Confermi definitivamente?</p>
              <button type="button" onClick={() => void handleDelete()} disabled={isDeleting} className="min-h-11 rounded-xl bg-rose-700 px-4 py-2 font-bold text-white hover:bg-rose-800 disabled:opacity-60">{isDeleting ? 'Eliminazione…' : 'Conferma eliminazione account'}</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="min-h-11 rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Annulla</button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
