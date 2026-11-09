import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';

const resetError = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'network_error') {
    return 'Servizio non raggiungibile. Riprova quando torni online.';
  }
  if (error instanceof ApiClientError && error.code === 'rate_limited') {
    return 'Troppi tentativi. Attendi qualche minuto prima di riprovare.';
  }
  return 'Non è stato possibile inviare il link. Riprova.';
};

export default function ForgotPasswordPage() {
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset);
  const isLoading = useAuthStore((state) => state.isLoading);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await requestPasswordReset(email);
      setSubmitted(true);
    } catch (resetErrorValue) {
      setError(resetError(resetErrorValue));
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto flex min-h-screen w-full max-w-2xl !max-w-2xl items-center justify-center px-4 py-8 text-[var(--ik-ink)] sm:px-6 sm:py-10">
      <section aria-labelledby="forgot-password-title" className="ik-surface ik-profile-surface w-full border-2 p-6 sm:p-9">
        {submitted ? (
          <>
            <p className="ik-eyebrow">Account · Recupero</p>
            <h1 id="forgot-password-title" className="mt-2 text-[clamp(1.6rem,5.6vw,2.6rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Controlla la tua email</h1>
            <p role="status" aria-live="polite" className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">
              Se l'email è registrata, riceverai le istruzioni per recuperare l'account.
            </p>
            <Link to="/recipes" className="ik-button-secondary mt-6 inline-flex min-h-12 w-full items-center justify-center border-2 bg-[var(--ik-surface)] px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">
              Torna alle ricette
            </Link>
          </>
        ) : (
          <>
            <p className="ik-eyebrow">Account · Recupero</p>
            <h1 id="forgot-password-title" className="mt-2 text-[clamp(1.6rem,5.6vw,2.6rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Recupera la password</h1>
            <p className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">
              Inserisci la tua email per ricevere un link di recupero.
            </p>
            {error !== null && (
              <p role="alert" className="mt-4 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 font-semibold text-[var(--ik-tomato)]">
                {error}
              </p>
            )}
            <form className="mt-5 grid gap-3" onSubmit={handleSubmit}>
              <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  maxLength={254}
                  className="ik-input min-h-12 border-2 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]"
                />
              </label>
              <button
                type="submit"
                disabled={isLoading}
                className="ik-button-primary mt-2 min-h-12 w-full px-4 py-3 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60 sm:w-fit"
              >
                {isLoading ? 'Invio…' : 'Invia link di recupero'}
              </button>
            </form>
            <Link to="/recipes" className="ik-button-secondary mt-4 inline-flex min-h-12 w-full items-center justify-center border-2 bg-[var(--ik-surface)] px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-fit">
              Torna alle ricette
            </Link>
          </>
        )}
      </section>
    </main>
  );
}