import { Link } from 'react-router-dom';
import RecipeImage from '../suggestions/RecipeImage';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LockKeyhole, Save, Sparkles, Trash2, X } from 'lucide-react';
import type { AiConsent, AiRecipeProvider, DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../../api/apiClient';
import { type AuthUser } from '../../auth/authStore';
import { deleteAiRecipe, fetchAiConsentStatus, fetchAiRecipes, generateAiRecipe, saveAiRecipe, updateAiConsent } from '../../ai/aiRecipeApi';
import {
  AI_RECIPE_PROPOSAL_HISTORY_LIMIT,
  captureAiRecipeProposalGeneration,
  clearAiRecipeProposalHistory,
  isAiRecipeProposalGenerationCurrent,
  loadAiRecipeProposalHistory,
  storeAiRecipeProposalHistory,
  subscribeToAiRecipeProposalRevocation,
  type ProposedAiRecipe,
} from '../../ai/aiRecipeHistory';
import { ALLERGEN_LABELS, DIET_LABELS } from '../../domain/dietary';
import UndoToast from '../feedback/UndoToast';

interface AiRecipePanelProps {
  onRecipeProposed?: (recipe: GeneratedRecipe) => void;
  constraints?: string[];
  dishDescription?: string;
  settingsOnly?: boolean;
  showConsent?: boolean;
  generationMode?: 'ingredients' | 'title';
  generationReady?: boolean;
  onRecipeSaved?: (recipe: GeneratedRecipe) => void;
  ingredients: string[];
  dietProfile: DietProfilePayload;
  user: AuthUser | null;
  csrfToken: string | null;
}

const errorMessage = (error: unknown): string => {
  const code = error instanceof ApiClientError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (code === 'ai_daily_limit_reached') return 'Hai raggiunto il limite giornaliero per le ricette AI.';
  if (code === 'ai_consent_required') return 'Salva il consenso prima di generare una ricetta AI.';
  if (code === 'ai_recipe_incompatible') return 'La ricetta generata non rispetta i filtri alimentari attivi.';
  if (code === 'ai_recipe_not_novel') return 'L’IA ha riproposto un’idea troppo simile: non l’ho mostrata. Riprova per una ricetta diversa.';
  if (code === 'network_error') return 'Servizio non raggiungibile: le ricette AI restano disponibili solo online.';
  if (code === 'provider_unavailable' || code === 'provider_error') return 'Il servizio delle ricette AI non è momentaneamente disponibile.';
  return 'Non è stato possibile completare l’operazione AI. Riprova.';
};

const normalizedIngredients = (ingredients: string[]): string[] => [...new Set(
  ingredients.map((ingredient) => ingredient.trim()).filter((ingredient) => ingredient.length > 0),
)];

const RecipeBody = ({ recipe }: { recipe: GeneratedRecipe }) => (
  <>
    <p data-ai-label className="mt-3 text-xs font-semibold uppercase tracking-wide text-emerald-800">Dieta: {recipe.diets.map((diet) => DIET_LABELS[diet]).join(', ')}</p>
    <p className="mt-1 text-xs text-gray-600">Allergeni dichiarati: {recipe.allergens.length === 0 ? 'nessuno' : recipe.allergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <h4 className="font-bold text-gray-950">Ingredienti</h4>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
          {recipe.ingredients.map((ingredient) => <li key={`${recipe.id}-${ingredient.name}`}>{ingredient.amount} {ingredient.name}</li>)}
        </ul>
      </div>
      <div>
        <h4 className="font-bold text-gray-950">Procedimento</h4>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700">
          {recipe.steps.map((step, index) => <li key={`${recipe.id}-step-${index}`}>{step}</li>)}
        </ol>
      </div>
    </div>
  </>
);

export default function AiRecipePanel({ ingredients, dietProfile, user, csrfToken, generationMode = 'ingredients', generationReady = true, settingsOnly = false, showConsent = true, onRecipeSaved, onRecipeProposed, constraints = [], dishDescription }: AiRecipePanelProps) {
  const fromTitle = generationMode === 'title';
  const fromDescription = dishDescription !== undefined;
  const [dishTitle, setDishTitle] = useState('');
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const userId = user?.id ?? null;
  const [consent, setConsent] = useState<AiConsent | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AiRecipeProvider | null>(null);
  const [imageProvider, setImageProvider] = useState<AiRecipeProvider | null>(null);
  const [consentDraft, setConsentDraft] = useState(false);
  const [recipes, setRecipes] = useState<GeneratedRecipe[]>([]);
  const [drafts, setDrafts] = useState<GeneratedRecipe[]>([]);
  const [proposedRecipes, setProposedRecipes] = useState<ProposedAiRecipe[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [savingDraftId, setSavingDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<GeneratedRecipe[]>([]);
  const pantryLabels = normalizedIngredients(ingredients);
  const hasGenerationInput = generationReady && (fromDescription ? dishDescription.trim().length > 0 && dishDescription.trim().length <= 240 : fromTitle ? dishTitle.trim().length > 0 && dishTitle.trim().length <= 240 : pantryLabels.length > 0);
  const selectedProviderLabel = selectedProvider === 'openai'
    ? 'OpenAI'
    : selectedProvider === 'gemini'
      ? 'Gemini di Google'
      : null;
  const homeConsentEnabled = consent?.enabled === true
    && selectedProvider !== null
    && consent.homeProvider === selectedProvider;
  const consentEpochRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const sessionScopeRef = useRef({ userId, csrfToken, verified, generation: 0 });
  const selectedProviderRef = useRef(selectedProvider);

  useLayoutEffect(() => {
    const previousScope = sessionScopeRef.current;
    if (previousScope.userId !== userId
      || previousScope.csrfToken !== csrfToken
      || previousScope.verified !== verified) {
      sessionScopeRef.current = { userId, csrfToken, verified, generation: previousScope.generation + 1 };
      consentEpochRef.current = null;
    }
    selectedProviderRef.current = selectedProvider;
  }, [userId, csrfToken, verified, selectedProvider]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!verified || userId === null) return undefined;
    return subscribeToAiRecipeProposalRevocation(userId, () => {
      consentEpochRef.current = null;
      setConsent((current) => current === null ? null : { ...current, enabled: false });
      setConsentDraft(false);
      setProposedRecipes([]);
    });
  }, [verified, userId]);

  useEffect(() => {
    let cancelled = false;
    const proposalGeneration = userId === null ? null : captureAiRecipeProposalGeneration(userId);
    consentEpochRef.current = null;
    setConsent(null);
    setSelectedProvider(null);
    setConsentDraft(false);
    setRecipes([]);
    setDrafts([]);
    setProposedRecipes([]);
    setIsGenerating(false);
    setSavingDraftId(null);
    setError(null);
    if (!verified || userId === null || proposalGeneration === null) return undefined;
    setProposedRecipes(loadAiRecipeProposalHistory(proposalGeneration));

    setIsLoading(true);
    void Promise.all([fetchAiConsentStatus(), settingsOnly ? Promise.resolve([]) : fetchAiRecipes()])
      .then(([consentStatus, nextRecipes]) => {
        if (cancelled) return;
        if (!isAiRecipeProposalGenerationCurrent(proposalGeneration)) {
          setConsent(null);
          setSelectedProvider(null);
          setConsentDraft(false);
          setProposedRecipes([]);
          return;
        }
        consentEpochRef.current = proposalGeneration.epoch;
        setConsent(consentStatus.consent);
        setSelectedProvider(consentStatus.selectedProvider);
        setImageProvider(consentStatus.selectedImageProvider ?? consentStatus.selectedProvider);
        setConsentDraft(consentStatus.consent.enabled && consentStatus.consent.homeProvider === consentStatus.selectedProvider);
        setRecipes(nextRecipes);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [verified, userId, csrfToken, settingsOnly]);

  if (!verified) {
    return (
      <section aria-label={settingsOnly ? "Consenso AI" : "Ricette AI private"} className="ik-ai-panel rounded-3xl border-2 border-emerald-200 bg-emerald-50/70 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span data-ai-emblem className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-700 text-white">
            <LockKeyhole size={19} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-black text-gray-950">{settingsOnly ? 'Consenso AI' : fromTitle ? 'Crea una ricetta con l’AI' : 'Ricette AI private'}</h2>
            <p className="mt-1 text-sm leading-relaxed text-gray-700">{fromTitle ? 'Scrivi il titolo di un piatto e lascia che l’AI crei ingredienti e procedimento. Accedi con un account verificato per iniziare.' : 'Per ospiti e account non verificati, le ricette AI private restano disattivate: ingredienti, profilo alimentare e ricette non vengono inviati a un provider AI. Dopo la verifica vedrai il destinatario e potrai dare un consenso esplicito.'}</p>
          </div>
        </div>
      </section>
    );
  }

  const saveConsent = async (enabled = consentDraft) => {
    if (csrfToken === null || user === null || (enabled && selectedProvider === null)) return;
    setIsSaving(true);
    setError(null);
    try {
      const nextConsent = import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true'
        ? await updateAiConsent(enabled, csrfToken, consent?.updatedAt, undefined, enabled ? selectedProvider ?? undefined : undefined, true, imageProvider ?? selectedProvider ?? undefined)
        : await updateAiConsent(enabled, csrfToken, consent?.updatedAt, undefined, enabled ? selectedProvider ?? undefined : undefined);
      setConsent(nextConsent);
      consentEpochRef.current = nextConsent.enabled && selectedProvider !== null && nextConsent.homeProvider === selectedProvider
        ? captureAiRecipeProposalGeneration(user.id).epoch
        : null;
      setConsentDraft(nextConsent.enabled && selectedProvider !== null && nextConsent.homeProvider === selectedProvider);
      if (!nextConsent.enabled) {
        const cleared = await clearAiRecipeProposalHistory(user.id);
        setProposedRecipes([]);
        if (!cleared) setError('Consenso revocato, ma non è stato possibile sincronizzare la revoca della cronologia tra schede. Chiudi le altre schede e ricarica la pagina.');
      }
    } catch (saveError) {
      if (saveError instanceof ApiClientError && saveError.code === 'ai_consent_revision_conflict') {
        try {
          const latestStatus = await fetchAiConsentStatus();
          setConsent(latestStatus.consent);
          setSelectedProvider(latestStatus.selectedProvider);
          setConsentDraft(latestStatus.consent.enabled && latestStatus.consent.homeProvider === latestStatus.selectedProvider);
          setError('Il consenso è cambiato in un’altra scheda. Ho aggiornato lo stato: controlla la scelta prima di salvare di nuovo.');
        } catch {
          setError('Il consenso è cambiato in un’altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
        }
      } else {
        setError(errorMessage(saveError));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const generate = async () => {
    if (csrfToken === null || user === null || homeConsentEnabled !== true || !hasGenerationInput || isGenerating) return;
    const generation = captureAiRecipeProposalGeneration(user.id);
    const generationScope = sessionScopeRef.current;
    const generationProvider = selectedProvider;
    const isCurrentGeneration = (): boolean => mountedRef.current
      && sessionScopeRef.current.generation === generationScope.generation
      && sessionScopeRef.current.userId === user.id
      && sessionScopeRef.current.csrfToken === csrfToken
      && sessionScopeRef.current.verified
      && selectedProviderRef.current === generationProvider
      && consentEpochRef.current === generation.epoch
      && isAiRecipeProposalGenerationCurrent(generation);
    if (!isCurrentGeneration()) {
      setError('Non posso verificare lo stato attuale del consenso. Aggiorna la pagina prima di generare.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    try {
      const recipe = await generateAiRecipe({
        ...(fromDescription ? { dishDescription: dishDescription.trim() } : fromTitle ? { dishTitle: dishTitle.trim() } : {}),
        ingredients: fromTitle || fromDescription ? [] : pantryLabels,
        constraints,
        existingRecipes: proposedRecipes.slice(-AI_RECIPE_PROPOSAL_HISTORY_LIMIT),
      }, dietProfile, csrfToken);
      if (!isCurrentGeneration()) return;
      const proposedRecipe = { title: recipe.title, ingredients: recipe.ingredients };
      const nextProposedRecipes = [...proposedRecipes, proposedRecipe].slice(-AI_RECIPE_PROPOSAL_HISTORY_LIMIT);
      await storeAiRecipeProposalHistory(generation, nextProposedRecipes);
      if (!isCurrentGeneration()) return;
      setProposedRecipes(nextProposedRecipes);
      if (onRecipeProposed) onRecipeProposed(recipe);
      else setDrafts((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
    } catch (generationError) {
      if (isCurrentGeneration()) setError(errorMessage(generationError));
    } finally {
      if (mountedRef.current && sessionScopeRef.current.generation === generationScope.generation) setIsGenerating(false);
    }
  };

  const saveDraft = async (recipe: GeneratedRecipe) => {
    if (csrfToken === null || savingDraftId !== null) return;
    const savingScope = sessionScopeRef.current;
    const isCurrentSave = () => mountedRef.current && sessionScopeRef.current === savingScope;
    setSavingDraftId(recipe.id);
    setError(null);
    try {
      const saved = await saveAiRecipe(recipe, csrfToken);
      if (!isCurrentSave()) return;
      setDrafts((current) => current.filter((item) => item.id !== saved.id));
      setRecipes((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      onRecipeSaved?.(saved);
    } catch (saveError) {
      if (isCurrentSave()) setError(errorMessage(saveError));
    } finally {
      if (isCurrentSave()) setSavingDraftId(null);
    }
  };

  const discardDraft = (recipeId: string) => {
    setError(null);
    setDrafts((current) => current.filter((item) => item.id !== recipeId));
  };

  const restorePendingDelete = (recipe: GeneratedRecipe) => {
    setPendingDeletes((current) => current.filter((item) => item.id !== recipe.id));
    setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
  };

  const finalizeDelete = async (recipe: GeneratedRecipe) => {
    if (csrfToken === null) return;
    setPendingDeletes((current) => current.filter((item) => item.id !== recipe.id));
    setError(null);
    try {
      await deleteAiRecipe(recipe.id, csrfToken);
    } catch (deleteError) {
      setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
      setError(errorMessage(deleteError));
    }
  };

  const remove = (recipeId: string) => {
    const recipe = recipes.find((item) => item.id === recipeId);
    if (recipe === undefined) return;
    setError(null);
    setRecipes((current) => current.filter((item) => item.id !== recipeId));
    setPendingDeletes((current) => [...current.filter((item) => item.id !== recipeId), recipe]);
  };

  return (
    <>
    <section aria-label={settingsOnly ? "Consenso AI" : "Ricette AI private"} className="ik-ai-panel rounded-3xl border-2 border-emerald-200 bg-emerald-50/70 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span data-ai-emblem className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-700 text-white">
            <Sparkles size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-black text-gray-950">{settingsOnly ? 'Consenso AI' : fromTitle ? 'Crea una ricetta con l’AI' : 'Ricette AI private'}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700">{settingsOnly ? 'Gestisci qui il consenso per ricette e immagini. Puoi revocarlo in qualsiasi momento.' : fromTitle ? 'Scrivi il nome del piatto: l’AI preparerà ingredienti, quantità e procedimento rispettando le tue preferenze alimentari.' : onRecipeProposed ? 'Genera una ricetta dalla descrizione del piatto e dal numero di porzioni, poi rivedila prima di salvarla nel ricettario.' : 'Usa gli ingredienti presenti per creare un’idea personale. Il contenuto resta legato al tuo account e non entra nel catalogo pubblico.'}</p>
          </div>
        </div>
        {isLoading && <p role="status" className="text-sm font-semibold text-emerald-900">Carico le tue ricette AI…</p>}
      </div>

      {!showConsent && !homeConsentEnabled && <p className="mt-3 text-sm">Per autorizzare l’AI, apri <Link to="/profile#ai-settings" className="font-bold underline">Consenso AI nel profilo</Link>.</p>}
      {error !== null && <p role="alert" className="mt-4 rounded-xl bg-rose-100 p-3 text-sm font-semibold text-rose-900">{error}</p>}

      {showConsent && consent !== null && selectedProviderLabel === null && (
        <details data-ai-consent className="mt-5 rounded-2xl border border-emerald-200 bg-white px-4">
          <summary className="min-h-11 cursor-pointer py-3 font-bold text-gray-950 focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
            Consenso AI per {settingsOnly ? 'ricette' : fromTitle ? 'creare dal titolo' : onRecipeProposed ? 'Piano' : 'Home'} <span className="block pl-5 text-sm font-medium text-amber-900">Provider non disponibile</span>
          </summary>
          <div className="border-t border-emerald-100 py-4">
            <p role="status" className="text-sm leading-relaxed text-gray-700">Il provider delle ricette AI non è disponibile: non inviamo dati e la generazione resta disattivata.</p>
          </div>
        </details>
      )}

      {showConsent && consent !== null && selectedProviderLabel !== null && (
        <details data-ai-consent className="mt-5 rounded-2xl border border-emerald-200 bg-white px-4">
          <summary className="min-h-11 cursor-pointer py-3 font-bold text-gray-950 focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700">
            Consenso AI per {settingsOnly ? 'ricette' : fromTitle ? 'creare dal titolo' : onRecipeProposed ? 'Piano' : 'Home'} <span className="block pl-5 text-sm font-medium text-gray-700">{homeConsentEnabled ? `Attivo per ${selectedProviderLabel}` : `Da autorizzare per ${selectedProviderLabel}`}</span>
          </summary>
          <div className="border-t border-emerald-100 py-4">
            <label className="flex items-start gap-3 text-sm font-semibold text-gray-800">
              <input
                type="checkbox"
                checked={consentDraft}
                onChange={(event) => setConsentDraft(event.target.checked)}
                disabled={isSaving}
                aria-label={settingsOnly ? `Acconsento all’invio a ${selectedProviderLabel} di titolo, descrizione del piatto, ingredienti, porzioni, profilo alimentare e ricette già salvate o proposte` : fromDescription ? `Acconsento all’invio a ${selectedProviderLabel} della descrizione del piatto, delle porzioni, del profilo alimentare e dei titoli e ingredienti delle ricette AI salvate o proposte` : fromTitle ? `Acconsento all’invio a ${selectedProviderLabel} del titolo del piatto, del profilo alimentare e dei titoli e ingredienti delle ricette AI salvate o proposte` : `Acconsento all’invio a ${selectedProviderLabel} degli ingredienti della dispensa, del profilo alimentare e dei titoli e ingredienti delle ricette AI salvate o proposte`}
                className="mt-0.5 h-5 w-5 accent-emerald-700"
              />
              <span>Acconsento all’invio a {selectedProviderLabel} dei dati indicati per creare ricette AI.</span>
            </label>
            <p className="mt-2 text-xs leading-relaxed text-gray-600">
              I dati inviati a {selectedProviderLabel}: {settingsOnly ? 'titolo o descrizione del piatto, ingredienti della dispensa' : fromDescription ? 'descrizione del piatto' : fromTitle ? 'titolo del piatto' : 'nomi degli ingredienti della dispensa'}; profilo alimentare (dieta scelta, allergeni esclusi, calorie massime e proteine minime per porzione); titoli e nomi/quantità degli ingredienti delle ricette AI salvate o già proposte. {constraints.length === 0 && !settingsOnly ? 'Inviamo anche l’elenco dei vincoli di generazione, attualmente vuoto.' : 'Inviamo anche il numero di porzioni e le indicazioni di generazione inserite.'}
            </p>
            {consent.enabled && !homeConsentEnabled && <p className="mt-2 text-xs font-semibold leading-relaxed text-amber-900">Il provider è cambiato o il consenso precedente non specificava il destinatario: non inviamo dati a {selectedProviderLabel} finché non approvi questa scelta.</p>}
            <p className="mt-2 text-xs leading-relaxed text-gray-600">Puoi revocare il consenso in qualsiasi momento. Le ricette già salvate restano visibili finché non le elimini.</p>
            {import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true' && <p className="mt-2 text-sm text-gray-700">Il consenso include l’invio del titolo del piatto a Pexels e di titolo, ingredienti e foto candidate a {imageProvider === 'gemini' ? 'Google Gemini' : 'OpenAI'} per cercare, valutare o generare un’immagine illustrativa delle ricette salvate. Le immagini possono richiedere tempo e sono soggette a quota.</p>}
            {import.meta.env.VITE_RECIPE_IMAGES_ENABLED === 'true' && homeConsentEnabled && (consent.imagePolicyVersion !== 'recipe-images-v1' || consent.imageProvider !== imageProvider) && <button type="button" onClick={() => void saveConsent(true)} className="ik-button-secondary mt-3 min-h-11">Conferma consenso anche per le immagini</button>}
            {consentDraft !== homeConsentEnabled && (
              <button type="button" onClick={() => void saveConsent()} disabled={isSaving} className="mt-3 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">
                {isSaving ? 'Salvataggio…' : 'Salva consenso'}
              </button>
            )}
          </div>
        </details>
      )}

      {showConsent && consent?.enabled && (
        <button type="button" onClick={() => void saveConsent(false)} disabled={isSaving} className="mt-3 min-h-11 rounded-xl border-2 border-rose-300 px-4 py-2 font-bold text-rose-900 disabled:opacity-60">
          {isSaving ? 'Salvataggio…' : 'Revoca consenso AI globale'}
        </button>
      )}

      {!settingsOnly && (homeConsentEnabled || fromTitle || fromDescription) && (
        <form className="mt-4" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
          {fromTitle && (
            <label className="mb-3 grid gap-2 text-sm font-bold text-[var(--ik-ink)]">
              Titolo del piatto
              <input type="text" value={dishTitle} onChange={(event) => setDishTitle(event.target.value)} maxLength={240} required disabled={isGenerating} placeholder="Es. Risotto ai funghi" className="ik-input min-h-12 w-full px-4 py-2 font-normal" />
            </label>
          )}
          <button type="submit" disabled={!homeConsentEnabled || isGenerating || !hasGenerationInput} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50">
            <Sparkles size={17} aria-hidden="true" />
            {isGenerating ? 'Creo la ricetta…' : 'Genera ricetta AI'}
          </button>
          {(fromTitle || fromDescription) && !homeConsentEnabled && <p className="mt-3 text-sm text-[var(--ik-ink-muted)]">Autorizza l’invio dei dati al provider AI per creare la ricetta.</p>}
          {isGenerating && <p role="status" aria-live="polite" className="mt-3 text-sm text-[var(--ik-ink-muted)]">L’AI sta preparando ingredienti e procedimento…</p>}
          {fromTitle || fromDescription || pantryLabels.length > 0
            ? <p className="mt-3 text-xs leading-relaxed text-gray-600">La ricetta generata resta un’anteprima fino alla conferma del salvataggio.</p>
            : <p className="mt-3 text-sm font-semibold text-gray-700">Aggiungi almeno un ingrediente alla dispensa per generare.</p>}
        </form>
      )}

      {drafts.length > 0 && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {drafts.map((recipe) => (
            <article key={recipe.id} data-ai-draft className="rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Anteprima — non ancora salvata</p>
              <h3 className="mt-1 text-xl font-black text-gray-950">{recipe.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-gray-700">{recipe.description}</p>
              <RecipeBody recipe={recipe} />
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => void saveDraft(recipe)} disabled={savingDraftId !== null} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60">
                  <Save size={17} aria-hidden="true" />
                  {savingDraftId === recipe.id ? 'Salvo…' : 'Salva ricetta'}
                </button>
                <button type="button" onClick={() => discardDraft(recipe.id)} disabled={savingDraftId !== null} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-emerald-200 bg-white px-4 py-2 font-bold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60">
                  <X size={17} aria-hidden="true" />
                  Scarta
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {!settingsOnly && !onRecipeProposed && !fromTitle && recipes.length > 0 && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {recipes.map((recipe) => (
            <article key={recipe.id} data-ai-recipe className="rounded-2xl border-2 border-emerald-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <RecipeImage recipeId={recipe.id} recipeTitle={recipe.title} />
                  <h3 className="text-xl font-black text-gray-950">{recipe.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-700">{recipe.description}</p>
                </div>
                <button type="button" onClick={() => remove(recipe.id)} aria-label={`Elimina ${recipe.title}`} className="rounded-xl p-2 text-gray-500 hover:bg-rose-50 hover:text-rose-700">
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
              <RecipeBody recipe={recipe} />
            </article>
          ))}
        </div>
      )}
    </section>
    {pendingDeletes.map((recipe) => (
      <UndoToast
        key={recipe.id}
        message={`Ricetta ${recipe.title} rimossa.`}
        onUndo={() => restorePendingDelete(recipe)}
        onExpire={() => { void finalizeDelete(recipe); }}
      />
    ))}
    </>
  );
}
