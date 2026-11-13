import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiClientError, apiRequest } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

export default function RecipeImageSettings() {
  const user = useAuthStore(state => state.user);
  const csrfToken = useAuthStore(state => state.csrfToken);
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false); setMessage(null); setError(null);
    return () => { generation.current += 1; };
  }, [scope, user?.id, csrfToken]);
  const enabled = import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true';
  const verified = !!user?.emailVerifiedAt.trim() && csrfToken !== null && scope !== 'guest';
  const generate = async () => {
    if (!enabled || !verified || busy) return;
    const currentGeneration = generation.current;
    const isCurrent = () => currentGeneration === generation.current && getActiveDataScope() === scope
      && useAuthStore.getState().user?.id === user?.id && useAuthStore.getState().csrfToken === csrfToken;
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await apiRequest<{ queued: number }>('/v1/recipe-images/generate-library', {
        method: 'POST', csrfToken, body: { scope },
      });
      if (!isCurrent()) return;
      setMessage(result.queued > 0
        ? `${result.queued} immagini accodate. Saranno salvate automaticamente nel ricettario al termine dell’elaborazione.`
        : 'Le immagini disponibili sono già salvate o in elaborazione.');
      window.dispatchEvent(new Event('recipe-image-retry'));
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof ApiClientError && cause.code === 'ai_image_consent_required'
        ? 'Conferma prima il consenso per le immagini nella sezione Consenso AI.'
        : 'Non è stato possibile avviare le immagini. Verifica la connessione e riprova.');
    } finally { if (isCurrent()) setBusy(false); }
  };
  return (
    <section aria-labelledby="recipe-image-settings-title" className="ik-surface rounded-3xl border-2 p-5">
      <h2 id="recipe-image-settings-title" className="text-xl font-black">Immagini del ricettario</h2>
      <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Prepara le immagini mancanti del catalogo e delle ricette di cui sei autore nell’ambito attivo. Le immagini già salvate vengono mantenute. L’elaborazione avviene in background, con il consenso per le immagini e nei limiti della quota giornaliera.</p>
      <button type="button" className="ik-button-primary mt-4 min-h-11 px-4 py-2" disabled={!enabled || !verified || busy} onClick={() => void generate()}>
        {busy ? 'Avvio in corso…' : 'Genera e salva le immagini delle ricette'}
      </button>
      {!enabled && <p className="mt-2 text-sm">Il servizio immagini non è attivo.</p>}
      {!verified && <p className="mt-2 text-sm">Accedi con un account verificato per generare le immagini.</p>}
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    </section>
  );
}
