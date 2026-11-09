import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, apiRequest } from '../api/apiClient';
import { getActiveDataScope, subscribeActiveDataScope, type SyncScope } from '../sync/scopeContext';
import AccountPanel from '../components/account/AccountPanel';
import { useAuthStore } from '../auth/authStore';
import { importLocalData } from '../sync/syncQueue';
import GoogleSignInButton from '../components/account/GoogleSignInButton';
import { appVersion, buildId } from '../version';
import { hasUnpersistedMotionPreference, isReducedMotionPreference, saveReducedMotionPreference } from '../domain/motionPreference';
import { applyColorTheme, type ColorThemePreference, getColorThemePreference, hasUnpersistedColorTheme, saveColorThemePreference, subscribeColorTheme } from '../domain/colorTheme';
import { COLOR_PALETTES, getColorPalettePreference, hasUnpersistedColorPalette, saveColorPalettePreference, subscribeColorPalette, type ColorPalettePreference } from '../domain/colorPalette';
import ErrorBanner from '../components/ui/ErrorBanner';
import PageSection from '../components/ui/PageSection';
import { readMealPlanSnapshot } from '../mealPlan/storage';
import { importGuestMealPlan } from '../mealPlan/service';
import { isSousChef } from '../config/features';

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
    <section aria-labelledby="color-theme-title" className="ik-surface ik-profile-surface mt-5 rounded-3xl border-2 p-5">
      <h2 id="color-theme-title" className="text-xl font-black text-[var(--ik-ink)]">Tema</h2>
      <fieldset role="radiogroup" aria-labelledby="color-theme-title" className="mt-3 flex flex-wrap gap-3 border-0 p-0">
        {options.map(({ value, label }) => (
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-2 border-[var(--ik-border)] px-3 font-semibold text-[var(--ik-ink)] has-[:checked]:border-[var(--ik-basil)] has-[:checked]:bg-[var(--ik-sage)]">
            <input type="radio" name="color-theme" value={value} checked={preference === value} onChange={() => choosePreference(value)} className="h-4 w-4 accent-[var(--ik-basil)]" />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {storageUnavailable
        ? <p role="status" className="mt-2 rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm font-semibold text-[var(--ik-warn-ink)]">La scelta vale solo finché l’app resta aperta: questo browser non consente di salvarla.</p>
        : <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">La scelta è conservata solo in questo browser; con Sistema segue il tema del dispositivo.</p>}
    </section>
  );
}

function ColorPaletteControl() {
  const preference = useSyncExternalStore(subscribeColorPalette, getColorPalettePreference, () => 'basilico');
  const storageUnavailable = useSyncExternalStore(subscribeColorPalette, hasUnpersistedColorPalette, () => false);

  const choosePalette = (nextPreference: ColorPalettePreference) => {
    saveColorPalettePreference(nextPreference);
    applyColorTheme();
  };

  return (
    <section aria-labelledby="color-palette-title" className="ik-surface ik-profile-surface mt-5 rounded-3xl border-2 p-5">
      <h2 id="color-palette-title" className="text-xl font-black text-[var(--ik-ink)]">Palette colori</h2>
      <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Scegli i colori di iKuck. La modifica si applica subito.</p>
      <fieldset role="radiogroup" aria-labelledby="color-palette-title" className="mt-4 grid grid-cols-2 gap-3 border-0 p-0 sm:grid-cols-3 lg:grid-cols-5">
        {COLOR_PALETTES.map(({ value, label, description }) => (
          <label
            key={value}
            data-palette={value}
            className="ik-palette-option group relative flex min-h-24 cursor-pointer flex-col justify-between rounded-2xl border-2 border-[var(--ik-border)] bg-[var(--ik-palette-page)] p-3 text-left text-[var(--ik-palette-ink)] transition-colors hover:border-[var(--ik-basil)] has-[:checked]:border-[var(--ik-basil)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--ik-focus)]"
          >
            <input
              type="radio"
              name="color-palette"
              value={value}
              checked={preference === value}
              onChange={() => choosePalette(value)}
              className="sr-only"
            />
            <span className="flex items-center justify-between gap-2">
              <span className="font-bold">{label}</span>
              <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-[var(--ik-palette-accent)] text-xs font-black text-[var(--ik-palette-page)] opacity-0 group-has-[:checked]:opacity-100">✓</span>
            </span>
            <span className="mt-1 text-xs text-[var(--ik-palette-muted-ink)]">{description}</span>
            <span aria-hidden="true" className="mt-2 flex gap-1.5">
              <span className="size-3 rounded-full bg-[var(--ik-palette-accent)]" />
              <span className="size-3 rounded-full bg-[var(--ik-palette-accent-dark)]" />
              <span className="size-3 rounded-full bg-[var(--ik-palette-soft)]" />
              <span className="size-3 rounded-full bg-[var(--ik-palette-page)] ring-1 ring-inset ring-[var(--ik-palette-border)]" />
            </span>
          </label>
        ))}
      </fieldset>
      {storageUnavailable
        ? <p role="status" className="mt-3 rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm font-semibold text-[var(--ik-warn-ink)]">La palette scelta vale solo finché l’app resta aperta: questo browser non consente di salvarla.</p>
        : <p className="mt-3 text-sm text-[var(--ik-ink-muted)]">La scelta è conservata solo in questo browser.</p>}
    </section>
  );
}

function MotionPreferenceControl() {
  const [reduced, setReduced] = useState(isReducedMotionPreference);
  const [storageUnavailable, setStorageUnavailable] = useState(hasUnpersistedMotionPreference);
  return (
    <section aria-labelledby="motion-preference-title" className="ik-surface ik-profile-surface mt-5 rounded-3xl border-2 p-5">
      <h2 id="motion-preference-title" className="text-xl font-black text-[var(--ik-ink)]">Movimento</h2>
      <label className="mt-3 flex min-h-11 items-start gap-3 font-semibold text-[var(--ik-ink)]">
        <input type="checkbox" checked={reduced} onChange={(event) => { setReduced(event.target.checked); setStorageUnavailable(!saveReducedMotionPreference(event.target.checked)); }} className="mt-1 h-5 w-5 accent-[var(--ik-basil)]" />
        <span>Riduci le animazioni su questo dispositivo</span>
      </label>
      {storageUnavailable
        ? <p role="status" className="mt-2 rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 text-sm font-semibold text-[var(--ik-warn-ink)]">La scelta vale solo finché l’app resta aperta: questo browser non consente di salvarla.</p>
        : <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Impostazione conservata solo in questo browser; il movimento ridotto del sistema operativo resta sempre rispettato.</p>}
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
    return 'Sei offline: l’operazione non è stata completata. Riprova quando torni online.';
  }
  return 'Non è stato possibile completare l’operazione. Riprova.';
};

export default function ProfilePage() {
  const returnLinkLabel = isSousChef() ? 'Torna a Chef' : 'Torna alle ricette';
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const logout = useAuthStore((state) => state.logout);
  const linkGoogle = useAuthStore((state) => state.linkGoogle);
  const clearSession = useAuthStore((state) => state.clearSession);
  const activeScope = useSyncExternalStore<SyncScope>(subscribeActiveDataScope, getActiveDataScope, () => 'guest');
  const hasHouse = activeScope.startsWith('house:');
  const [displayName, setDisplayName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLinkingGoogle, setIsLinkingGoogle] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmPlanImport, setConfirmPlanImport] = useState(false);
  const [guestPlanCount, setGuestPlanCount] = useState<number | null>(null);
  const [guestPlanLoadFailed, setGuestPlanLoadFailed] = useState(false);
  const [isImportingPlan, setIsImportingPlan] = useState(false);
  const planImportGeneration = useRef(0);
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

  useEffect(() => {
    if (user === null || !isSousChef()) return;
    let active = true;
    setGuestPlanLoadFailed(false);
    void readMealPlanSnapshot('guest')
      .then((snapshot) => {
        if (active) setGuestPlanCount(Object.keys(snapshot.states).length);
      })
      .catch(() => {
        if (active) setGuestPlanLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    planImportGeneration.current += 1;
    setConfirmPlanImport(false);
    setIsImportingPlan(false);
    setMessage(null);
    setError(null);
    return () => { planImportGeneration.current += 1; };
  }, [activeScope, csrfToken, user?.id]);

  if (user === null) {
    return (
      <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-2xl px-4 py-5 sm:px-6 sm:py-8">
        <div className="mb-5"><Link to="/" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-2 font-semibold underline underline-offset-2">← {returnLinkLabel}</Link></div>
        <PageSection
          eyebrow="Account ospite"
          title="Accedi al tuo profilo"
          titleId="profile-title"
          titleLevel="h1"
          description="La dispensa ospite resta sul dispositivo. Il login non importa automaticamente i dati locali: l’importazione è un’azione separata."
          className="ik-profile-surface sm:space-y-5"
        >
          <div className="mt-6"><AccountPanel /></div>
        </PageSection>
        <ThemePreferenceControl />
        <ColorPaletteControl />
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

  const handlePlanImport = async () => {
    if (!isSousChef() || !confirmPlanImport || csrfToken === null || activeScope === 'guest' || user.emailVerifiedAt.trim().length === 0) return;
    const scope = activeScope;
    const currentUserId = user.id;
    const generation = planImportGeneration.current;
    setIsImportingPlan(true);
    setMessage(null);
    setError(null);
    let completed = false;
    const isCurrent = () => {
      const current = useAuthStore.getState();
      return planImportGeneration.current === generation && current.user?.id === currentUserId
        && current.csrfToken === csrfToken && getActiveDataScope() === scope;
    };
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new Error('La sessione o la Casa è cambiata durante l\'importazione del Piano.');
    };
    try {
      const result = await importGuestMealPlan({ scope, csrfToken, assertCurrent });
      assertCurrent();
      const guest = await readMealPlanSnapshot('guest');
      assertCurrent();
      setGuestPlanCount(Object.keys(guest.states).length);
      const complete = result.pending === 0 && result.preservedConflicts === 0;
      setMessage(`Importazione Piano ${complete ? 'completata' : 'parziale'}: ${result.queued} scelte accodate, ${result.acknowledged} esiti ricevuti, ${result.conflicts} conflitti server, ${result.pending} in attesa; ${result.preservedConflicts} scelte conservate da rivedere. Le sorgenti ospite non confermate restano sul dispositivo.`);
      completed = true;
    } catch (importError) {
      if (isCurrent()) setError(operationError(importError));
    } finally {
      if (isCurrent()) {
        setIsImportingPlan(false);
        if (completed) setConfirmPlanImport(false);
      }
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
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
      <div className="mb-5"><Link to="/" className="ik-back-link inline-flex min-h-11 items-center rounded-xl px-2 font-semibold underline underline-offset-2">← {returnLinkLabel}</Link></div>
      <PageSection
        eyebrow="Account verificato"
        title="Il tuo profilo"
        titleId="profile-title"
        titleLevel="h1"
        action={
          <button type="button" onClick={() => { void handleLogout(); }} className="rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil)]">Esci</button>
        }
        className="ik-profile-surface sm:space-y-5"
      >
        <p className="mt-2 text-[var(--ik-ink-muted)]">{user.email}</p>
        <div className="mt-4">
          <Link to="/house" className="inline-flex min-h-11 items-center rounded-xl border-2 border-[var(--ik-sage)] bg-[var(--ik-mist)] px-4 py-2 font-bold text-[var(--ik-basil-dark)] hover:border-[var(--ik-basil-dark)]">La mia casa</Link>
        </div>

        {message !== null && <p role="status" className="mt-5 rounded-xl bg-[var(--ik-mist)] p-3 font-semibold text-[var(--ik-basil-dark)]">{message}</p>}
        {error !== null && <ErrorBanner message={error} />}

        <div className="mt-7 grid gap-4 border-t border-[var(--ik-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--ik-ink)]">Dettagli</h2>
          <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
            Nome visualizzato
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} className="min-h-11 rounded-xl border-2 border-[var(--ik-border)] bg-[var(--ik-mist)] px-3 outline-none focus:border-[var(--ik-basil)]" />
          </label>
          <button type="button" onClick={() => void saveProfile()} disabled={isLoading || csrfToken === null} className="min-h-11 w-full rounded-xl bg-[var(--ik-basil)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)] disabled:opacity-60 sm:w-fit">Salva profilo</button>
        </div>

        <div className="mt-7 grid gap-3 border-t border-[var(--ik-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--ik-ink)]">I tuoi dati</h2>
          <p className="leading-relaxed text-[var(--ik-ink-muted)]">{hasHouse
            ? 'Importa esplicitamente i dati ospite nella Casa attiva. La dispensa ospite viene unita senza duplicare le quantità e rimossa dal dispositivo solo dopo la conferma del server; gli altri dati ospite restano sul dispositivo.'
            : 'Importa esplicitamente i dati ospite nel tuo account. I dati locali resteranno sul dispositivo e non verranno cancellati.'}</p>
          {isSousChef() && guestPlanLoadFailed && <p role="status" className="rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 font-semibold text-[var(--ik-warn-ink)]">Non è stato possibile verificare il Piano ospite su questo dispositivo.</p>}
          {isSousChef() && guestPlanCount !== null && guestPlanCount > 0 && (
            <section aria-labelledby="guest-plan-import-title" className="grid gap-3 rounded-2xl border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4">
              <div>
                <h3 id="guest-plan-import-title" className="font-black text-[var(--ik-ink)]">Piano ospite sul dispositivo</h3>
                <p className="mt-1 text-sm leading-relaxed text-[var(--ik-ink-muted)]">{guestPlanCount} scelte locali. L'importazione è separata dal resto dei dati e non parte con il login. Le voci sorgente vengono rimosse solo dopo la conferma del server; conflitti e interruzioni conservano il Piano ospite.</p>
              </div>
              {!confirmPlanImport ? (
                <button type="button" onClick={() => setConfirmPlanImport(true)} disabled={isImportingPlan || csrfToken === null || activeScope === 'guest'} className="min-h-11 w-full rounded-xl bg-[var(--ik-basil)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)] disabled:opacity-60 sm:w-fit">Importa Piano ospite</button>
              ) : (
                <div className="flex flex-col gap-3 rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <p className="basis-full font-semibold text-[var(--ik-warn-ink)]">Confermi l'importazione di {guestPlanCount} scelte del Piano ospite {hasHouse ? 'nella Casa attiva' : "nell'account"}? Le voci in conflitto resteranno sul dispositivo.</p>
                  <button type="button" onClick={() => void handlePlanImport()} disabled={isImportingPlan || csrfToken === null || activeScope === 'guest'} className="min-h-11 w-full rounded-xl bg-[var(--ik-basil)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)] disabled:opacity-60 sm:w-fit">{isImportingPlan ? 'Importazione…' : 'Conferma importazione Piano'}</button>
                  <button type="button" onClick={() => setConfirmPlanImport(false)} disabled={isImportingPlan} className="min-h-11 w-full rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil)] disabled:opacity-60 sm:w-fit">Annulla</button>
                </div>
              )}
              {activeScope === 'guest' && <p className="text-sm font-semibold text-[var(--ik-warn-ink)]">Attiva prima un account o una Casa come ambito di destinazione.</p>}
            </section>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {!confirmImport ? (
              <button type="button" onClick={() => setConfirmImport(true)} disabled={isImporting || csrfToken === null} className="min-h-11 w-full rounded-xl bg-[var(--ik-basil)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)] disabled:opacity-60 sm:w-fit">Importa i dati locali</button>
            ) : (
              <div className="flex w-full flex-col gap-3 rounded-xl border border-[var(--ik-accent-border)] bg-[var(--ik-yolk-soft)] p-3 sm:flex-row sm:flex-wrap sm:items-center">
                <p className="basis-full font-semibold text-[var(--ik-warn-ink)]">{hasHouse
                  ? "Confermi l'unione dei dati ospite con la Casa attiva? La dispensa ospite viene rimossa solo dopo una fusione riuscita."
                  : "Confermi l'unione dei dati locali con quelli dell'account? I dati locali non verranno cancellati."}</p>
                <button type="button" onClick={() => void handleImport()} disabled={isImporting || csrfToken === null} className="min-h-11 w-full rounded-xl bg-[var(--ik-basil)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)] disabled:opacity-60 sm:w-fit">{isImporting ? 'Sincronizzazione…' : 'Conferma importazione'}</button>
                <button type="button" onClick={() => setConfirmImport(false)} disabled={isImporting} className="min-h-11 w-full rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil)] disabled:opacity-60 sm:w-fit">Annulla</button>
              </div>
            )}
            <button type="button" onClick={() => void handleExport()} className="min-h-11 w-full rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil)] sm:w-fit">Esporta i miei dati</button>
          </div>
        </div>

        <div className="mt-7 border-t border-[var(--ik-border)] pt-6">
          <h2 className="text-xl font-black text-[var(--ik-ink)]">Accesso con Google</h2>
          <p className="leading-relaxed text-[var(--ik-ink-muted)]">Collega lo stesso indirizzo Google verificato per usare il pulsante di accesso rapido.</p>
          <div className="max-w-sm">
            <GoogleSignInButton onCredential={(credential) => void handleGoogleLink(credential)} />
          </div>
          {isLinkingGoogle && <p className="text-sm font-semibold text-[var(--ik-ink-muted)]">Collegamento in corso…</p>}
        </div>

        <section className="mt-7 border-t border-[var(--ik-border)] pt-6" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading" className="text-xl font-black text-[var(--ik-ink)]">Privacy e servizi esterni</h2>
          <h3 className="mt-3 font-bold text-[var(--ik-ink)]">Bring!</h3>
          <p className="mt-2 leading-relaxed text-[var(--ik-ink-muted)]">Il collegamento richiede una conferma esplicita. Dopo la conferma, email e password vengono inviate a Bring! tramite il backend iKuck. La password non viene conservata; la sessione è cifrata sul server e resta personale, anche quando usi una Casa condivisa.</p>
          <p className="mt-2 leading-relaxed text-[var(--ik-ink-muted)]">Le azioni che richiedi inviano a Bring! i nomi degli articoli e le specifiche della lista collegata. La lista Bring! non è copiata nella lista iKuck e non è disponibile offline; gli ingredienti delle ricette non vengono trasferiti automaticamente.</p>
          <p className="mt-2 leading-relaxed text-[var(--ik-ink-muted)]">Scollegare rimuove la sessione salvata da iKuck, ma non garantisce la revoca di sessioni o dati conservati da Bring!</p>
        </section>

        <details className="mt-4 rounded-xl border border-[var(--ik-border)] bg-[var(--ik-mist)] px-4">
          <summary className="min-h-11 cursor-pointer py-3 font-bold text-[var(--ik-ink)] focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">Diagnostica applicazione</summary>
          <dl className="grid gap-2 border-t border-[var(--ik-border)] py-3 text-sm text-[var(--ik-ink-muted)] sm:grid-cols-2">
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

        <div className="mt-7 rounded-2xl border border-[var(--ik-tomato-soft)] bg-[var(--ik-surface)] p-4 sm:p-5">
          <h2 className="text-xl font-black text-[var(--ik-tomato)]">Zona delicata</h2>
          <p className="mt-2 leading-relaxed text-[var(--ik-ink-muted)]">Eliminare l’account rimuove i dati personali remoti e chiude la sessione. Se ci sono altri membri, i dati condivisi restano nella Casa. I dati ospite presenti sul dispositivo non vengono cancellati.</p>
          {!confirmDelete ? (
            <button type="button" onClick={() => setConfirmDelete(true)} className="mt-4 min-h-11 w-full rounded-xl border-2 border-[var(--ik-tomato)] px-4 py-2 font-bold text-[var(--ik-tomato)] hover:bg-[var(--ik-tomato-soft)] sm:w-fit">Elimina account</button>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="basis-full font-semibold text-[var(--ik-tomato)]">Confermi definitivamente?</p>
              <button type="button" onClick={() => void handleDelete()} disabled={isDeleting} className="min-h-11 w-full rounded-xl bg-[var(--ik-tomato)] px-4 py-2 font-bold text-[var(--ik-porcelain)] hover:opacity-90 disabled:opacity-60 sm:w-fit">{isDeleting ? 'Eliminazione…' : 'Conferma eliminazione account'}</button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="min-h-11 w-full rounded-xl border-2 border-[var(--ik-border)] px-4 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-basil)] sm:w-fit">Annulla</button>
            </div>
          )}
        </div>
      </PageSection>
      <ThemePreferenceControl />
      <ColorPaletteControl />
      <MotionPreferenceControl />
    </main>
  );
}
