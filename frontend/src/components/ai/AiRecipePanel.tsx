import { useEffect, useState } from 'react';
import { LockKeyhole, Sparkles, Trash2 } from 'lucide-react';
import type { DietProfilePayload, GeneratedRecipe } from '@ikuck/shared/contracts';
import { ApiClientError } from '../../api/apiClient';
import { type AuthUser } from '../../auth/authStore';
import {
  deleteAiRecipe,
  fetchAiConsent,
  fetchAiRecipes,
  generateAiRecipe,
  updateAiConsent,
} from '../../ai/aiRecipeApi';
import { ALLERGEN_LABELS, DIET_LABELS } from '../../domain/dietary';
import UndoToast from '../feedback/UndoToast';

interface AiRecipePanelProps {
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

  if (code === 'ai_daily_limit_reached') return 'Hai raggiunto il limite di cinque ricette AI al giorno.';
  if (code === 'ai_consent_required') return 'Salva il consenso prima di generare una ricetta AI.';
  if (code === 'ai_recipe_incompatible') return 'La ricetta generata non rispetta i filtri alimentari attivi.';
  if (code === 'network_error') return 'Servizio non raggiungibile: le ricette AI restano disponibili solo online.';
  if (code === 'provider_unavailable' || code === 'provider_error') return 'Il servizio delle ricette AI non è momentaneamente disponibile.';
  return 'Non è stato possibile completare l’operazione AI. Riprova.';
};

const normalizedIngredients = (ingredients: string[]): string[] => [...new Set(
  ingredients.map((ingredient) => ingredient.trim()).filter((ingredient) => ingredient.length > 0),
)];

export default function AiRecipePanel({ ingredients, dietProfile, user, csrfToken }: AiRecipePanelProps) {
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const [consent, setConsent] = useState<{ enabled: boolean; updatedAt: string } | null>(null);
  const [consentDraft, setConsentDraft] = useState(false);
  const [recipes, setRecipes] = useState<GeneratedRecipe[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<GeneratedRecipe[]>([]);
  const pantryLabels = normalizedIngredients(ingredients);

  useEffect(() => {
    let cancelled = false;
    setConsent(null);
    setConsentDraft(false);
    setRecipes([]);
    setError(null);
    if (!verified) return undefined;

    setIsLoading(true);
    void Promise.all([fetchAiConsent(), fetchAiRecipes()])
      .then(([nextConsent, nextRecipes]) => {
        if (cancelled) return;
        setConsent(nextConsent);
        setConsentDraft(nextConsent.enabled);
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
  }, [verified, user?.id]);

  if (!verified) {
    return (
      <section aria-label="Ricette AI private" className="rounded-3xl border-2 border-violet-100 bg-violet-50/70 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-violet-700 text-white">
            <LockKeyhole size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-black text-gray-950">Ricette AI private</h2>
            <p className="mt-1 text-sm leading-relaxed text-gray-700">Le ricette AI private sono disponibili dopo la verifica dell’account. Gli ospiti possono continuare a usare il catalogo locale offline.</p>
          </div>
        </div>
      </section>
    );
  }

  const saveConsent = async () => {
    if (csrfToken === null) return;
    setIsSaving(true);
    setError(null);
    try {
      const nextConsent = await updateAiConsent(consentDraft, csrfToken);
      setConsent(nextConsent);
      setConsentDraft(nextConsent.enabled);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  };

  const generate = async () => {
    if (csrfToken === null || consent?.enabled !== true || pantryLabels.length === 0) return;
    setIsGenerating(true);
    setError(null);
    try {
      const recipe = await generateAiRecipe({ ingredients: pantryLabels, constraints: [] }, dietProfile, csrfToken);
      setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
    } catch (generationError) {
      setError(errorMessage(generationError));
    } finally {
      setIsGenerating(false);
    }
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
    <section aria-label="Ricette AI private" className="mt-6 rounded-3xl border-2 border-violet-100 bg-violet-50/70 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-violet-700 text-white">
            <Sparkles size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-xl font-black text-gray-950">Ricette AI private</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-700">Usa gli ingredienti presenti per creare un’idea personale. Il contenuto resta legato al tuo account e non entra nel catalogo pubblico.</p>
          </div>
        </div>
        {isLoading && <p role="status" className="text-sm font-semibold text-violet-900">Carico le tue ricette AI…</p>}
      </div>

      {error !== null && <p role="alert" className="mt-4 rounded-xl bg-rose-100 p-3 text-sm font-semibold text-rose-900">{error}</p>}

      {consent !== null && (
        <div className="mt-5 rounded-2xl border border-violet-200 bg-white p-4">
          <label className="flex items-start gap-3 text-sm font-semibold text-gray-800">
            <input
              type="checkbox"
              checked={consentDraft}
              onChange={(event) => setConsentDraft(event.target.checked)}
              disabled={isSaving}
              aria-label="Acconsento all’uso degli ingredienti per generare ricette AI"
              className="mt-0.5 h-5 w-5 accent-violet-700"
            />
            <span>Acconsento all’uso degli ingredienti indicati e del mio profilo alimentare per generare ricette AI.</span>
          </label>
          <p className="mt-2 text-xs leading-relaxed text-gray-600">Puoi revocare il consenso in qualsiasi momento. Le ricette già salvate restano visibili finché non le elimini.</p>
          {consentDraft !== consent.enabled && (
            <button type="button" onClick={() => void saveConsent()} disabled={isSaving} className="mt-3 min-h-11 rounded-xl bg-violet-700 px-4 py-2 font-bold text-white hover:bg-violet-800 disabled:cursor-wait disabled:opacity-60">
              {isSaving ? 'Salvataggio…' : 'Salva consenso'}
            </button>
          )}
          {consent.enabled && (
            <button type="button" onClick={() => void generate()} disabled={isGenerating || pantryLabels.length === 0} className="mt-3 ml-2 inline-flex min-h-11 items-center gap-2 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50">
              <Sparkles size={17} aria-hidden="true" />
              {isGenerating ? 'Creo la ricetta…' : 'Genera ricetta AI'}
            </button>
          )}
          {consent.enabled && pantryLabels.length === 0 && <p className="mt-3 text-sm font-semibold text-gray-700">Aggiungi almeno un ingrediente alla dispensa per generare.</p>}
        </div>
      )}

      {recipes.length > 0 && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {recipes.map((recipe) => (
            <article key={recipe.id} className="rounded-2xl border-2 border-violet-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black text-gray-950">{recipe.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-gray-700">{recipe.description}</p>
                </div>
                <button type="button" onClick={() => remove(recipe.id)} aria-label={`Elimina ${recipe.title}`} className="rounded-xl p-2 text-gray-500 hover:bg-rose-50 hover:text-rose-700">
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-violet-800">Dieta: {recipe.diets.map((diet) => DIET_LABELS[diet]).join(', ')}</p>
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
