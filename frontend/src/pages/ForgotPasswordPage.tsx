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
    <main id="main-content" className="ik-page auth-page mx-auto w-full max-w-xl px-4 py-8 sm:px-6">
      <section className="editorial-panel w-full rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        {submitted ? (
          <>
            <h1 className="text-3xl font-black text-gray-950">Controlla la tua email</h1>
            <p className="mt-3 text-gray-600">
              Se l'email è registrata, riceverai le istruzioni per recuperare l'account.
            </p>
            <Link to="/" className="mt-6 inline-flex min-h-11 items-center rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">
              Torna alle ricette
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-black text-gray-950">Recupera la password</h1>
            <p className="mt-3 text-gray-600">
              Inserisci la tua email per ricevere un link di recupero.
            </p>
            {error !== null && (
              <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 font-semibold text-rose-900">
                {error}
              </p>
            )}
            <form className="mt-5 grid gap-3" onSubmit={handleSubmit}>
              <label className="grid gap-1 text-sm font-semibold text-gray-800">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  maxLength={254}
                  className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900"
                />
              </label>
              <button
                type="submit"
                disabled={isLoading}
                className="mt-2 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:opacity-60"
              >
                {isLoading ? 'Invio…' : 'Invia link di recupero'}
              </button>
            </form>
            <Link to="/" className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-300 px-4 py-2 font-bold text-gray-800 hover:border-gray-900">
              Torna alle ricette
            </Link>
          </>
        )}
      </section>
    </main>
  );
}