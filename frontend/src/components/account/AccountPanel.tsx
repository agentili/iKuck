import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogIn, UserRound } from 'lucide-react';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import GoogleSignInButton from './GoogleSignInButton';

type AccountMode = 'closed' | 'login' | 'register' | 'reset';

const errorMessage = (error: unknown): string => {
  const code = error instanceof ApiClientError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === 'email_not_verified') {
    return 'Devi verificare la tua email prima di accedere.';
  }
  if (code === 'email_already_registered') {
    return 'Questa email è già registrata. Prova ad accedere.';
  }
  if (code === 'invalid_credentials') {
    return 'Email o password non corrette.';
  }
  if (code === 'password_too_short') {
    return 'La password deve avere almeno 12 caratteri.';
  }
  if (code === 'network_error') {
    return 'Servizio non raggiungibile: puoi continuare a usare la dispensa offline.';
  }
  if (code === 'invalid_google_credential') {
    return 'Non è stato possibile verificare l’account Google.';
  }
  if (code === 'google_account_link_required') {
    return 'Questa email esiste già: accedi con la password e collega Google dal profilo.';
  }
  if (code === 'provider_unavailable') {
    return 'Accesso Google temporaneamente non disponibile.';
  }
  if (code === 'google_email_mismatch') {
    return 'L’email Google deve corrispondere a quella dell’account.';
  }
  return 'Non è stato possibile completare l’operazione. Riprova.';
};

export default function AccountPanel() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const connection = useAuthStore((state) => state.connection);
  const isLoading = useAuthStore((state) => state.isLoading);
  const login = useAuthStore((state) => state.login);
  const loginWithGoogle = useAuthStore((state) => state.loginWithGoogle);
  const register = useAuthStore((state) => state.register);
  const resendVerification = useAuthStore((state) => state.resendVerification);
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset);

  const [mode, setMode] = useState<AccountMode>('closed');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error !== null) errorSummaryRef.current?.focus();
  }, [error]);

  const openMode = (nextMode: Exclude<AccountMode, 'closed'>) => {
    setMode(nextMode);
    setMessage(null);
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setError(null);

    try {
      if (mode === 'login') {
        await login(email, password);
        navigate('/profile');
      } else if (mode === 'register') {
        const result = await register(email, password);
        setMessage(result.verificationRequired
          ? 'Controlla la tua email per verificare l’account.'
          : 'Account creato. Ora puoi accedere.');
      } else if (mode === 'reset') {
        await requestPasswordReset(email);
        setMessage('Se l’email è registrata, riceverai le istruzioni per recuperare l’account.');
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
  };

  const handleResend = async () => {
    setMessage(null);
    setError(null);
    try {
      await resendVerification(email);
      setMessage('Se l’email è registrata e non ancora verificata, riceverai un nuovo link.');
    } catch (resendError) {
      setError(errorMessage(resendError));
    }
  };

  const handleGoogleCredential = async (credential: string) => {
    setMessage(null);
    setError(null);
    try {
      await loginWithGoogle(credential);
      navigate('/profile');
    } catch (googleError) {
      setError(errorMessage(googleError));
    }
  };

  if (user !== null) {
    return (
      <section aria-label="Account" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-700 text-white">
            <UserRound size={19} aria-hidden="true" />
          </span>
          <div>
            <p className="font-bold text-emerald-950">Connesso</p>
            <p className="text-sm text-emerald-900">{user.email}</p>
          </div>
        </div>
        <Link to="/profile" className="rounded-xl bg-white px-4 py-2 font-bold text-emerald-900 ring-1 ring-emerald-300 hover:ring-emerald-600">
          Apri il profilo
        </Link>
      </section>
    );
  }

  if (mode === 'closed') {
    return (
      <section aria-label="Account" className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <p className="font-bold text-gray-950">Vuoi ritrovare la tua dispensa ovunque?</p>
          <p className="mt-1 text-sm text-gray-600">I tuoi dati restano su questo dispositivo.</p>
          {connection === 'offline' && <p className="mt-2 text-sm font-semibold text-amber-800">Sei offline: la dispensa continua a funzionare.</p>}
        </div>
        <div className="grid w-full max-w-sm gap-2 sm:w-auto">
          <button type="button" onClick={() => openMode('login')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800">
            <LogIn size={17} aria-hidden="true" />
            Accedi o registrati
          </button>
          <GoogleSignInButton onCredential={(credential) => void handleGoogleCredential(credential)} />
        </div>
        {error !== null && <p ref={errorSummaryRef} id="account-error" role="alert" tabIndex={-1} className="basis-full rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-900">{error}</p>}
      </section>
    );
  }

  return (
    <section aria-labelledby="account-title" className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="account-title" className="text-xl font-black text-gray-950">Il tuo account</h2>
          <p className="mt-1 text-sm text-gray-600">La verifica email è necessaria per sincronizzare tra dispositivi.</p>
        </div>
        <button type="button" onClick={() => setMode('closed')} className="text-sm font-semibold text-gray-600 underline underline-offset-2">Chiudi</button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => openMode('login')} className={`rounded-full px-3 py-1.5 text-sm font-bold ${mode === 'login' ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-700'}`}>Accedi</button>
        <button type="button" aria-pressed={mode === 'register'} onClick={() => openMode('register')} className={`rounded-full px-3 py-1.5 text-sm font-bold ${mode === 'register' ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-700'}`}>Registrati</button>
        <button type="button" aria-pressed={mode === 'reset'} onClick={() => openMode('reset')} className={`rounded-full px-3 py-1.5 text-sm font-bold ${mode === 'reset' ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-700'}`}>Recupera password</button>
      </div>

      {message !== null && <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">{message}</p>}
      {error !== null && <p ref={errorSummaryRef} id="account-error" role="alert" tabIndex={-1} className="mt-4 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-900">{error}</p>}

      <div className="mt-4 border-b border-gray-200 pb-4">
        <GoogleSignInButton onCredential={(credential) => void handleGoogleCredential(credential)} />
      </div>

      <form className="mt-4 grid gap-3" onSubmit={handleSubmit}>
        <label className="grid gap-1 text-sm font-semibold text-gray-800">
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            aria-describedby={error !== null ? 'account-error' : undefined}
            required
            maxLength={254}
            className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 text-base outline-none focus:border-gray-900"
          />
        </label>
        {mode !== 'reset' && (
          <label className="grid gap-1 text-sm font-semibold text-gray-800">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              aria-describedby={error !== null ? 'account-error' : undefined}
              required
              minLength={mode === 'register' ? 12 : undefined}
              maxLength={256}
              className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 text-base outline-none focus:border-gray-900"
            />
          </label>
        )}
        <button type="submit" aria-label={mode === 'login' ? 'Accedi al profilo' : undefined} disabled={isLoading} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">
          {isLoading ? 'Attendi…' : mode === 'login' ? 'Accedi' : mode === 'register' ? 'Crea account' : 'Invia link di recupero'}
        </button>
      </form>

      {mode === 'login' && (
        <button type="button" onClick={handleResend} className="mt-3 text-sm font-semibold text-gray-700 underline underline-offset-2">
          Invia di nuovo la verifica
        </button>
      )}
    </section>
  );
}
