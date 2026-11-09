import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api/apiClient';

type VerificationState = 'ready' | 'loading' | 'success' | 'error';

const INVALID_LINK_MESSAGE = 'Il link non è valido o è scaduto.';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [token] = useState(() => searchParams.get('token'));
  const [state, setState] = useState<VerificationState>(() => (
    token !== null && token.length >= 32 ? 'ready' : 'error'
  ));

  useEffect(() => {
    if (token !== null) {
      window.history.replaceState(window.history.state ?? {}, '', `${location.pathname}${location.hash}`);
    }
  }, [location.hash, location.pathname, token]);

  const confirmEmail = async () => {
    if (token === null || token.length < 32) {
      setState('error');
      return;
    }

    setState('loading');
    try {
      await apiRequest('/v1/auth/verify-email', { method: 'POST', body: { token } });
      setState('success');
    } catch {
      setState('error');
    }
  };

  return (
    <main id="main-content" className="ik-page mx-auto flex min-h-screen w-full max-w-2xl !max-w-2xl items-center justify-center px-4 py-8 text-[var(--ik-ink)] sm:px-6 sm:py-10">
      <section
        aria-labelledby={state === 'loading' ? undefined : 'verify-email-title'}
        aria-label={state === 'loading' ? 'Verifica email' : undefined}
        className="ik-surface ik-profile-surface w-full border-2 p-6 sm:p-9"
      >
        <p className="ik-eyebrow">Account · Sicurezza</p>
        {state === 'ready' && (
          <>
            <h1 id="verify-email-title" className="mt-2 text-[clamp(1.6rem,5.6vw,2.6rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Conferma la tua email</h1>
            <p className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">Conferma il tuo indirizzo per attivare l’account iKuck.</p>
            <button type="button" onClick={() => { void confirmEmail(); }} className="ik-button-primary mt-6 inline-flex min-h-12 w-full items-center justify-center px-4 py-3 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Conferma email</button>
          </>
        )}
        {state === 'loading' && <p role="status" className="mt-2 font-semibold text-[var(--ik-ink-muted)]">Verifica in corso…</p>}
        {state === 'success' && (
          <>
            <h1 id="verify-email-title" className="mt-2 text-[clamp(1.6rem,5.6vw,2.6rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Email verificata</h1>
            <p role="status" aria-live="polite" className="mt-3 text-base leading-relaxed text-[var(--ik-ink-muted)]">Il tuo account iKuck è pronto per la sincronizzazione.</p>
            <Link to="/profile" className="ik-button-primary mt-6 inline-flex min-h-12 w-full items-center justify-center px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Vai al tuo profilo</Link>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 id="verify-email-title" className="mt-2 text-[clamp(1.6rem,5.6vw,2.6rem)] font-black leading-tight tracking-[-0.03em] text-[var(--ik-ink)]">Link non valido</h1>
            <p className="mt-3 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 font-semibold text-[var(--ik-tomato)]" role="alert">{INVALID_LINK_MESSAGE}</p>
            <Link to="/recipes" className="ik-button-secondary mt-6 inline-flex min-h-12 w-full items-center justify-center border-2 bg-[var(--ik-surface)] px-4 py-3 text-center font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Torna alle ricette</Link>
          </>
        )}
      </section>
    </main>
  );
}
