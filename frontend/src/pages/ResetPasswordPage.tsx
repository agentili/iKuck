import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';

const resetError = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'network_error') {
    return 'Servizio non raggiungibile. Riprova quando torni online.';
  }
  if (error instanceof ApiClientError && error.code === 'invalid_token') {
    return 'Il link non è valido o è scaduto.';
  }
  if (error instanceof ApiClientError && error.code === 'password_too_short') {
    return 'La password deve avere almeno 12 caratteri.';
  }
  return 'Non è stato possibile aggiornare la password. Riprova.';
};

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [token] = useState(() => searchParams.get('token'));
  const hasUsableToken = token !== null && token.length >= 32;
  const resetPassword = useAuthStore((state) => state.resetPassword);
  const isLoading = useAuthStore((state) => state.isLoading);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [completed, setCompleted] = useState(false);
  const [isTokenInvalid, setIsTokenInvalid] = useState(!hasUsableToken);
  const [error, setError] = useState<string | null>(() => (
    hasUsableToken ? null : 'Il link non è valido o è scaduto.'
  ));

  useEffect(() => {
    if (token !== null) {
      window.history.replaceState(window.history.state ?? {}, '', `${location.pathname}${location.hash}`);
    }
  }, [location.hash, location.pathname, token]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError('Le password non coincidono.');
      return;
    }

    if (!hasUsableToken) {
      setIsTokenInvalid(true);
      setError('Il link non è valido o è scaduto.');
      return;
    }

    try {
      await resetPassword(token, password);
      setCompleted(true);
    } catch (resetErrorValue) {
      if (resetErrorValue instanceof ApiClientError && resetErrorValue.code === 'invalid_token') {
        setIsTokenInvalid(true);
      }
      setError(resetError(resetErrorValue));
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto flex min-h-screen w-full max-w-2xl !max-w-2xl items-center justify-center px-4 py-8 text-[var(--ik-ink)] sm:px-6 sm:py-10">
      <section aria-labelledby="reset-password-title" className="ik-surface ik-profile-surface w-full border-2 p-6 sm:p-9">
        {completed ? (
          <>
            <p className="ik-eyebrow">Account · Sicurezza</p>
            <h1 id="reset-password-title" className="mt-2 text-[clamp(2rem,7vw,3.25rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Password aggiornata</h1>
            <p role="status" aria-live="polite" className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">Ora puoi accedere al tuo account con la nuova password.</p>
            <Link to="/profile" className="ik-button-primary mt-6 inline-flex min-h-12 w-full items-center justify-center px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Vai all’accesso</Link>
          </>
        ) : (
          <>
            <p className="ik-eyebrow">Account · Sicurezza</p>
            <h1 id="reset-password-title" className="mt-2 text-[clamp(2rem,7vw,3.25rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Reimposta la password</h1>
            <p className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">Scegli una nuova password di almeno 12 caratteri.</p>
            {error !== null && <p role="alert" className="mt-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 font-semibold text-[var(--ik-tomato)]">{error}</p>}
            {isTokenInvalid ? (
              <Link to="/forgot-password" className="ik-button-secondary mt-6 inline-flex min-h-12 w-full items-center justify-center border-2 bg-[var(--ik-surface)] px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-fit">
                Richiedi un nuovo link
              </Link>
            ) : (
              <form className="mt-5 grid gap-3" onSubmit={handleSubmit}>
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Nuova password
                  <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className="ik-input min-h-12 border-2 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]" />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Conferma nuova password
                  <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className="ik-input min-h-12 border-2 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]" />
                </label>
                <button type="submit" disabled={isLoading} className="ik-button-primary mt-2 min-h-12 w-full px-4 py-3 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60 sm:w-fit">{isLoading ? 'Aggiornamento…' : 'Salva nuova password'}</button>
              </form>
            )}
          </>
        )}
      </section>
    </main>
  );
}
