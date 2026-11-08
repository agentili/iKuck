import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, apiRequest } from '../api/apiClient';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import AccountPanel from '../components/account/AccountPanel';
import { useAuthStore } from '../auth/authStore';
import { importLocalData } from '../sync/syncQueue';
import GoogleSignInButton from '../components/account/GoogleSignInButton';
import { appVersion, buildId } from '../version';
import { hasUnpersistedMotionPreference, isReducedMotionPreference, saveReducedMotionPreference } from '../domain/motionPreference';
import { type ColorThemePreference, getColorThemePreference, hasUnpersistedColorTheme, saveColorThemePreference, subscribeColorTheme } from '../domain/colorTheme';
import { type AccentThemeId, getAccentThemePreference, saveAccentThemePreference, subscribeAccentTheme, ACCENT_PALETTES } from '../domain/accentTheme';
import ErrorBanner from '../components/ui/ErrorBanner';
import PageSection from '../components/ui/PageSection';
import { Button, Input } from '../components/shared';

function ThemePreferenceControl() {
  const preference = useSyncExternalStore(subscribeColorTheme, getColorThemePreference, () => 'system');
  const storageUnavailable = useSyncExternalStore(subscribeColorTheme, hasUnpersistedColorTheme, () => false);
  const options: { value: ColorThemePreference; label: string }[] = [
    { value: 'light', label: 'Chiaro' },
    { value: 'dark', label: 'Scuro' },
    { value: 'system', label: 'Sistema' },
  ];

  const choosePreference = (nextPreference: ColorThemePreference) => {
    saveColorThemePreference(nextPreference);
  };

  return (
    <section aria-labelledby="color-theme-title" className="ik-surface ik-profile-surface mt-5 rounded-2xl border-2 p-5">
      <h2 id="color-theme-title" className="text-xl font-black text-[var(--color-text)]">Tema</h2>
      <fieldset role="radiogroup" aria-labelledby="color-theme-title" className="mt-3 flex flex-wrap gap-3 border-0 p-0">
        {options.map(({ value, label }) => (
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-[var(--color-border)] px-3 font-semibold text-[var(--color-text)] has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-surface)]">
            <input type="radio" name="color-theme" value={value} checked={preference === value} onChange={() => choosePreference(value)} className="h-4 w-4 accent-[var(--color-primary)]" />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {storageUnavailable
        ? <p role="status" className="mt-2 text-sm font-semibold text-[var(--color-warning)]">La scelta vale solo finché l'app resta aperta: questo browser non consente di salvarla.</p>
        : <p className="mt-2 text-sm text-[var(--color-text-muted)]">La scelta è conservata solo in questo browser; con Sistema segue il tema del dispositivo.</p>}
    </section>
  );
}

function MotionPreferenceControl() {
  const [reduced, setReduced] = useState(isReducedMotionPreference);
  const [storageUnavailable, setStorageUnavailable] = useState(hasUnpersistedMotionPreference);
  return (
    <section aria-labelledby="motion-preference-title" className="ik-surface ik-profile-surface mt-5 rounded-2xl border-2 p-5">
      <h2 id="motion-preference-title" className="text-xl font-black text-[var(--color-text)]">Movimento</h2>
      <label className="mt-3 flex min-h-11 items-start gap-3 font-semibold text-[var(--color-text)]">
        <input type="checkbox" checked={reduced} onChange={(event) => { setReduced(event.target.checked); setStorageUnavailable(!saveReducedMotionPreference(event.target.checked)); }} className="mt-1 h-5 w-5 accent-[var(--color-primary)]" />
        <span>Riduci le animazioni su questo dispositivo</span>
      </label>
      {storageUnavailable
        ? <p role="status" className="mt-2 text-sm font-semibold text-[var(--color-warning)]">La scelta vale solo finché l'app resta aperta: questo browser non consente di salvarla.</p>
        : <p className="mt-2 text-sm text-[var(--color-text-muted)]">Impostazione conservata solo in questo browser; il movimento ridotto del sistema operativo resta sempre rispettato.</p>}
    </section>
  );
}

function AccentThemePreferenceControl() {
  const preference = useSyncExternalStore(subscribeAccentTheme, getAccentThemePreference, () => 'autumn');
  const themes = Object.values(ACCENT_PALETTES);

  const choosePreference = (nextPreference: AccentThemeId) => {
    saveAccentThemePreference(nextPreference);
  };

  return (
    <section aria-labelledby="accent-theme-title" className="ik-surface ik-profile-surface mt-5 rounded-2xl border-2 p-5">
      <h2 id="accent-theme-title" className="text-xl font-black text-[var(--color-text)]">Colore base</h2>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">Scegli la tonalità principale dell'interfaccia.</p>
      <fieldset role="radiogroup" aria-labelledby="accent-theme-title" className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 border-0 p-0">
        {themes.map((theme) => (
          <label key={theme.id} className="group relative cursor-pointer rounded-xl border-4 p-2 transition-colors border-[var(--color-border)] bg-[var(--color-surface)] has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[color-mix(in_srgb,var(--color-primary)_15%,var(--color-surface))]">
            <input type="radio" name="accent-theme" value={theme.id} checked={preference === theme.id} onChange={() => choosePreference(theme.id)} className="sr-only" />
            <div className="flex items-center justify-center gap-2">
              <div className="w-6 h-6 rounded-full" style={{ backgroundColor: theme.primary }} aria-hidden="true" />
              <span className="sr-only">{theme.name}</span>
            </div>
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs font-semibold text-[var(--color-text-muted)] group-has-[:checked]:text-[var(--color-primary)]">{theme.name}</span>
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-sm text-[var(--color-text-muted)]">La scelta è conservata solo in questo browser.</p>
    </section>
  );
}

interface ProfileResponse {
  profile: {
    displayName: string | null;
  };
}

const operationError = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'network_error') {
    return "Sei offline: l'operazione non è stata completata. Riprova quando torni online.";
  }
  return "Non è stato possibile completare l'operazione. Riprova.";
};

export default function ProfilePage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const logout = useAuthStore((state) => state.logout);
  const linkGoogle = useAuthStore((state) => state.linkGoogle);
  const clearSession = useAuthStore((state) => state.clearSession);
  const activeScope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, () => 'guest');
  const hasHouse = activeScope.startsWith('house:');
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
      <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-2xl px-4 py-5 sm:px-6 sm:py-8">
        <div className="mb-5"><Link to="/recipes" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-2 font-semibold hover:underline">← Torna alle ricette</Link></div>
        <PageSection
          eyebrow="Account ospite"
          title="Accedi al tuo profilo"
          titleId="profile-title"
          titleLevel="h1"
          description="La dispensa ospite resta sul dispositivo. Il login non importa automaticamente i dati locali: l'importazione è un'azione separata."
        >
          <div className="mt-6"><AccountPanel /></div>
        </PageSection>
        <ThemePreferenceControl />
        <MotionPreferenceControl />
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
      }, () => {
        const current = useAuthStore.getState();
        return current.user?.id === user.id && current.csrfToken === csrfToken;
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
      navigate('/recipes');
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
      setMessage("Account Google collegato. D'ora in poi potrai accedere con Google.");
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
      navigate('/recipes');
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
      <div className="mb-5"><Link to="/recipes" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-2 font-semibold hover:underline">← Torna alle ricette</Link></div>
      <PageSection
        eyebrow="Account verificato"
        title="Il tuo profilo"
        titleId="profile-title"
        titleLevel="h1"
        action={
          <Button variant="secondary" size="sm" onClick={() => { void handleLogout(); }}>
            Esci
          </Button>
        }
      >
        <p className="mt-2 text-[var(--color-text-muted)]">{user.email}</p>
        <div className="mt-4">
          <Link to="/house" className="ik-button-secondary min-h-11 items-center">La mia casa</Link>
        </div>

        {message !== null && <p role="status" className="ik-status-warning mt-5 rounded-xl p-3 font-semibold">{message}</p>}
        {error !== null && <ErrorBanner message={error} />}

        <div className="mt-7 grid gap-4 border-t border-[var(--color-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--color-text)]">Dettagli</h2>
          <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
            Nome visualizzato
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} className="min-h-11" />
          </label>
          <Button type="button" onClick={() => void saveProfile()} disabled={isLoading || csrfToken === null} className="min-h-11 w-fit">
            Salva profilo
          </Button>
        </div>

        <div className="mt-7 grid gap-3 border-t border-[var(--color-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--color-text)]">I tuoi dati</h2>
          <p className="text-[var(--color-text-muted)]">{hasHouse
            ? 'Importa esplicitamente i dati ospite nella Casa attiva. La dispensa ospite viene unita senza duplicare le quantità e rimossa dal dispositivo solo dopo la conferma del server; gli altri dati ospite restano sul dispositivo.'
            : 'Importa esplicitamente i dati ospite nel tuo account. I dati locali resteranno sul dispositivo e non verranno cancellati.'}</p>
          <div className="flex flex-wrap gap-3">
            {!confirmImport ? (
              <Button variant="secondary" size="sm" onClick={() => setConfirmImport(true)} disabled={isImporting || csrfToken === null}>
                Importa i dati locali
              </Button>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border-2 border-[var(--color-warning)] bg-[var(--color-surface)] p-3">
                <p className="basis-full font-semibold text-[var(--color-warning)]">{hasHouse
                  ? "Confermi l'unione dei dati ospite con la Casa attiva? La dispensa ospite viene rimossa solo dopo una fusione riuscita."
                  : "Confermi l'unione dei dati locali con quelli dell'account? I dati locali non verranno cancellati."}</p>
                <Button variant="secondary" size="sm" onClick={() => void handleImport()} disabled={isImporting || csrfToken === null}>
                  {isImporting ? 'Sincronizzazione...' : 'Conferma importazione'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmImport(false)} disabled={isImporting}>
                  Annulla
                </Button>
              </div>
            )}
            <Button variant="secondary" size="sm" onClick={() => void handleExport()}>
              Esporta i miei dati
            </Button>
          </div>
        </div>

        <div className="mt-7 border-t border-[var(--color-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--color-text)]">Accesso con Google</h2>
          <p className="text-[var(--color-text-muted)]">Collega lo stesso indirizzo Google verificato per usare il pulsante di accesso rapido.</p>
          <div className="max-w-sm">
            <GoogleSignInButton onCredential={(credential) => void handleGoogleLink(credential)} />
          </div>
          {isLinkingGoogle && <p className="text-sm font-semibold text-[var(--color-text-muted)]">Collegamento in corso...</p>}
        </div>

        <section className="mt-7 border-t border-[var(--color-border)] pt-6" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading" className="text-xl font-black text-[var(--color-text)]">Privacy e servizi esterni</h2>
          <h3 className="mt-3 font-bold text-[var(--color-text)]">Bring!</h3>
          <p className="mt-2 text-[var(--color-text-muted)]">Il collegamento richiede una conferma esplicita. Dopo la conferma, email e password vengono inviate a Bring! tramite il backend iKuck. La password non viene conservata; la sessione è cifrata sul server e resta personale, anche quando usi una Casa condivisa.</p>
          <p className="mt-2 text-[var(--color-text-muted)]">Le azioni che richiedi inviano a Bring! i nomi degli articoli e le specifiche della lista collegata. La lista Bring! non è copiata nella lista iKuck e non è disponibile offline; gli ingredienti delle ricette non vengono trasferiti automaticamente.</p>
          <p className="mt-2 text-[var(--color-text-muted)]">Scollegare rimuove la sessione salvata da iKuck, ma non garantisce la revoca di sessioni o dati conservati da Bring!.</p>
        </section>

        <details className="mt-4 ik-surface rounded-xl p-4">
          <summary className="min-h-11 cursor-pointer py-3 font-bold text-[var(--color-text)] focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]">Diagnostica applicazione</summary>
          <dl className="grid gap-2 border-t border-[var(--color-border)] py-3 text-sm text-[var(--color-text-muted)] sm:grid-cols-2">
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

        <div className="mt-7 border-t border-[var(--color-danger)] pt-6">
          <h2 className="text-xl font-black text-[var(--color-danger)]">Zona delicata</h2>
          <p className="mt-2 text-[var(--color-text-muted)]">Eliminare l'account rimuove i dati personali remoti e chiude la sessione. Se ci sono altri membri, i dati condivisi restano nella Casa. I dati ospite presenti sul dispositivo non vengono cancellati.</p>
          {!confirmDelete ? (
            <Button variant="secondary" size="sm" className="mt-4 border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-on-primary-action)]" onClick={() => setConfirmDelete(true)}>
              Elimina account
            </Button>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="basis-full font-semibold text-[var(--color-danger)]">Confermi definitivamente?</p>
              <Button variant="primary" size="sm" onClick={() => void handleDelete()} disabled={isDeleting} className="bg-[var(--color-danger)] hover:bg-[var(--color-danger)]">
                {isDeleting ? 'Eliminazione...' : 'Conferma eliminazione account'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Annulla
              </Button>
            </div>
          )}
        </div>
      </PageSection>
      <ThemePreferenceControl />
      <MotionPreferenceControl />
      <AccentThemePreferenceControl />
    </main>
  );
}