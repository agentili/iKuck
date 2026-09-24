import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, apiRequest } from '../api/apiClient';
import AccountPanel from '../components/account/AccountPanel';
import { useAuthStore } from '../auth/authStore';
import { importLocalData } from '../sync/syncQueue';
import GoogleSignInButton from '../components/account/GoogleSignInButton';
import AiRecipePanel from '../components/ai/AiRecipePanel';
import { usePantryStore } from '../store/localPantryStore';
import { useDietProfileStore } from '../store/dietProfileStore';
import { appVersion, buildId } from '../version';

interface ProfileResponse {
  profile: {
    displayName: string | null;
  };
}

const operationError = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'network_error') {
    return 'Sei offline: l’operazione non è stata completata. Riprova quando torni online.';
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
  const pantryItems = usePantryStore((state) => state.pantryItems);
  const dietProfile = useDietProfileStore((state) => state.profile);
  const [displayName, setDisplayName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLinkingGoogle, setIsLinkingGoogle] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
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
      <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-2xl px-4 py-8 sm:px-6">
        <div className="mb-5"><Link to="/" className="inline-flex min-h-11 items-center rounded-xl px-2 font-semibold text-gray-700 underline underline-offset-2">← Torna alle ricette</Link></div>
        <section className="ik-surface ik-profile-surface rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-3xl font-black text-gray-950">Accedi al tuo profilo</h1>
          <p className="mt-3 text-gray-600">La dispensa ospite resta sul dispositivo. Il login non importa automaticamente i dati locali: l’importazione è un’azione separata.</p>
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
    if (!confirmImport || csrfToken === null) return;
    setIsImporting(true);
    setMessage(null);
    setError(null);
    try {
      const result = await importLocalData({
        userId: user.id,
        emailVerifiedAt: user.emailVerifiedAt,
        csrfToken,
      });
      setMessage(`Sincronizzazione ${result.complete ? 'completata' : 'parziale'}: ${result.uploaded} elementi inviati, ${result.downloaded} ricevuti. In attesa: ${result.pending}.`);
    } catch (importError) {
      setError(operationError(importError));
    } finally {
      setIsImporting(false);
      setConfirmImport(false);
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

  const handleLogout = async () => {
    setMessage(null);
    setError(null);
    try {
      await logout();
    } catch (logoutError) {
      setError(operationError(logoutError));
    } finally {
      clearSession();
      navigate('/');
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-5"><Link to="/" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-2 font-semibold text-gray-700 underline underline-offset-2">← Torna alle ricette</Link></div>
      <section className="ik-surface ik-profile-surface rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-emerald-700">Account verificato</p>
            <h1 className="mt-1 text-3xl font-black text-gray-950">Il tuo profilo</h1>
            <p className="mt-2 text-gray-600">{user.email}</p>
          </div>
          <button type="button" onClick={() => { void handleLogout(); }} className="rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Esci</button>
        </div>
        <div className="mt-4">
          <Link to="/house" className="inline-flex min-h-11 items-center rounded-xl border-2 border-emerald-200 bg-emerald-50 px-4 py-2 font-bold text-emerald-900 hover:border-emerald-500">La mia casa</Link>
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
          <p className="text-gray-600">La sincronizzazione parte solo quando la richiedi. I dati locali verranno copiati nell’account e uniti a quelli già presenti. I dati locali resteranno sul dispositivo e non verranno cancellati.</p>
          <div className="flex flex-wrap gap-3">
            {!confirmImport ? (
              <button type="button" onClick={() => setConfirmImport(true)} disabled={isImporting || csrfToken === null} className="min-h-11 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:opacity-60">Importa i dati locali</button>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border-2 border-amber-200 bg-amber-50 p-3">
                <p className="basis-full font-semibold text-amber-950">Confermi l’unione dei dati locali con quelli dell’account? I dati locali non verranno cancellati.</p>
                <button type="button" onClick={() => void handleImport()} disabled={isImporting || csrfToken === null} className="min-h-11 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:opacity-60">{isImporting ? 'Sincronizzazione…' : 'Conferma importazione'}</button>
                <button type="button" onClick={() => setConfirmImport(false)} disabled={isImporting} className="min-h-11 rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900 disabled:opacity-60">Annulla</button>
              </div>
            )}
            <button type="button" onClick={() => void handleExport()} className="min-h-11 rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Esporta i miei dati</button>
          </div>
        </div>

        <div className="mt-7 border-t border-gray-200 pt-6">
          <AiRecipePanel
            ingredients={pantryItems.map((item) => item.label)}
            dietProfile={dietProfile}
            user={user}
            csrfToken={csrfToken}
          />
        </div>

        <div className="mt-7 grid gap-3 border-t border-gray-200 pt-6">
          <h2 className="text-xl font-black text-gray-950">Accesso con Google</h2>
          <p className="text-gray-600">Collega lo stesso indirizzo Google verificato per usare il pulsante di accesso rapido.</p>
          <div className="max-w-sm">
            <GoogleSignInButton onCredential={(credential) => void handleGoogleLink(credential)} />
          </div>
          {isLinkingGoogle && <p className="text-sm font-semibold text-gray-600">Collegamento in corso…</p>}
        </div>

        <div className="mt-7 border-t border-gray-200 pt-6">
          <details className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <summary className="cursor-pointer font-bold text-gray-900">Diagnostica applicazione</summary>
            <dl className="mt-3 grid gap-2 text-sm text-gray-700 sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Versione app</dt>
                <dd>{appVersion}</dd>
              </div>
              <div>
                <dt className="font-semibold">Build</dt>
                <dd>{buildId}</dd>
              </div>
            </dl>
          </details>
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
