import { useEffect, useRef, useState } from 'react';
import type { DietProfile, GeneratedRecipe } from '@ikuck/shared/contracts';
import { isSavedRecipe, type SavedRecipe } from '@ikuck/shared/dinnerDiary';
import { DIARY_SERVINGS_MAX } from '@ikuck/shared/limits';
import type { AuthUser } from '../../auth/authStore';
import type { PantryRecipe } from '../../domain/types';
import { toDiaryPantryRecipe } from '../../domain/diaryRecipes';
import { availablePlanRecipes, generatedToSavedRecipe } from '../../mealPlan/recipeLibrary';
import type { SyncScope } from '../../sync/scopeContext';
import AiRecipePanel from '../ai/AiRecipePanel';

interface Props {
  date: string;
  label: string;
  scope: SyncScope;
  currentId: string | null;
  recipes: PantryRecipe[];
  availableIds: string[];
  ready: boolean;
  loadError?: boolean;
  onReload?: () => void;
  profile: DietProfile;
  user: AuthUser | null;
  csrfToken: string | null;
  onClose: () => void;
  onConfirm: (recipe: PantryRecipe, created?: SavedRecipe) => Promise<void>;
}
const button = 'shrink-0 min-h-11 rounded-xl border border-[var(--ik-border)] px-4 py-2 font-bold hover:bg-[var(--ik-sage)] disabled:opacity-50';
const field = 'ik-input min-h-11 min-w-0 w-full rounded-xl border border-[var(--ik-border)] bg-[var(--ik-mist)] px-3 py-2 font-normal';

