import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';

declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }
  interface WindowEventMap {
    'beforeinstallprompt': BeforeInstallPromptEvent;
  }
}

const DISMISSED_KEY = 'ikuck-install-prompt-dismissed';

interface AppInstallPromptProps {
  onDismiss?: () => void;
}

export default function AppInstallPrompt({ onDismiss }: AppInstallPromptProps = {}) {
  const [promptReady, setPromptReady] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [ios, setIos] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  const isStandalone =
    (typeof window.matchMedia === 'function'
      && window.matchMedia('(display-mode: standalone)').matches === true)
    || (navigator as { standalone?: boolean }).standalone === true;

  const alreadyDismissed = useCallback((): boolean => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }, []);

  const markDismissed = useCallback(() => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Ignora se il browser non consente di scrivere in localStorage.
    }
    onDismiss?.();
  }, [onDismiss]);

  const handleInstall = useCallback(async () => {
    const prompt = deferredPrompt.current;
    if (!prompt || installing) return;
    setInstalling(true);
    try {
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === 'accepted') {
        markDismissed();
        setPromptReady(false);
      }
      // Se l’utente rifiuta il prompt nativo, il tasto resta visibile:
      // potrà riprovare a installare in un secondo momento.
    } finally {
      deferredPrompt.current = null;
      setInstalling(false);
    }
  }, [installing, markDismissed]);

  useEffect(() => {
    if (alreadyDismissed() || isStandalone) return;

    const isIos =
      /iPad|iPhone|iPod/.test(navigator.platform)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIos(isIos);

    if (isIos) {
      // iOS non espone beforeinstallprompt: si limita a mostrare le istruzioni.
      return;
    }

    const onBeforeInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      deferredPrompt.current = event;
      setPromptReady(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    };
  }, [alreadyDismissed, isStandalone]);

  if (!promptReady && !ios) return null;

  return (
    <aside
      className={`app-overlay fixed inset-x-4 z-50 flex flex-wrap items-center justify-between gap-4 rounded-2xl border-2 ${
        ios
          ? 'border-blue-200 bg-blue-50'
          : 'border-emerald-200 bg-white'
      } p-4 shadow-xl sm:mx-auto sm:max-w-2xl`}
      aria-label={ios ? 'Usa A tavola come app' : 'Installa l’applicazione A tavola'}
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold text-gray-950" role="status">
          {ios ? 'Usa A tavola come app' : 'Installa A tavola'}
        </p>
        <p className="mt-1 text-sm text-gray-700">
          {ios
            ? 'Su iPhone o iPad tocca Condividi e poi “Aggiungi a Schermata Home” per usare A tavola come un’app.'
            : 'Aggiungi A tavola alla schermata home per aprirla con un tocco e usarla anche offline.'}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {!ios && (
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="min-h-10 rounded-xl bg-emerald-700 px-3 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
          >
            {installing ? 'Sto installando…' : (
            <>
              <Download size={16} className="mr-1.5" aria-hidden="true" />
              Installa
            </>
          )}
          </button>
        )}
        <button
          type="button"
          onClick={markDismissed}
          className="min-h-10 rounded-xl border-2 border-gray-300 px-3 py-2 font-bold text-gray-800 hover:border-gray-900 disabled:opacity-60"
        >
          {ios ? 'Ok, l’ho fatto' : 'Più tardi'}
        </button>
      </div>
    </aside>
  );
}
