import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AiRecipeConsentStatus } from '../../ai/aiRecipeApi';
import { ApiClientError, apiRequest } from '../../api/apiClient';
import { fetchAiConsentStatus } from '../../ai/aiRecipeApi';
import { useAuthStore } from '../../auth/authStore';
import { RECIPES } from '../../domain/recipes';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

interface Props { recipeId: string; disabled?: boolean }

export default function RecipeImageGeneration(props: Props) {
  const user = useAuthStore(state => state.user);
  const csrfToken = useAuthStore(state => state.csrfToken);
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope);
  return <GenerationControl key={`${user?.id}:${csrfToken}:${scope}:${props.recipeId}`} {...props} />;
}

function GenerationControl({ recipeId, disabled = false }: Props) {
  const user = useAuthStore(state => state.user);
  const csrfToken = useAuthStore(state => state.csrfToken);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<AiRecipeConsentStatus | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const verified = user !== null && user.emailVerifiedAt.trim() !== '' && csrfToken !== null;
  const catalog = RECIPES.some(recipe => recipe.id === recipeId);
  const scope = getActiveDataScope();
  const isCurrent = () => mounted.current && useAuthStore.getState().user?.id === user?.id
    && useAuthStore.getState().csrfToken === csrfToken && getActiveDataScope() === scope;

  const generate = async () => {
    if (!verified || running.current || disabled) return;
    running.current = true;
    setBusy(true); setMessage(null); setError(null);
    try {
      if (!catalog) {
        const status = await fetchAiConsentStatus();
        if (!isCurrent()) return;
        if (!status.selectedImageProvider) throw new ApiClientError(503, 'images_disabled', 'Images unavailable');
        const valid = status.consent.enabled && status.consent.imagePolicyVersion === 'recipe-images-v3'
          && status.consent.imageProvider === 'openai' && status.selectedImageProvider === 'openai';
        if (!valid) {
          setConsent(status);
          return;
        }
      }
      const path = `/v1/recipe-images/${encodeURIComponent(recipeId)}/generate?kind=${catalog ? 'catalog' : 'private'}`;
      const response = await apiRequest<{ queued: number }>(path, { method: 'POST', csrfToken: csrfToken! });
      if (!isCurrent()) return;
      setConsent(null);
      setMessage(response.queued > 0
        ? 'Immagine aggiunta alla coda. La preparazione continua automaticamente; il limite giornaliero può richiedere più giorni.'
        : 'L’immagine è già disponibile o in preparazione.');
      window.dispatchEvent(new Event('recipe-image-retry'));
    } catch (cause) {
      if (!isCurrent()) return;
      const code = cause instanceof ApiClientError ? cause.code : '';
      setError(code === 'images_disabled' ? 'Il servizio immagini non è attivo sul server.'
        : code === 'recipe_not_found' ? 'Salva prima la ricetta nel tuo account. Puoi creare immagini solo per le ricette di cui sei autore.'
          : code === 'image_consent_required' || code === 'ai_consent_revision_conflict' ? 'Il consenso è cambiato. Riprova e conferma il consenso aggiornato.'
            : 'Non è stato possibile avviare la creazione delle immagini. Controlla la connessione e riprova.');
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <div className="my-3 grid gap-3 rounded-xl bg-[var(--ik-mist)] p-3 text-[var(--ik-ink)]">
      <button type="button" disabled={!verified || busy || disabled} onClick={() => void generate()}
        className="ik-button-secondary min-h-12 px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:opacity-60">
        {busy ? 'Avvio in corso…' : 'Genera immagine'}
      </button>
      {!verified && <p className="text-sm">Accedi con un account verificato per creare le immagini.</p>}
      {consent !== null && <div className="grid gap-3">
        <p className="text-sm">Per generare un’immagine privata inviamo a OpenAI soltanto il titolo della ricetta e i nomi degli ingredienti. Quantità, descrizione, passaggi, profilo alimentare e dispensa non vengono inviati. Il consenso immagini è distinto da quello per creare ricette AI.</p>
        <a href="/profile#ai-consent-settings" className="inline-flex min-h-11 w-fit items-center rounded-xl px-2 py-2 font-bold text-[var(--ik-basil-dark)] underline underline-offset-2">Gestisci il consenso immagini nel Profilo</a>
      </div>}
      {message !== null && <p role="status" className="text-sm">{message}</p>}
      {error !== null && <p role="alert" className="text-sm text-[var(--ik-tomato)]">{error}</p>}
    </div>
  );
}
