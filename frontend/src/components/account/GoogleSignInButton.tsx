import { useEffect, useRef } from 'react';

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleAccountsId {
  initialize: (options: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
  }) => void;
  renderButton: (parent: HTMLElement, options: {
    theme: 'outline' | 'filled_blue' | 'filled_black';
    size: 'large' | 'medium' | 'small';
    width: number;
    text: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  }) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

interface GoogleSignInButtonProps {
  onCredential: (credential: string) => void;
  onUnavailable: () => void;
}

const GOOGLE_SCRIPT_ID = 'google-identity-services';

export default function GoogleSignInButton({ onCredential, onUnavailable }: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const configuredClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  const clientId = configuredClientId?.trim() || undefined;

  useEffect(() => {
    if (!clientId || containerRef.current === null) return undefined;

    let cancelled = false;
    const renderButton = () => {
      if (cancelled || containerRef.current === null || window.google === undefined) return;
      containerRef.current.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => onCredential(response.credential),
      });
      window.google.accounts.id.renderButton(containerRef.current, {
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        width: Math.min(containerRef.current.clientWidth || 320, 400),
      });
    };

    const existingScript = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    if (window.google !== undefined) {
      renderButton();
    } else if (existingScript !== null) {
      existingScript.addEventListener('load', renderButton, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = GOOGLE_SCRIPT_ID;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', renderButton, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [clientId, onCredential]);

  if (clientId === undefined) {
    return (
      <button type="button" onClick={onUnavailable} className="min-h-11 w-full rounded-xl border-2 border-gray-300 bg-white px-4 py-2 font-bold text-gray-800 hover:border-gray-900">
        Accedi con Google
      </button>
    );
  }

  return <div ref={containerRef} className="min-h-10 w-full" aria-label="Accedi con Google" />;
}
