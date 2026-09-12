import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api/apiClient';

type VerificationState = 'loading' | 'success' | 'error';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<VerificationState>('loading');

  useEffect(() => {
    const token = searchParams.get('token');
    if (token === null || token.length < 32) {
      setState('error');
      return;
    }

    void apiRequest(`/v1/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => setState('success'))
      .catch(() => setState('error'));
  }, [searchParams]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8 sm:px-6">
      <section className="w-full rounded-3xl border-2 border-gray-200 bg-white p-6 text-center shadow-sm sm:p-8">
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
            <p className="mt-3 text-gray-600">Il link non è valido o è scaduto.</p>
            <Link to="/" className="mt-6 inline-flex min-h-11 items-center rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">Torna alla dispensa</Link>
          </>
        )}
      </section>
    </main>
  );
}
