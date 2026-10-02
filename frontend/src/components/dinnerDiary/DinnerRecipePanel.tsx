import { useEffect, useState, type FormEvent } from 'react';
import { Check, Link2, Plus, RotateCw, Save, Trash2, X } from 'lucide-react';
import type { DiaryRecipeDraft, DinnerEntry, SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { DIARY_DESCRIPTION_MAX_LENGTH, DIARY_INGREDIENT_AMOUNT_MAX_LENGTH, DIARY_INGREDIENT_NAME_MAX_LENGTH, DIARY_MAX_RECIPES, DIARY_MAX_STEPS, DIARY_SERVINGS_MAX, DIARY_SERVINGS_MIN, DIARY_STEP_MAX_LENGTH, DIARY_TITLE_MAX_LENGTH, RECIPE_MAX_INGREDIENTS } from '@ikuck/shared/limits';
import { ApiClientError } from '../../api/apiClient';
import { confirmDiaryRecipe, linkDiaryRecipe, reconstructDinnerRecipes } from '../../diary/dinnerDiaryApi';
import { useDinnerDiaryStore, type Scoped } from '../../store/dinnerDiaryStore';

interface DinnerRecipePanelProps {
  entry: Scoped<DinnerEntry>;
  availableRecipes: Scoped<SavedRecipe>[];
  manageable: boolean;
  verified: boolean;
  consentEnabled: boolean;
  csrfToken: string | null;
}

const errorMessage = (error: unknown, operation: 'generate' | 'confirm' | 'link'): string => {
  const code = error instanceof ApiClientError ? error.code : '';
  if (code === 'ai_consent_required') return 'Salva il consenso all’uso dell’AI prima di preparare le bozze.';
  if (code === 'ai_daily_limit_reached') return 'Hai raggiunto il limite giornaliero di ricostruzioni AI.';
  if (code === 'provider_unavailable' || code === 'provider_error') return 'Il servizio di ricostruzione delle ricette non è disponibile in questo momento. La cena è salvata; puoi riprovare più tardi.';
  if (code === 'network_error') return 'Non riesco a raggiungere il servizio. La cena resta salvata e la bozza non viene persa.';
  if (operation === 'confirm') return 'Non è stato possibile confermare la ricetta. La bozza resta conservata e puoi riprovare.';
  if (operation === 'link') return 'Non è stato possibile collegare la ricetta. La cena resta invariata.';
  return 'Non è stato possibile preparare le bozze. La cena resta salvata; puoi riprovare.';
};

export default function DinnerRecipePanel({ entry, availableRecipes, manageable, verified, consentEnabled, csrfToken }: DinnerRecipePanelProps) {
  const { scope, value: dinner } = entry;
  const draftSet = useDinnerDiaryStore((state) => state.drafts.find(item => item.scope === scope && item.value.entryId === dinner.id));
  const saveDraftSet = useDinnerDiaryStore((state) => state.saveDraftSet);
  const clearDraftSet = useDinnerDiaryStore((state) => state.clearDraftSet);
  const acceptConfirmedRecipe = useDinnerDiaryStore((state) => state.acceptConfirmedRecipe);
  const acceptLinkedEntry = useDinnerDiaryStore((state) => state.acceptLinkedEntry);
  const [drafts, setDrafts] = useState<DiaryRecipeDraft[]>(draftSet?.value.drafts ?? []);
  const [isGenerating, setIsGenerating] = useState(false);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDrafts(draftSet?.value.drafts ?? []), [draftSet]);

  const persistDrafts = (nextDrafts: DiaryRecipeDraft[]): boolean => {
    if (nextDrafts.length === 0) return clearDraftSet(scope, dinner.id) || drafts.length === 0;
    return saveDraftSet(scope, { entryId: dinner.id, entryUpdatedAt: dinner.updatedAt, drafts: nextDrafts });
  };

  const generate = async () => {
    if (!manageable || !verified || !consentEnabled || csrfToken === null || isGenerating || drafts.length >= DIARY_MAX_RECIPES) return;
    setIsGenerating(true);
    setError(null);
    try {
      const generated = await reconstructDinnerRecipes({ dinnerText: dinner.text, servings: dinner.servings }, csrfToken);
      const known = new Set(drafts.map(draft => draft.draftId));
      const next = [...drafts, ...generated.filter(draft => !known.has(draft.draftId))].slice(0, DIARY_MAX_RECIPES);
      if (next.length === drafts.length) {
        setError('Non ho trovato nuove proposte per questa cena. Puoi riprovare o collegare una ricetta esistente.');
        return;
      }
      if (!persistDrafts(next)) {
        setError('La cena è cambiata mentre preparavo le bozze. Aggiorna il diario e riprova.');
        return;
      }
      setDrafts(next);
    } catch (generationError) {
      setError(errorMessage(generationError, 'generate'));
    } finally {
      setIsGenerating(false);
    }
  };

  const updateDraft = (draftId: string, transform: (draft: DiaryRecipeDraft) => DiaryRecipeDraft) => {
    setDrafts(current => current.map(draft => draft.draftId === draftId ? transform(draft) : draft));
  };

  const saveDraft = () => {
    setError(null);
    if (!persistDrafts(drafts)) setError('Non è stato possibile conservare le modifiche alla bozza. Verifica i campi e riprova.');
    else setError(null);
  };

  const confirmDraft = async (event: FormEvent<HTMLFormElement>, draftId: string) => {
    event.preventDefault();
    const draft = drafts.find(item => item.draftId === draftId);
    if (!draft || !manageable || !verified || csrfToken === null || busyDraftId !== null) return;
    if (!persistDrafts(drafts)) {
      setError('Controlla il titolo, gli ingredienti e i passaggi: la bozza non è valida oppure la cena è cambiata.');
      return;
    }
    setBusyDraftId(draftId);
    setError(null);
    try {
      const result = await confirmDiaryRecipe(dinner.id, draft, csrfToken);
      if (!acceptConfirmedRecipe(scope, result.entry, result.recipe, draftId)) {
        setError('La ricetta è stata confermata dal server, ma il diario locale è cambiato. Risincronizza per vedere il collegamento.');
        return;
      }
      setDrafts(current => current.filter(item => item.draftId !== draftId));
    } catch (confirmationError) {
      setError(errorMessage(confirmationError, 'confirm'));
    } finally {
      setBusyDraftId(null);
    }
  };

  const discardDraft = (draftId: string) => {
    const next = drafts.filter(item => item.draftId !== draftId);
    if (!persistDrafts(next)) {
      setError('Non è stato possibile scartare la bozza.');
      return;
    }
    setDrafts(next);
    setError(null);
  };

  const linkExistingRecipe = async () => {
    if (!manageable || !verified || csrfToken === null || selectedRecipeId === '' || isLinking) return;
    setIsLinking(true);
    setError(null);
    try {
      const updatedEntry = await linkDiaryRecipe(dinner.id, { recipeId: selectedRecipeId, source: 'diary' }, csrfToken);
      if (!acceptLinkedEntry(scope, updatedEntry, selectedRecipeId, 'diary')) {
        setError('La ricetta è collegata sul server, ma il diario locale è cambiato. Risincronizza per aggiornare la voce.');
        return;
      }
      setSelectedRecipeId('');
    } catch (linkError) {
      setError(errorMessage(linkError, 'link'));
    } finally {
      setIsLinking(false);
    }
  };

  if (!manageable) return null;

  return (
    <section aria-label={`Ricette della cena del ${dinner.date}`} className="mt-4 border-t border-gray-200 pt-4">
      {error !== null && <p role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-900">{error}</p>}
      {verified && consentEnabled ? (
        <button type="button" onClick={() => void generate()} disabled={isGenerating || drafts.length >= DIARY_MAX_RECIPES} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:cursor-wait disabled:opacity-60">
          <RotateCw size={17} aria-hidden="true" />
          {isGenerating ? 'Preparo le bozze…' : 'Prepara bozze ricetta'}
        </button>
      ) : verified ? (
        <p className="text-sm text-gray-700">Per preparare una bozza, attiva il consenso AI qui sopra.</p>
      ) : (
        <p className="text-sm text-gray-700">La ricostruzione AI richiede un account verificato e il consenso esplicito.</p>
      )}
      {drafts.length > 0 && <p className="mt-2 text-xs leading-relaxed text-gray-600">Bozze solo tue su questo dispositivo finché non confermi. Gli ingredienti e i dettagli proposti dall’AI vanno verificati.</p>}

      {drafts.map((draft, draftIndex) => (
        <article key={draft.draftId} className="mt-4 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-900">Bozza {draftIndex + 1} — non ancora salvata come ricetta</p>
              {draft.suggestedFields.length > 0 && <p className="mt-1 text-xs text-gray-700">Controlla con attenzione i dettagli ricostruiti o proposti dall’AI.</p>}
            </div>
            <button type="button" onClick={() => discardDraft(draft.draftId)} disabled={busyDraftId !== null} aria-label={`Scarta bozza ${draft.title}`} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-800 disabled:opacity-50">
              <X size={15} aria-hidden="true" /> Scarta
            </button>
          </div>
          <form className="mt-4 space-y-4" onSubmit={(event) => void confirmDraft(event, draft.draftId)}>
            <label className="block text-sm font-bold text-gray-800">
              Titolo
              <input required maxLength={DIARY_TITLE_MAX_LENGTH} value={draft.title} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, title: event.target.value }))} aria-label="Titolo ricetta" className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-300 bg-white px-3 py-2 text-base font-normal text-gray-950 focus:border-emerald-700 focus:outline-none" />
            </label>
            <h3 className="text-xl font-black text-gray-950">{draft.title}</h3>
            <label className="block text-sm font-bold text-gray-800">
              Descrizione
              <textarea maxLength={DIARY_DESCRIPTION_MAX_LENGTH} rows={2} value={draft.description} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, description: event.target.value }))} aria-label="Descrizione ricetta" className="mt-1 min-h-20 w-full rounded-xl border-2 border-gray-300 bg-white px-3 py-2 text-base font-normal text-gray-950 focus:border-emerald-700 focus:outline-none" />
            </label>
            <label className="block max-w-xs text-sm font-bold text-gray-800">
              Porzioni
              <input type="number" min={DIARY_SERVINGS_MIN} max={DIARY_SERVINGS_MAX} value={draft.servings ?? ''} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, servings: event.target.value === '' ? null : Number(event.target.value) }))} aria-label="Porzioni ricetta" className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-300 bg-white px-3 py-2 text-base font-normal text-gray-950 focus:border-emerald-700 focus:outline-none" />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-bold text-gray-800">Ingredienti</legend>
              {draft.ingredients.map((ingredient, index) => (
                <div key={`${draft.draftId}-ingredient-${index}`} className="grid gap-2 rounded-xl bg-white p-3 sm:grid-cols-[1fr_10rem_auto_auto] sm:items-end">
                  <label className="block text-xs font-semibold text-gray-700">Ingrediente
                    <input required maxLength={DIARY_INGREDIENT_NAME_MAX_LENGTH} value={ingredient.name} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, ingredients: value.ingredients.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value, ingredientId: item.name === event.target.value ? item.ingredientId : null } : item) }))} aria-label={`Ingrediente ${index + 1} nome`} className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-base font-normal text-gray-950" />
                  </label>
                  <label className="block text-xs font-semibold text-gray-700">Quantità
                    <input maxLength={DIARY_INGREDIENT_AMOUNT_MAX_LENGTH} value={ingredient.amount} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, ingredients: value.ingredients.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item) }))} aria-label={`Ingrediente ${index + 1} quantità`} className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-base font-normal text-gray-950" />
                  </label>
                  <label className="flex min-h-10 items-center gap-1 text-xs text-gray-700"><input type="checkbox" checked={ingredient.optional} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, ingredients: value.ingredients.map((item, itemIndex) => itemIndex === index ? { ...item, optional: event.target.checked } : item) }))} aria-label={`Ingrediente ${index + 1} facoltativo`} /> Facoltativo</label>
                  <button type="button" disabled={draft.ingredients.length <= 1} onClick={() => updateDraft(draft.draftId, value => ({ ...value, ingredients: value.ingredients.filter((_, itemIndex) => itemIndex !== index) }))} aria-label={`Rimuovi ingrediente ${index + 1}`} className="min-h-10 rounded-lg border border-gray-300 px-2 text-sm font-semibold text-gray-700 disabled:opacity-40"><Trash2 size={16} aria-hidden="true" /></button>
                </div>
              ))}
              <button type="button" disabled={draft.ingredients.length >= RECIPE_MAX_INGREDIENTS} onClick={() => updateDraft(draft.draftId, value => ({ ...value, ingredients: [...value.ingredients, { name: '', amount: '', ingredientId: null, optional: false, provenance: 'suggested' }] }))} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-900 disabled:opacity-50"><Plus size={16} aria-hidden="true" /> Aggiungi ingrediente</button>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-bold text-gray-800">Procedimento</legend>
              {draft.steps.map((step, index) => (
                <div key={`${draft.draftId}-step-${index}`} className="flex gap-2">
                  <label className="min-w-0 flex-1 text-xs font-semibold text-gray-700">Passaggio {index + 1}
                    <textarea required maxLength={DIARY_STEP_MAX_LENGTH} rows={2} value={step} onChange={(event) => updateDraft(draft.draftId, value => ({ ...value, steps: value.steps.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} aria-label={`Passaggio ${index + 1}`} className="mt-1 min-h-16 w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-base font-normal text-gray-950" />
                  </label>
                  <button type="button" disabled={draft.steps.length <= 1} onClick={() => updateDraft(draft.draftId, value => ({ ...value, steps: value.steps.filter((_, itemIndex) => itemIndex !== index) }))} aria-label={`Rimuovi passaggio ${index + 1}`} className="mt-5 min-h-10 self-start rounded-lg border border-gray-300 px-2 text-sm font-semibold text-gray-700 disabled:opacity-40"><Trash2 size={16} aria-hidden="true" /></button>
                </div>
              ))}
              <button type="button" disabled={draft.steps.length >= DIARY_MAX_STEPS} onClick={() => updateDraft(draft.draftId, value => ({ ...value, steps: [...value.steps, ''] }))} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-900 disabled:opacity-50"><Plus size={16} aria-hidden="true" /> Aggiungi passaggio</button>
            </fieldset>

            {(draft.diets === null || draft.allergens === null) && <p className="text-xs leading-relaxed text-gray-700">La compatibilità alimentare non è stata verificata: non usare questa bozza per escludere allergeni o ingredienti.</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={saveDraft} disabled={busyDraftId !== null} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-emerald-300 bg-white px-4 py-2 font-bold text-emerald-950 disabled:opacity-50"><Save size={17} aria-hidden="true" /> Salva modifiche bozza</button>
              <button type="submit" disabled={!verified || csrfToken === null || busyDraftId !== null} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"><Check size={17} aria-hidden="true" /> {busyDraftId === draft.draftId ? 'Confermo…' : 'Conferma questa ricetta'}</button>
            </div>
          </form>
        </article>
      ))}

      {availableRecipes.length > 0 && (
        <div className="mt-4 rounded-xl bg-gray-50 p-3">
          <label className="block text-sm font-bold text-gray-800">Collega una ricetta già salvata
            <select value={selectedRecipeId} onChange={(event) => setSelectedRecipeId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border-2 border-gray-300 bg-white px-3 text-base font-normal">
              <option value="">Scegli una ricetta</option>
              {availableRecipes.map(recipe => <option key={recipe.value.id} value={recipe.value.id}>{recipe.value.title}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void linkExistingRecipe()} disabled={!verified || csrfToken === null || selectedRecipeId === '' || isLinking} className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-bold text-emerald-900 disabled:opacity-50"><Link2 size={15} aria-hidden="true" /> {isLinking ? 'Collego…' : 'Collega ricetta'}</button>
        </div>
      )}
    </section>
  );
}
