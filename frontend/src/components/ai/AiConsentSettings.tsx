import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiClientError } from '../../api/apiClient';
import { useAuthStore } from '../../auth/authStore';
import { clearAiRecipeProposalHistory } from '../../ai/aiRecipeHistory';
import { fetchAiConsentStatus, updateAiConsent, type AiRecipeConsentStatus } from '../../ai/aiRecipeApi';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

interface ConsentOwner {
  userId: string;
  csrfToken: string;
  scope: string;
}

interface ConsentRecord {
  owner: ConsentOwner;
  status: AiRecipeConsentStatus;
}

const getLiveConsentOwner = (): ConsentOwner | null => {
  const { user, csrfToken } = useAuthStore.getState();
  if (user === null || csrfToken === null || user.emailVerifiedAt.trim().length === 0) return null;
  return { userId: user.id, csrfToken, scope: getActiveDataScope() };
};

const hasSameOwner = (first: ConsentOwner | null, second: ConsentOwner | null): boolean => first !== null
  && second !== null
  && first.userId === second.userId
  && first.csrfToken === second.csrfToken
  && first.scope === second.scope;

const isCurrentConsentOwner = (
  owner: ConsentOwner,
  generation: number,
  requestGeneration: { current: number },
  mounted: { current: boolean },
): boolean => mounted.current
  && requestGeneration.current === generation
  && hasSameOwner(owner, getLiveConsentOwner());

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError && error.code === 'provider_unavailable') {
    return 'Il provider AI non è disponibile. Non è stata modificata alcuna autorizzazione.';
  }
  return error instanceof ApiClientError && error.code === 'network_error'
    ? 'Non è stato possibile contattare il servizio AI. Controlla la connessione e riprova.'
    : 'Non è stato possibile verificare il consenso AI. Riprova.';
};

