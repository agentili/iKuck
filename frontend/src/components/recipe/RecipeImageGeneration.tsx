import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AiRecipeConsentStatus } from '../../ai/aiRecipeApi';
import { ApiClientError, apiRequest } from '../../api/apiClient';
import { fetchAiConsentStatus, updateAiConsent } from '../../ai/aiRecipeApi';
import { useAuthStore } from '../../auth/authStore';
import { RECIPES } from '../../domain/recipes';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

interface Props { recipeId?: string; disabled?: boolean }

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
  const [accepted, setAccepted] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true';
  const verified = user !== null && user.emailVerifiedAt.trim() !== '' && csrfToken !== null;
  const catalog = recipeId !== undefined && RECIPES.some(recipe => recipe.id === recipeId);
  const scope = getActiveDataScope();
  const isCurrent = () => mounted.current && useAuthStore.getState().user?.id === user?.id
    && useAuthStore.getState().csrfToken === csrfToken && getActiveDataScope() === scope;

  const generate = async (authorize = false) => {
    if (!verified || !enabled || running.current || disabled) return;
    running.current = true;
    setBusy(true); setMessage(null); setError(null);
    try {
      if (!catalog) {
        const status = await fetchAiConsentStatus();
        if (!isCurrent()) return;
        if (!status.selectedImageProvider) throw new ApiClientError(503, 'images_disabled', 'Images unavailable');
        const valid = status.consent.enabled && status.consent.imagePolicyVersion === 'recipe-images-v1'
          && status.consent.imageProvider === status.selectedImageProvider;
        if (!valid) {
          if (!authorize || !accepted || consent?.selectedImageProvider !== status.selectedImageProvider) {
            setConsent(status); setAccepted(false); return;
          }
          await updateAiConsent(true, csrfToken!, status.consent.updatedAt, undefined, undefined, true, status.selectedImageProvider);
          if (!isCurrent()) return;
        }
      }
      const path = recipeId === undefined ? '/v1/recipe-images/generate'
        : `/v1/recipe-images/${encodeURIComponent(recipeId)}/generate?kind=${catalog ? 'catalog' : 'private'}`;
      const response = await apiRequest<{ queued: number }>(path, { method: 'POST', csrfToken: csrfToken! });
      if (!isCurrent()) return;
      setConsent(null);
      setMessage(response.queued > 0
        ? `${response.queued === 1 ? 'Immagine aggiunta' : `${response.queued} immagini aggiunte`} alla coda. La preparazione continua automaticamente; i limiti giornalieri possono richiedere più giorni.`
        : 'Le immagini sono già disponibili o in preparazione.');
      window.dispatchEvent(new Event('recipe-image-retry'));
    } catch (cause) {
      if (!isCurrent()) return;
      const code = cause instanceof ApiClientError ? cause.code : '';
      setError(code === 'images_disabled' ? 'Il servizio immagini non è disponibile in questo momento.'
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
      {recipeId === undefined && <p className="text-sm">Crea le immagini mancanti del catalogo e delle tue ricette salvate online, anche nella Casa. Le immagini già pronte vengono conservate.</p>}
      <button type="button" disabled={!enabled || !verified || busy || disabled} onClick={() => void generate()}
        className="ik-button-secondary min-h-12 px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:opacity-60">
        {busy ? 'Avvio in corso…' : recipeId === undefined ? 'Genera tutte le immagini' : 'Genera immagine'}
      </button>
      {!enabled ? <p className="text-sm">Il servizio immagini non è attivo.</p> : !verified && <p className="text-sm">Accedi con un account verificato per creare le immagini.</p>}
      {consent !== null && <div className="grid gap-3">
        <p className="text-sm">Per creare le immagini, il titolo del piatto viene inviato a Pexels; titolo, ingredienti e foto candidate vengono inviati a {consent.selectedImageProvider === 'gemini' ? 'Google Gemini' : 'OpenAI'} per cercare, valutare o generare immagini illustrative. Puoi revocare il consenso dalle impostazioni AI in Ricette.</p>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy} />Acconsento all’invio dei dati per creare le immagini</label>
        <button type="button" disabled={!accepted || busy} onClick={() => void generate(true)} className="ik-button-primary min-h-12 px-4 py-2 font-bold disabled:opacity-60">Conferma e genera</button>
      </div>}
      {message !== null && <p role="status" className="text-sm">{message}</p>}
      {error !== null && <p role="alert" className="text-sm text-[var(--ik-tomato)]">{error}</p>}
    </div>
  );
}
