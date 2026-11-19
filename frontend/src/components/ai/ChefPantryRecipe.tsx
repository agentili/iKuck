import { useState, useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import type { GenerateRecipeCandidate, GeneratedRecipe } from '@ikuck/shared/contracts';
import { AI_RECIPE_MAX_GENERATION_INGREDIENTS } from '@ikuck/shared/limits';
import { useAuthStore } from '../../auth/authStore';
import { createAiRecipeCollectionOwner, isCurrentAiRecipeCollectionOwner, type AiRecipeCollectionOwner } from '../../ai/aiRecipeOwnership';
import { generateRecipeFromPantry, saveAiRecipe } from '../../ai/aiRecipeApi';
import { ApiClientError } from '../../api/apiClient';
import { usePantryStore } from '../../store/localPantryStore';
import { useDietProfileStore } from '../../store/dietProfileStore';
import { getExpiryStatus } from '../../domain/pantryLots';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';
import { isScopeWritable, subscribeScopeAvailability } from '../../sync/scopeWriteFence';
import { GenerateCandidatePreview } from './GenerateCandidatePreview';

const actionClass = 'ik-button-secondary min-h-11 max-w-full whitespace-normal px-4 py-2 font-bold disabled:opacity-50';
const subscribeOnline = (listener: () => void) => {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener); };
};
const getOnline = () => navigator.onLine;

export default function ChefPantryRecipe() {
  const user = useAuthStore(state => state.user);
  const csrfToken = useAuthStore(state => state.csrfToken);
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope);
  const writable = useSyncExternalStore(subscribeScopeAvailability, () => isScopeWritable(scope));
  const owner = createAiRecipeCollectionOwner(user?.id ?? null, Boolean(user?.emailVerifiedAt.trim()), csrfToken, scope);
  return <section aria-labelledby="chef-pantry-title" className="mx-4 mt-4 min-w-0 rounded-2xl border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4">
    <h2 id="chef-pantry-title" className="text-lg font-bold">Una ricetta dalla dispensa</h2>
    {owner === null ? <p className="mt-2 text-sm">Per generare con l’AI, <Link to="/profile" className="underline">accedi con un account verificato</Link>.</p>
      : !writable || scope === 'guest' ? <p className="mt-2 text-sm">La dispensa non è ancora pronta.</p>
      : <ChefPantryAction key={JSON.stringify([owner.userId, owner.scope, owner.sessionTokenIdentity])} owner={owner} />}
  </section>;
}

function ChefPantryAction({ owner }: { owner: AiRecipeCollectionOwner }) {
  const lots = usePantryStore(state => state.pantryLots);
  const pantryReady = usePantryStore(state => state.hasHydrated);
  const profile = useDietProfileStore(state => state.profile);
  const dietReady = useDietProfileStore(state => state.hasHydrated);
  const online = useSyncExternalStore(subscribeOnline, getOnline);
  const names = [...new Set(lots.filter(lot => lot.quantity !== 0 && getExpiryStatus(lot.expiresAt) !== 'expired').map(lot => lot.label.trim()).filter(Boolean))];
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [result, setResult] = useState<GenerateRecipeCandidate | null>(null);
  const [status, setStatus] = useState('');
  const [needsConsent, setNeedsConsent] = useState(false);
  const lock = useRef(false);
  const saveCandidate = useRef<GeneratedRecipe | null>(null);
  const isCurrent = () => isCurrentAiRecipeCollectionOwner(owner) && isScopeWritable(owner.scope);
  const unavailable = !online ? 'La generazione AI richiede una connessione.' : !pantryReady || !dietReady ? 'Carico dispensa e preferenze…' : names.length === 0 ? 'Aggiungi almeno un ingrediente disponibile in dispensa.' : names.length > AI_RECIPE_MAX_GENERATION_INGREDIENTS ? 'La dispensa è troppo grande per questa richiesta.' : '';

  const generate = async () => {
    if (!confirm || unavailable || lock.current || owner.scope === 'guest' || !isCurrent()) return;
    lock.current = true;
    setBusy('generate'); setConfirm(false); setStatus(''); setResult(null); setNeedsConsent(false);
    saveCandidate.current = null;
    try {
      const { diet, excludedAllergens, nutrition } = profile;
      const response = await generateRecipeFromPantry({ ingredients: names, dietProfile: { diet, excludedAllergens, nutrition }, mode: 'chef_coverage', confirmedReferences: true, syncScope: owner.scope }, owner.sessionTokenIdentity);
      if (!isCurrent()) return;
      if (response.kind === 'candidate') setResult(response);
      else setStatus(response.message);
    } catch (error) {
      if (!isCurrent()) return;
      const code = error instanceof ApiClientError ? error.code : '';
      setNeedsConsent(code === 'ai_consent_required');
      setStatus(code === 'ai_consent_required' ? 'La generazione richiede un consenso valido nel Profilo.' : code === 'ai_daily_limit_reached' ? 'Hai raggiunto il limite giornaliero di generazioni.' : 'Il servizio AI non è disponibile. Riprova più tardi.');
    } finally { lock.current = false; setBusy(null); }
  };

  const save = async () => {
    if (!result || !online || lock.current || owner.scope === 'guest' || !isCurrent()) return;
    lock.current = true; setBusy('save'); setStatus('');
    try {
      const now = new Date().toISOString();
      saveCandidate.current ??= { ...result.recipe, id: crypto.randomUUID(), source: 'ai', createdAt: now, updatedAt: now };
      await saveAiRecipe(saveCandidate.current, owner.sessionTokenIdentity, undefined, owner.scope);
      if (!isCurrent()) return;
      setResult(null); setStatus('Ricetta salvata nel ricettario.');
    } catch {
      if (isCurrent()) setStatus('Impossibile salvare la ricetta. Riprova.');
    } finally { lock.current = false; setBusy(null); }
  };

  return <div className="mt-2 grid min-w-0 justify-items-start gap-3">
    {unavailable && <p role="status" className="text-sm">{unavailable}</p>}
    {!confirm && !result && <button className={actionClass} type="button" disabled={Boolean(unavailable) || busy !== null} onClick={() => { setConfirm(true); setStatus(''); setNeedsConsent(false); }}>{busy === 'generate' ? 'Generazione in corso…' : 'Genera dalla dispensa'}</button>}
    {confirm && <div className="grid min-w-0 gap-3">
      <p className="text-sm">Al servizio AI configurato invieremo gli ingredienti della dispensa, il profilo alimentare e titoli, ingredienti e dosi delle ricette del catalogo e del ricettario attivo, comprese quelle del Diario e della Casa quando disponibili.</p>
      <div className="flex flex-wrap gap-2"><button className={actionClass} type="button" disabled={Boolean(unavailable)} onClick={() => void generate()}>Conferma e genera</button><button className={actionClass} type="button" onClick={() => setConfirm(false)}>Annulla</button></div>
    </div>}
    {status && <p role="status" className="text-sm">{status}{needsConsent && <> <Link className="underline" to="/profile#ai-consent-settings">Apri il Profilo</Link></>}</p>}
    {result && <div className="w-full min-w-0 break-words">
      <h3 className="font-bold">Anteprima ricetta</h3>
      {result.omittedIngredient && <p className="text-sm">Ingrediente non usato: {result.omittedIngredient}.</p>}
      <GenerateCandidatePreview recipe={result.recipe} ingredientReview={result.ingredientReview} onSave={() => void save()} onDiscard={() => { setResult(null); setStatus(''); }} isSaving={busy === 'save'} />
    </div>}
  </div>;
}
