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
  const resetPassword = useAuthStore((state) => state.resetPassword);
  const isLoading = useAuthStore((state) => state.isLoading);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(() => (
    token === null || token.length < 32 ? 'Il link non è valido o è scaduto.' : null
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

    if (token === null || token.length < 32) {
      setError('Il link non è valido o è scaduto.');
      return;
    }

    try {
      await resetPassword(token, password);
      setCompleted(true);
    } catch (resetErrorValue) {
      setError(resetError(resetErrorValue));
    }
  };

  return (
    <main id="main-content" className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8 sm:px-6">
      <section className="w-full rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        {completed ? (
          <>
            <h1 className="text-3xl font-black text-gray-950">Password aggiornata</h1>
            <p className="mt-3 text-gray-600">Ora puoi accedere al tuo account con la nuova password.</p>
            <Link to="/" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Torna all’accesso</Link>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-black text-gray-950">Reimposta la password</h1>
            <p className="mt-3 text-gray-600">Scegli una nuova password di almeno 12 caratteri.</p>
            {error !== null && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 font-semibold text-rose-900">{error}</p>}
            <form className="mt-5 grid gap-3" onSubmit={handleSubmit}>
              <label className="grid gap-1 text-sm font-semibold text-gray-800">
                Nuova password
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900" />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-gray-800">
                Conferma nuova password
                <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900" />
              </label>
              <button type="submit" disabled={isLoading} className="mt-2 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:opacity-60">{isLoading ? 'Aggiornamento…' : 'Salva nuova password'}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
