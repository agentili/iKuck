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
    <main id="main-content" className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8 sm:px-6">
      <section className="w-full rounded-3xl border-2 border-gray-200 bg-white p-6 text-center shadow-sm sm:p-8">
        {state === 'ready' && (
          <>
            <h1 className="text-3xl font-black text-gray-950">Conferma la tua email</h1>
            <p className="mt-3 text-gray-600">Conferma il tuo indirizzo per attivare l’account iKuck.</p>
            <button type="button" onClick={() => { void confirmEmail(); }} className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Conferma email</button>
          </>
        )}
        {state === 'loading' && <p role="status" className="font-semibold text-gray-700">Verifica in corso…</p>}
        {state === 'success' && (
          <>
            <h1 className="text-3xl font-black text-gray-950">Email verificata</h1>
            <p className="mt-3 text-gray-600">Il tuo account iKuck è pronto per la sincronizzazione.</p>
            <Link to="/profile" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Vai al tuo profilo</Link>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-3xl font-black text-gray-950">Link non valido</h1>
            <p className="mt-3 text-gray-600">{INVALID_LINK_MESSAGE}</p>
            <Link to="/" className="mt-6 inline-flex min-h-11 items-center rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Torna alle ricette</Link>
          </>
        )}
      </section>
    </main>
  );
}