export default function PlanRecipeWizard(props: Props) {
  const [step, setStep] = useState<'choice' | 'alternatives' | 'create' | 'review'>('choice');
  const [selected, setSelected] = useState<PantryRecipe | null>(null);
  const [draft, setDraft] = useState<SavedRecipe | null>(null);
  const [dishDescription, setDishDescription] = useState('');
  const [servings, setServings] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, [step]);
  const alternatives = availablePlanRecipes(props.recipes, props.profile, props.availableIds, props.currentId);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      mounted.current = false;
      element?.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  const propose = (recipe: GeneratedRecipe) => {
    setDraft({ ...generatedToSavedRecipe(recipe, props.user?.id ?? null), servings });
    setSelected(null);
    setStep('review');
  };
  const confirm = async () => {
    if (lock.current) return;
    const confirmedDraft = draft ? { ...draft, title: draft.title.trim(), steps: draft.steps.map(text => text.trim()).filter(Boolean), updatedAt: new Date().toISOString() } : null;
    const recipe = confirmedDraft ? toDiaryPantryRecipe({ scope: props.scope, value: confirmedDraft }) : selected;
    if (!recipe || (confirmedDraft && !isSavedRecipe(confirmedDraft))) { setError('La proposta generata non è completa. Torna indietro e genera nuovamente la ricetta.'); return; }
    if (draft && ((!draft.diets?.includes(props.profile.diet)) || draft.allergens?.some(allergen => props.profile.excludedAllergens.includes(allergen)))) {
      setError('Le diete o gli allergeni dichiarati non rispettano il profilo alimentare attivo. Torna indietro e genera una nuova proposta.'); return;
    }
    // Pantry contents may have changed while the review was open.
    if (!draft && !availablePlanRecipes([recipe], props.profile, props.availableIds, null).length) {
      setError('Questa ricetta non è più realizzabile con la dispensa attuale. Scegli un’altra alternativa.'); return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(recipe, confirmedDraft ?? undefined);
      if (mounted.current) props.onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Salvataggio non riuscito. Riprova.');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <dialog ref={dialog} aria-labelledby="plan-wizard-title" onCancel={event => { event.preventDefault(); if (!lock.current) props.onClose(); }} className="fixed inset-0 m-0 h-dvh max-h-dvh w-full max-w-none overflow-y-auto bg-[var(--ik-surface)] p-5 text-[var(--ik-ink)] backdrop:bg-black/50 sm:m-auto sm:h-auto sm:max-h-[90dvh] sm:max-w-3xl sm:rounded-3xl sm:p-7">
    <header className="mb-5 flex items-start justify-between gap-3">
      <div><time dateTime={props.date} className="text-sm font-bold capitalize text-[var(--ik-basil-dark)]">{props.label}</time><h2 ref={titleRef} tabIndex={-1} id="plan-wizard-title" className="text-2xl font-black">Definisci la ricetta del giorno</h2><p role="status" className="mt-2 text-sm">Passo {step === 'choice' ? 1 : step === 'review' ? 3 : 2} di 3 · {step === 'review' ? 'Rivedi e conferma' : step === 'choice' ? 'Scegli come iniziare' : 'Trova la tua ricetta'}</p></div>
      <button type="button" className={`${button} whitespace-nowrap`} disabled={busy} onClick={props.onClose}>Annulla</button>
    </header>
    {props.loadError && <div role="alert" className="mb-4"><p>Non è stato possibile caricare il ricettario. Riprova prima di confermare una ricetta.</p><button type="button" className={button} onClick={props.onReload}>Ricarica ricettario</button></div>}
    {error && <p role="alert" className="mb-4 rounded-xl bg-[var(--ik-tomato-soft)] p-3">{error}</p>}
    {step === 'choice' && <div className="grid gap-4 sm:grid-cols-2">
      <button type="button" className={`${button} p-6 text-left`} onClick={() => setStep('alternatives')}><span className="block text-lg">Scegli dalla dispensa</span><span className="block text-sm font-normal">Ricette con tutti gli ingredienti obbligatori presenti.</span></button>
      <button type="button" className={`${button} p-6 text-left`} onClick={() => setStep('create')}><span className="block text-lg">Crea con AI</span><span className="block text-sm font-normal">Descrivi il piatto e indica le porzioni, poi genera la ricetta.</span></button>
    </div>}
    {step === 'alternatives' && <section aria-label="Alternative dalla dispensa">
      {!props.ready ? <p role="status">Carico dispensa e ricettario…</p> : alternatives.length === 0 ? <div><p>Nessun’altra ricetta compatibile ha tutti gli ingredienti presenti.</p><button type="button" className={`${button} mt-3`} onClick={() => setStep('create')}>Crea con AI</button></div> : <ul className="grid gap-3">{alternatives.map(recipe => <li key={recipe.id}><button type="button" className={`${button} w-full text-left`} onClick={() => { setSelected(recipe); setDraft(null); setStep('review'); }}><span className="block text-lg">{recipe.title}</span><span className="block text-sm font-normal">{recipe.description}</span></button></li>)}</ul>}
    </section>}
    {step === 'create' && <section className="grid gap-4" aria-label="Crea la ricetta">
      <p>Descrivi il piatto che vuoi preparare e per quante persone. L’AI creerà la ricetta per le porzioni indicate.</p>
      <label className="grid gap-1 font-bold">Descrizione del piatto<textarea required maxLength={240} rows={4} value={dishDescription} onChange={event => setDishDescription(event.target.value)} placeholder="Es. Un risotto cremoso ai funghi, con una nota di limone" className={field} /></label>
      <label className="grid gap-1 font-bold">Numero di porzioni<input required type="number" min={1} max={DIARY_SERVINGS_MAX} value={servings} onChange={event => setServings(Number(event.target.value))} className={field} /></label>
      <AiRecipePanel ingredients={[]} dishDescription={dishDescription} dietProfile={props.profile} user={props.user} csrfToken={props.csrfToken} generationReady={props.ready && servings >= 1 && servings <= DIARY_SERVINGS_MAX && Number.isInteger(servings)} constraints={[`Prepara ingredienti e dosi per ${servings} porzioni.`]} onRecipeProposed={propose} />
    </section>}
    {step === 'review' && <form onSubmit={event => { event.preventDefault(); void confirm(); }} className="grid gap-4">
      {draft ? <>
        <h3 className="text-xl font-bold">{draft.title}</h3>
        <p>{draft.description}</p>
        <p className="font-semibold">{draft.servings} porzioni</p>
        <p>{props.scope.startsWith('house:') ? 'La ricetta sarà salvata nel ricettario della Casa e usata per questo giorno.' : 'La ricetta sarà salvata nel tuo ricettario e usata per questo giorno.'}</p>
      </> : selected && <>
        <h3 className="text-xl font-bold">{selected.title}</h3>
        <p>{selected.description}</p>
        {selected.servings !== null && <p className="font-semibold">{selected.servings} porzioni</p>}
      </>}
      <button type="submit" className="ik-button-primary min-h-11 rounded-xl px-4 py-3 font-bold" disabled={busy || !props.ready}>{busy ? 'Salvataggio…' : draft ? 'Salva nel ricettario e usa' : 'Usa per questo giorno'}</button>
    </form>}
    {step !== 'choice' && <button type="button" className={`${button} mt-4`} disabled={busy} onClick={() => { setError(null); setStep(step === 'review' ? draft ? 'create' : 'alternatives' : 'choice'); }}>Indietro</button>}
  </dialog>;
}
