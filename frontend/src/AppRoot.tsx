import { useCallback, useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import AppUpdatePrompt, { type AppUpdateStatus } from './components/feedback/AppUpdatePrompt';

export default function AppRoot() {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [updateError, setUpdateError] = useState<string | undefined>();
  const updateServiceWorker = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    const requestUpdate = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        if (active) {
          setUpdateError(undefined);
          setUpdateStatus('available');
        }
      },
      onRegisterError: () => {
        if (active) {
          setUpdateError('Non è stato possibile controllare gli aggiornamenti. Riprova più tardi.');
          setUpdateStatus('failed');
        }
      },
    });
    updateServiceWorker.current = requestUpdate;

    return () => {
      active = false;
      updateServiceWorker.current = null;
    };
  }, []);

  const handleUpdate = useCallback(() => {
    const requestUpdate = updateServiceWorker.current;
    if (requestUpdate === null) return;

    setUpdateStatus('updating');
    void requestUpdate(true).catch(() => {
      setUpdateError('Aggiornamento non riuscito. Riprova quando la connessione è disponibile.');
      setUpdateStatus('failed');
    });
  }, []);

  return (
    <>
      <App />
      {updateStatus !== null && (
        <AppUpdatePrompt
          status={updateStatus}
          errorMessage={updateError}
          onUpdate={handleUpdate}
          onLater={() => setUpdateStatus(null)}
        />
      )}
    </>
  );
}