export default function AiConsentSettings() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const userId = user?.id ?? null;
  const owner = useMemo<ConsentOwner | null>(() => verified && userId !== null && csrfToken !== null
    ? { userId, csrfToken, scope }
    : null, [verified, userId, csrfToken, scope]);
  const [statusRecord, setStatusRecord] = useState<ConsentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentDraft, setConsentDraft] = useState(false);
  const [imageConsentDraft, setImageConsentDraft] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(false);
  const status = statusRecord !== null && hasSameOwner(owner, statusRecord.owner) ? statusRecord.status : null;
  const imageConsentEnabled = status !== null
    && status.selectedImageProvider !== undefined
    && status.consent.enabled
    && status.consent.imagePolicyVersion === 'recipe-images-v1'
    && status.consent.imageProvider === status.selectedImageProvider;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const requestOwner = owner;
    const generation = ++requestGeneration.current;
    setStatusRecord(null);
    setError(null);
    setConsentDraft(false);
    setImageConsentDraft(false);
    setNotice(null);
    setIsSaving(false);
    if (!verified) {
      return () => { active = false; };
    }
    if (requestOwner === null) {
      return () => { active = false; };
    }
    void fetchAiConsentStatus()
      .then((nextStatus) => {
        if (!active || !isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
        setStatusRecord({ owner: requestOwner, status: nextStatus });
        setConsentDraft(nextStatus.consent.enabled && nextStatus.consent.homeProvider === nextStatus.selectedProvider);
        setImageConsentDraft(nextStatus.selectedImageProvider !== undefined
          && nextStatus.consent.enabled
          && nextStatus.consent.imagePolicyVersion === 'recipe-images-v1'
          && nextStatus.consent.imageProvider === nextStatus.selectedImageProvider);
      })
      .catch((loadError: unknown) => {
        if (active && isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) setError(errorMessage(loadError));
      });
    return () => { active = false; };
  }, [verified, owner]);

  const homeConsentEnabled = status !== null
    && status.consent.enabled
    && status.consent.homeProvider === status.selectedProvider;

  const saveConsent = async (): Promise<void> => {
    const requestOwner = owner;
    const generation = requestGeneration.current;
    if (requestOwner === null || !isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)
      || status === null || !consentDraft || homeConsentEnabled || isSaving) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const consent = await updateAiConsent(true, requestOwner.csrfToken, status.consent.updatedAt, undefined, status.selectedProvider);
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      setStatusRecord({ owner: requestOwner, status: { ...status, consent } });
      setConsentDraft(consent.enabled && consent.homeProvider === status.selectedProvider);
      setNotice(`Consenso attivo per ${status.selectedProvider === 'gemini' ? 'Gemini di Google' : 'OpenAI'}.`);
    } catch (saveError) {
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      if (saveError instanceof ApiClientError && saveError.code === 'ai_consent_revision_conflict') {
        try {
          const latest = await fetchAiConsentStatus();
          if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
          setStatusRecord({ owner: requestOwner, status: latest });
          setConsentDraft(latest.consent.enabled && latest.consent.homeProvider === latest.selectedProvider);
          setImageConsentDraft(latest.selectedImageProvider !== undefined
            && latest.consent.enabled
            && latest.consent.imagePolicyVersion === 'recipe-images-v1'
            && latest.consent.imageProvider === latest.selectedImageProvider);
          setError('Il consenso è cambiato in un’altra scheda. Ho aggiornato lo stato: controlla la scelta prima di salvare di nuovo.');
        } catch {
          setError('Il consenso è cambiato in un’altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
        }
      } else {
        setError(errorMessage(saveError));
      }
    } finally {
      if (isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) setIsSaving(false);
    }
  };

  const saveImageConsent = async (): Promise<void> => {
    const requestOwner = owner;
    const generation = requestGeneration.current;
    if (requestOwner === null || !isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)
      || status === null || status.selectedImageProvider === undefined || !imageConsentDraft || imageConsentEnabled || isSaving) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const consent = await updateAiConsent(true, requestOwner.csrfToken, status.consent.updatedAt, undefined, undefined, true, status.selectedImageProvider);
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      setStatusRecord({ owner: requestOwner, status: { ...status, consent } });
      setImageConsentDraft(consent.enabled && consent.imagePolicyVersion === 'recipe-images-v1' && consent.imageProvider === status.selectedImageProvider);
    } catch (saveError) {
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      if (saveError instanceof ApiClientError && saveError.code === 'ai_consent_revision_conflict') {
        try {
          const latest = await fetchAiConsentStatus();
          if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
          setStatusRecord({ owner: requestOwner, status: latest });
          setConsentDraft(latest.consent.enabled && latest.consent.homeProvider === latest.selectedProvider);
          setImageConsentDraft(latest.selectedImageProvider !== undefined
            && latest.consent.enabled
            && latest.consent.imagePolicyVersion === 'recipe-images-v1'
            && latest.consent.imageProvider === latest.selectedImageProvider);
          setError('Il consenso è cambiato in un’altra scheda. Ho aggiornato lo stato: controlla la scelta prima di salvare di nuovo.');
        } catch {
          setError('Il consenso è cambiato in un’altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
        }
      } else {
        setError(errorMessage(saveError));
      }
    } finally {
      if (isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) setIsSaving(false);
    }
  };

  const revokeConsent = async (): Promise<void> => {
    const requestOwner = owner;
    const generation = requestGeneration.current;
    if (requestOwner === null || !isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)
      || status === null || !status.consent.enabled || isSaving) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const consent = await updateAiConsent(false, requestOwner.csrfToken, status.consent.updatedAt);
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      setStatusRecord({ owner: requestOwner, status: { ...status, consent } });
      setConsentDraft(false);
      setImageConsentDraft(false);
      const historyCleared = await clearAiRecipeProposalHistory(requestOwner.userId).catch(() => false);
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      setNotice('Consenso AI revocato. Non invieremo nuovi dati al provider delle ricette.');
      if (!historyCleared) {
        setError('Consenso revocato, ma non è stato possibile sincronizzare la cancellazione della cronologia tra schede. Chiudi le altre schede e ricarica la pagina.');
      }
    } catch (revokeError) {
      if (!isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) return;
      setError(errorMessage(revokeError));
    } finally {
      if (isCurrentConsentOwner(requestOwner, generation, requestGeneration, mounted)) setIsSaving(false);
    }
  };

  return (
    <section id="ai-consent-settings" aria-labelledby="ai-consent-settings-title" className="ik-surface ik-profile-surface mt-7 grid gap-3 rounded-3xl border-2 p-5">
      <h2 id="ai-consent-settings-title" className="text-xl font-black text-[var(--ik-ink)]">Consenso per le ricette AI</h2>
      {!verified
        ? <p className="text-sm text-[var(--ik-ink-muted)]">Per autorizzare l’invio di dati a un provider AI, accedi con un account verificato.</p>
        : status === null
        ? <p role={error === null ? 'status' : 'alert'} className="text-sm text-[var(--ik-ink-muted)]">{error ?? 'Verifico il consenso AI…'}</p>
        : (
          <>
            <p className="text-sm text-[var(--ik-ink-muted)]">Provider selezionato dal server: {status.selectedProvider === 'gemini' ? 'Gemini di Google' : 'OpenAI'}.</p>
            <p className="text-sm leading-relaxed text-[var(--ik-ink-muted)]">Quando chiedi una ricetta, al provider selezionato possono essere inviati gli ingredienti della dispensa oppure il titolo o la descrizione del piatto, il profilo alimentare e le indicazioni di generazione, insieme ai titoli e agli ingredienti delle ricette AI salvate o proposte. L’invio avviene solo dopo il consenso esplicito qui sotto.</p>
            <label className="flex min-h-11 items-start gap-3 font-semibold text-[var(--ik-ink)]">
              <input
                type="checkbox"
                checked={consentDraft}
                onChange={(event) => setConsentDraft(event.target.checked)}
                disabled={isSaving || homeConsentEnabled}
                aria-label={`Acconsento all’invio a ${status.selectedProvider === 'gemini' ? 'Gemini di Google' : 'OpenAI'} dei dati necessari per creare ricette AI`}
                className="mt-0.5 h-5 w-5 accent-[var(--ik-basil)]"
              />
              <span>Acconsento all’invio al provider selezionato dei dati indicati per creare ricette AI.</span>
            </label>
            {!homeConsentEnabled && <button type="button" onClick={() => void saveConsent()} disabled={!consentDraft || isSaving} className="ik-button-primary min-h-11 w-full px-4 py-2 font-bold disabled:opacity-60 sm:w-fit">{isSaving ? 'Salvataggio…' : 'Salva consenso AI'}</button>}
            {status.selectedImageProvider !== undefined && (
              <div className="grid gap-3 border-t border-[var(--ik-border)] pt-3">
                <h3 className="font-bold text-[var(--ik-ink)]">Consenso per le immagini delle ricette</h3>
                <p className="text-sm leading-relaxed text-[var(--ik-ink-muted)]">Per cercare, valutare o generare immagini illustrative, il titolo del piatto viene inviato a Pexels; titolo, ingredienti e foto candidate vengono inviati a {status.selectedImageProvider === 'gemini' ? 'Google Gemini' : 'OpenAI'}. Questo consenso è separato da quello per creare ricette.</p>
                <label className="flex min-h-11 items-start gap-3 font-semibold text-[var(--ik-ink)]">
                  <input
                    type="checkbox"
                    checked={imageConsentDraft}
                    onChange={(event) => setImageConsentDraft(event.target.checked)}
                    disabled={isSaving || imageConsentEnabled}
                    aria-label={`Acconsento all’invio a ${status.selectedImageProvider === 'gemini' ? 'Gemini di Google' : 'OpenAI'} per le immagini delle ricette`}
                    className="mt-0.5 h-5 w-5 accent-[var(--ik-basil)]"
                  />
                  <span>Acconsento all’invio dei dati indicati per cercare, valutare o generare immagini.</span>
                </label>
                {!imageConsentEnabled
                  ? <button type="button" onClick={() => void saveImageConsent()} disabled={!imageConsentDraft || isSaving} className="ik-button-secondary min-h-11 w-full px-4 py-2 font-bold disabled:opacity-60 sm:w-fit">{isSaving ? 'Salvataggio…' : 'Salva consenso immagini AI'}</button>
                  : <p role="status" className="text-sm font-semibold text-[var(--ik-basil-dark)]">Consenso immagini attivo per {status.selectedImageProvider === 'gemini' ? 'Gemini di Google' : 'OpenAI'}.</p>}
              </div>
            )}
            {status.consent.enabled && <button type="button" onClick={() => void revokeConsent()} disabled={isSaving} className="min-h-11 justify-self-start rounded-xl border-2 border-[var(--ik-tomato)] px-4 py-2 font-bold text-[var(--ik-tomato)] disabled:opacity-60">{isSaving ? 'Salvataggio…' : 'Revoca consenso AI globale'}</button>}
            {status.selectedImageProvider === undefined && <p className="text-sm text-[var(--ik-ink-muted)]">Il servizio per la creazione di immagini non è disponibile sul server; non è possibile autorizzare l’invio per le immagini.</p>}
            {notice !== null && <p role="status" className="text-sm font-semibold text-[var(--ik-basil-dark)]">{notice}</p>}
            {error !== null && <p role="alert" className="text-sm font-semibold text-[var(--ik-tomato)]">{error}</p>}
          </>
        )}
    </section>
  );
}
