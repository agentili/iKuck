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
      className={`app-overlay fixed inset-x-4 z-50 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl border-2 border-[var(--ik-border)] ${
        ios ? 'bg-[var(--ik-mist)]' : 'bg-[var(--ik-surface)]'
      } px-3 py-2 shadow-xl sm:mx-auto sm:max-w-2xl sm:gap-4 sm:p-4`}
      aria-label={ios ? 'Usa iKuck come app' : 'Installa l’applicazione iKuck'}
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold text-[var(--ik-ink)]" role="status">
          {ios ? 'Usa iKuck come app' : 'Installa iKuck'}
        </p>
        <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">
          {ios
            ? 'Su iPhone o iPad tocca Condividi e poi “Aggiungi a Schermata Home” per usare iKuck come un’app.'
            : 'Aggiungi iKuck alla schermata home per aprirla con un tocco e usarla anche offline.'}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {!ios && (
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="min-h-11 rounded-xl bg-[var(--ik-basil-dark)] px-3 py-2 font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil)] disabled:cursor-wait disabled:opacity-60"
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
          className="min-h-11 rounded-xl border-2 border-[var(--ik-border)] px-3 py-2 font-bold text-[var(--ik-ink)] hover:border-[var(--ik-border-strong)] disabled:opacity-60"
        >
          {ios ? 'Ok, l’ho fatto' : 'Più tardi'}
        </button>
      </div>
    </aside>
  );
}
