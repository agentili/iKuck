import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, CalendarDays, Check, Pencil, Save, Trash2, X } from 'lucide-react';
import type { AiConsent, AiRecipeProvider } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import { DIARY_NOTE_MAX_LENGTH, DIARY_SERVINGS_MAX, DIARY_SERVINGS_MIN, DIARY_TEXT_MAX_LENGTH } from '@ikuck/shared/limits';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { fetchAiConsentStatus, updateAiConsent, updateDinnerAiConsent } from '../ai/aiRecipeApi';
import { clearAiRecipeProposalHistory } from '../ai/aiRecipeHistory';
import DinnerRecipePanel from '../components/dinnerDiary/DinnerRecipePanel';
import { useHouseStore } from '../house/houseStore';
import { getActiveDataScope } from '../sync/scopeContext';
import { hydrateDinnerDiaryStore, useDinnerDiaryStore, type Scoped } from '../store/dinnerDiaryStore';

const canManageEntry = (entry: Scoped<DinnerEntry>, userId: string | null, houseId: string | null, houseRole: string | null): boolean => {
  if (entry.scope !== getActiveDataScope()) return false;
  if (entry.scope === 'guest') return true;
  if (userId === null) return false;
  if (entry.scope === `account:${userId}`) return true;
  return houseId !== null && houseRole !== null && entry.scope === `house:${houseId}`;
};

const formatDinnerDate = (date: string): string => new Intl.DateTimeFormat('it-IT', { dateStyle: 'long' }).format(new Date(`${date}T12:00:00`));

export default function DinnerDiaryPage() {
  const hasHydrated = useDinnerDiaryStore((state) => state.hasHydrated);
  const entries = useDinnerDiaryStore((state) => state.entries);
  const storeError = useDinnerDiaryStore((state) => state.error);
  const createEntry = useDinnerDiaryStore((state) => state.createEntry);
  const updateEntry = useDinnerDiaryStore((state) => state.updateEntry);
  const deleteEntry = useDinnerDiaryStore((state) => state.deleteEntry);
  const localDate = useDinnerDiaryStore((state) => state.localDate);
  const user = useAuthStore((state) => state.user);
  const userId = user?.id ?? null;
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const verified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const houseState = useHouseStore((state) => state.state);
  const houseId = houseState?.house?.id ?? null;
  const houseRole = houseState?.membership?.role ?? null;
  const savedRecipes = useDinnerDiaryStore((state) => state.recipes);
  const [consent, setConsent] = useState<AiConsent | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AiRecipeProvider | null>(null);
  const [consentDraft, setConsentDraft] = useState(false);
  const [dinnerConsentDraft, setDinnerConsentDraft] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [date, setDate] = useState(() => localDate());
  const [text, setText] = useState('');
  const [servings, setServings] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<Scoped<DinnerEntry> | null>(null);

  useEffect(() => {
    void hydrateDinnerDiaryStore();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setConsent(null);
    setSelectedProvider(null);
    setConsentDraft(false);
    setDinnerConsentDraft(false);
    setConsentError(null);
    if (!verified || userId === null) return undefined;
    setConsentLoading(true);
    void fetchAiConsentStatus()
      .then((status) => {
        if (cancelled) return;
        setConsent(status.consent);
        setSelectedProvider(status.selectedProvider);
        setConsentDraft(status.consent.enabled && status.consent.homeProvider === status.selectedProvider);
        setDinnerConsentDraft(status.consent.enabled && status.consent.dinnerProvider === status.selectedProvider);
      })
      .catch(() => {
        if (!cancelled) setConsentError('Non è stato possibile verificare il consenso AI. La generazione resta disattivata.');
      })
      .finally(() => {
        if (!cancelled) setConsentLoading(false);
      });
    return () => { cancelled = true; };
  }, [verified, userId]);

  const orderedEntries = useMemo(() => entries.filter((entry) => entry.scope === getActiveDataScope()).sort((left, right) => (
    right.value.date.localeCompare(left.value.date)
    || right.value.createdAt.localeCompare(left.value.createdAt)
  )), [entries]);

  const dinnerProviderName = selectedProvider === 'openai'
    ? 'OpenAI'
    : selectedProvider === 'gemini' ? 'Gemini di Google' : null;
  const homeConsentEnabled = consent?.enabled === true
    && selectedProvider !== null
    && consent.homeProvider === selectedProvider;
  const dinnerConsentEnabled = consent?.enabled === true
    && selectedProvider !== null
    && consent.dinnerProvider === selectedProvider;

  const refreshConsentState = async (): Promise<void> => {
    const status = await fetchAiConsentStatus();
    setConsent(status.consent);
    setSelectedProvider(status.selectedProvider);
    setConsentDraft(status.consent.enabled && status.consent.homeProvider === status.selectedProvider);
    setDinnerConsentDraft(status.consent.enabled && status.consent.dinnerProvider === status.selectedProvider);
  };

  const resetForm = () => {
    setDate(localDate());
    setText('');
    setServings('');
    setNote('');
    setEditingEntry(null);
    setFormError(null);
  };

  const saveConsent = async (enabled = consentDraft) => {
    if (csrfToken === null || consent === null || userId === null || (enabled && selectedProvider === null) || consentSaving) return;
    setConsentSaving(true);
    setConsentError(null);
    try {
      const updated = await updateAiConsent(
        enabled,
        csrfToken,
        consent.updatedAt,
        undefined,
        enabled ? selectedProvider ?? undefined : undefined,
      );
      setConsent(updated);
      setConsentDraft(updated.enabled && selectedProvider !== null && updated.homeProvider === selectedProvider);
      if (!updated.enabled) {
        setDinnerConsentDraft(false);
        const cleared = await clearAiRecipeProposalHistory(userId);
        if (!cleared) setConsentError('Consenso revocato, ma non è stato possibile sincronizzare la revoca della cronologia tra schede. Chiudi le altre schede e ricarica la pagina.');
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'ai_consent_revision_conflict') {
        try {
          await refreshConsentState();
          setConsentError('Il consenso è cambiato in un’altra scheda. Ho aggiornato lo stato: verifica la scelta prima di salvare di nuovo.');
        } catch {
          setConsentError('Il consenso è cambiato in un’altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
        }
      } else {
        setConsentError('Non è stato possibile salvare il consenso AI. Riprova.');
      }
    } finally {
      setConsentSaving(false);
    }
  };

  const saveDinnerConsent = async (provider: AiRecipeProvider | null = dinnerConsentDraft && selectedProvider !== null ? selectedProvider : null) => {
    if (csrfToken === null || consent === null || (provider !== null && selectedProvider === null) || !consent.enabled || consentSaving) return;
    setConsentSaving(true);
    setConsentError(null);
    try {
      const updated = await updateDinnerAiConsent(
        provider,
        csrfToken,
        provider === null ? undefined : consent.updatedAt,
      );
      setConsent(updated.consent);
      setSelectedProvider(updated.selectedProvider);
      setDinnerConsentDraft(updated.consent.enabled && updated.consent.dinnerProvider === updated.selectedProvider);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'ai_consent_revision_conflict') {
        try {
          await refreshConsentState();
          setConsentError('Il consenso è cambiato in un’altra scheda. Ho aggiornato lo stato: verifica la scelta prima di salvare di nuovo.');
        } catch {
          setConsentError('Il consenso è cambiato in un’altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
        }
      } else {
        setConsentError('Non è stato possibile salvare il consenso per il provider AI selezionato. Aggiorna la pagina e riprova.');
      }
    } finally {
      setConsentSaving(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (text.trim().length === 0) {
      setFormError('Scrivi cosa avete mangiato prima di salvare.');
      return;
    }
    const numericServings = servings === '' ? null : Number(servings);
    if (numericServings !== null && (!Number.isInteger(numericServings) || numericServings < DIARY_SERVINGS_MIN || numericServings > DIARY_SERVINGS_MAX)) {
      setFormError(`Le porzioni devono essere tra ${DIARY_SERVINGS_MIN} e ${DIARY_SERVINGS_MAX}.`);
      return;
    }
    if (text.length > DIARY_TEXT_MAX_LENGTH || note.length > DIARY_NOTE_MAX_LENGTH) {
      setFormError('La descrizione o la nota supera la lunghezza consentita.');
      return;
    }
    if (editingEntry !== null) {
      if (!updateEntry(editingEntry.scope, editingEntry.value.id, { date, text, servings: numericServings, note: note.trim() === '' ? null : note })) {
        setFormError('Non è stato possibile aggiornare la cena. Potresti non avere i permessi necessari.');
        return;
      }
    } else if (createEntry({ date, text, servings: numericServings, note: note.trim() === '' ? null : note }) === null) {
      setFormError('Non è stato possibile salvare la cena. Controlla i dati inseriti.');
      return;
    }
    resetForm();
  };

  const edit = (entry: Scoped<DinnerEntry>) => {
    setEditingEntry(entry);
    setDate(entry.value.date);
    setText(entry.value.text);
    setServings(entry.value.servings === null ? '' : String(entry.value.servings));
    setNote(entry.value.note ?? '');
    setFormError(null);
    document.getElementById('dinner-text')?.focus();
  };

  const remove = (entry: Scoped<DinnerEntry>) => {
    if (!window.confirm(`Eliminare la cena del ${formatDinnerDate(entry.value.date)}?`)) return;
    if (!deleteEntry(entry.scope, entry.value.id)) setFormError('Non è stato possibile eliminare la cena. Potresti non avere i permessi necessari.');
    if (editingEntry?.value.id === entry.value.id && editingEntry.scope === entry.scope) resetForm();
  };

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">Caricamento del diario…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto min-h-screen w-full max-w-4xl px-4 pb-24 pt-6 sm:px-6 sm:pb-10 sm:pt-8 lg:px-8">
      <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50">
        <ArrowLeft size={18} aria-hidden="true" /> Torna alle ricette
      </Link>
      <header className="mt-5 max-w-2xl">
        <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">La memoria della tavola</p>
        <h1 className="mt-1 text-4xl font-black leading-tight text-gray-950 sm:text-5xl">Diario delle cene</h1>
        <p className="mt-3 text-base leading-relaxed text-gray-700">Segna cosa avete mangiato, senza modificare la dispensa. Potrai ricostruire una ricetta in un secondo momento.</p>
      </header>

      <section aria-label="Consenso per ricostruire ricette" className="mt-6 rounded-2xl border-2 border-emerald-100 bg-emerald-50/70 p-4 sm:p-5">
        <h2 className="text-xl font-black text-gray-950">Ricostruisci una ricetta con l’AI</h2>
        {verified ? (
          <>
            {dinnerProviderName !== null ? (
              <>
                <p className="mt-1 text-sm leading-relaxed text-gray-700">
                  La ricostruzione invia esclusivamente a <strong>{dinnerProviderName}</strong> il testo originale della cena e le porzioni indicate; se le porzioni non sono indicate, non viene inviato un numero. Non invia la nota, gli ingredienti della dispensa, il profilo alimentare o le ricette AI. Le bozze restano modificabili e conservate solo su questo dispositivo finché non le confermi o le scarti; non vengono salvate sul server come ricette.
                </p>
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  Per Home soltanto, inviamo a {dinnerProviderName} i nomi degli ingredienti della dispensa; il profilo alimentare (dieta scelta, allergeni esclusi, calorie massime e proteine minime per porzione); e i titoli e nomi/quantità degli ingredienti delle ricette AI salvate o già proposte. Home invia anche l’elenco dei vincoli di generazione, attualmente vuoto. Questi dati non sono inviati dalla ricostruzione Dinner.
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm leading-relaxed text-gray-700">Non è stato possibile verificare il provider AI attivo. La ricostruzione resta disattivata e il testo della cena non viene inviato.</p>
            )}
            {consentLoading ? <p role="status" className="mt-3 text-sm font-semibold text-gray-700">Verifico il consenso AI…</p> : consent !== null ? (
              <>
                {selectedProvider !== null && dinnerProviderName !== null ? (
                  <>
                    <label className="mt-3 flex items-start gap-3 text-sm font-semibold text-gray-800">
                      <input type="checkbox" checked={consentDraft} onChange={(event) => setConsentDraft(event.target.checked)} disabled={consentSaving} aria-label={`Acconsento all’invio a ${dinnerProviderName} degli ingredienti della dispensa, del profilo alimentare e dei titoli e ingredienti delle ricette AI salvate o proposte`} className="mt-0.5 h-5 w-5 accent-emerald-700" />
                      <span>Acconsento all’invio a {dinnerProviderName} di ingredienti della dispensa, profilo alimentare e dati delle ricette AI per Home. Questo consenso resta personale; disattivando il consenso generale qui, si revocano anche i permessi Dinner.</span>
                    </label>
                    {consent.enabled && !homeConsentEnabled && <p className="mt-2 text-xs font-semibold leading-relaxed text-amber-900">Il provider è cambiato o il consenso precedente non specificava il destinatario: il consenso Home non autorizza {dinnerProviderName} finché non approvi esplicitamente questa scelta.</p>}
                    {consentDraft !== homeConsentEnabled && <button type="button" onClick={() => void saveConsent()} disabled={consentSaving} className="mt-3 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white disabled:opacity-60">{consentSaving ? 'Salvo…' : 'Salva consenso AI globale'}</button>}
                    <label className="mt-3 flex items-start gap-3 text-sm font-semibold text-gray-800">
                      <input
                        type="checkbox"
                        checked={dinnerConsentDraft}
                        onChange={(event) => setDinnerConsentDraft(event.target.checked)}
                        disabled={consentSaving || !consent.enabled}
                        aria-label={`Acconsento all’invio a ${dinnerProviderName} del testo della cena e delle porzioni`}
                        className="mt-0.5 h-5 w-5 accent-emerald-700"
                      />
                      <span>Acconsento a inviare a {dinnerProviderName} il testo originale della cena e le porzioni indicate per preparare bozze che restano solo su questo dispositivo finché non le confermi o le scarti; non sono salvate sul server come ricette.</span>
                    </label>
                    {!consent.enabled && <p className="mt-2 text-sm text-gray-700">Per usare Dinner, attiva prima il consenso AI generale e salva la scelta.</p>}
                    {dinnerConsentDraft !== dinnerConsentEnabled && consent.enabled && <button type="button" onClick={() => void saveDinnerConsent()} disabled={consentSaving} className="mt-3 min-h-11 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white disabled:opacity-60">{consentSaving ? 'Salvo…' : 'Salva consenso Dinner'}</button>}
                    {consent.enabled && consent.dinnerProvider !== undefined && <button type="button" onClick={() => void saveDinnerConsent(null)} disabled={consentSaving} className="mt-3 ml-2 min-h-11 rounded-xl border-2 border-rose-300 px-4 py-2 font-bold text-rose-900 disabled:opacity-60">{consentSaving ? 'Salvataggio…' : 'Revoca consenso Dinner'}</button>}
                  </>
                ) : <p role="status" className="mt-3 text-sm text-gray-700">Il consenso non è disponibile; la generazione resta disattivata.</p>}
                {consent.enabled && <button type="button" onClick={() => void saveConsent(false)} disabled={consentSaving} className="mt-3 min-h-11 rounded-xl border-2 border-rose-300 px-4 py-2 font-bold text-rose-900 disabled:opacity-60">{consentSaving ? 'Salvataggio…' : 'Revoca consenso AI globale'}</button>}
              </>
            ) : <p role="status" className="mt-3 text-sm text-gray-700">Il consenso non è disponibile; la generazione resta disattivata.</p>}
          </>
        ) : user === null ? (
          <p className="mt-3 text-sm text-gray-700">Come ospite, le cene restano sul dispositivo: non inviamo testo, porzioni o note a un servizio AI. La ricostruzione è disponibile solo con un account verificato; vedrai il provider attivo e potrai dare un consenso esplicito prima dell’invio.</p>
        ) : (
          <p className="mt-3 text-sm text-gray-700">Con un account non verificato, la ricostruzione AI è disattivata: il testo della cena, le porzioni e le note non vengono inviati a un provider AI. Verifica l’account per vedere il provider attivo e decidere se consentire la ricostruzione.</p>
        )}
        {consentError !== null && <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-900">{consentError}</p>}
      </section>

      <section aria-labelledby="dinner-entry-form-title" className="mt-6 rounded-3xl border-2 border-emerald-100 bg-white p-4 shadow-sm sm:p-6">
        <h2 id="dinner-entry-form-title" className="text-2xl font-black text-gray-950">{editingEntry === null ? 'Registra una cena' : 'Modifica la cena'}</h2>
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <label className="block text-sm font-bold text-gray-800" htmlFor="dinner-date">
              Data della cena
              <span className="mt-1 flex min-h-11 items-center gap-2 rounded-xl border-2 border-gray-300 bg-white px-3 focus-within:border-emerald-700">
                <CalendarDays size={18} aria-hidden="true" className="shrink-0 text-gray-500" />
                <input id="dinner-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-base text-gray-950 outline-none" />
              </span>
            </label>
            <label className="block text-sm font-bold text-gray-800" htmlFor="dinner-servings">
              Porzioni <span className="font-normal text-gray-500">(facoltative)</span>
              <input id="dinner-servings" type="number" inputMode="numeric" min={DIARY_SERVINGS_MIN} max={DIARY_SERVINGS_MAX} value={servings} onChange={(event) => setServings(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-300 px-3 py-2 text-base text-gray-950 focus:border-emerald-700 focus:outline-none" />
            </label>
          </div>
          <label className="block text-sm font-bold text-gray-800" htmlFor="dinner-text">
            Com’è andata la cena?
            <textarea id="dinner-text" required maxLength={DIARY_TEXT_MAX_LENGTH} rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="Per esempio: pasta con zucchine, poi insalata con pomodorini e feta." className="mt-1 min-h-28 w-full resize-y rounded-xl border-2 border-gray-300 px-3 py-2 text-base font-normal leading-relaxed text-gray-950 focus:border-emerald-700 focus:outline-none" />
            <span className="mt-1 block text-right text-xs font-medium text-gray-500">{text.length}/{DIARY_TEXT_MAX_LENGTH}</span>
          </label>
          <label className="block text-sm font-bold text-gray-800" htmlFor="dinner-note">
            Nota <span className="font-normal text-gray-500">(facoltativa)</span>
            <textarea id="dinner-note" maxLength={DIARY_NOTE_MAX_LENGTH} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Un dettaglio da ricordare" className="mt-1 min-h-20 w-full resize-y rounded-xl border-2 border-gray-300 px-3 py-2 text-base font-normal leading-relaxed text-gray-950 focus:border-emerald-700 focus:outline-none" />
          </label>
          {formError !== null && <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-900">{formError}</p>}
          {storeError !== null && <p role="status" className="text-sm text-amber-900">Alcune modifiche potrebbero non essersi sincronizzate. Riprova quando sei online.</p>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="ik-button-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2 font-bold">
              {editingEntry === null ? <Check size={18} aria-hidden="true" /> : <Save size={18} aria-hidden="true" />}
              {editingEntry === null ? 'Salva cena' : 'Salva modifiche'}
            </button>
            {editingEntry !== null && (
              <button type="button" onClick={resetForm} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border-2 border-gray-300 px-4 py-2 font-semibold text-gray-800 hover:bg-gray-50">
                <X size={17} aria-hidden="true" /> Annulla modifica
              </button>
            )}
          </div>
        </form>
      </section>

      <section aria-labelledby="dinner-history-title" className="mt-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-800">Il tuo archivio</p>
            <h2 id="dinner-history-title" className="mt-1 text-3xl font-black text-gray-950">Le tue cene</h2>
          </div>
          <p className="text-sm font-semibold text-gray-600">{orderedEntries.length} {orderedEntries.length === 1 ? 'cena' : 'cene'}</p>
        </div>
        {orderedEntries.length === 0 ? (
          <p className="rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-gray-700">Non hai ancora registrato una cena.</p>
        ) : (
          <ol className="space-y-3">
            {orderedEntries.map((entry) => {
              const manageable = canManageEntry(entry, userId, houseId, houseRole);
              const linkedRecipeIds = new Set(entry.value.recipes.map((recipe) => recipe.recipeId));
              const availableRecipes = savedRecipes.filter((recipe) => recipe.scope === entry.scope && !linkedRecipeIds.has(recipe.value.id));
              return (
                <li key={`${entry.scope}:${entry.value.id}`}>
                  <article className="rounded-2xl border-2 border-gray-200 bg-white p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-emerald-800">{formatDinnerDate(entry.value.date)}</p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-gray-900">{entry.value.text}</p>
                        {entry.value.note !== null && <p className="mt-2 text-sm text-gray-700">Nota: {entry.value.note}</p>}
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">{entry.scope.startsWith('house:') ? 'Condivisa con la Casa' : 'Personale'}</span>
                          {entry.value.servings !== null && <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">{entry.value.servings} {entry.value.servings === 1 ? 'porzione' : 'porzioni'}</span>}
                          <span className={`rounded-full px-2.5 py-1 ${entry.value.recipes.length === 0 ? 'bg-amber-100 text-amber-950' : 'bg-emerald-100 text-emerald-950'}`}>
                            {entry.value.recipes.length === 0 ? 'Da completare' : `${entry.value.recipes.length} ${entry.value.recipes.length === 1 ? 'ricetta collegata' : 'ricette collegate'}`}
                          </span>
                        </div>
                        {entry.value.recipes.length > 0 && <ul className="mt-2 list-inside list-disc text-sm text-gray-700">{entry.value.recipes.map((recipe) => <li key={recipe.recipeId}>{recipe.title}</li>)}</ul>}
                      </div>
                      {manageable && (
                        <div className="flex shrink-0 gap-2">
                          <button type="button" onClick={() => edit(entry)} aria-label={`Modifica cena del ${formatDinnerDate(entry.value.date)}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border-2 border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50">
                            <Pencil size={15} aria-hidden="true" /> <span>Modifica</span>
                          </button>
                          <button type="button" onClick={() => remove(entry)} aria-label={`Elimina cena del ${formatDinnerDate(entry.value.date)}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border-2 border-rose-200 px-3 py-1.5 text-sm font-semibold text-rose-800 hover:bg-rose-50">
                            <Trash2 size={15} aria-hidden="true" /> <span>Elimina</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <DinnerRecipePanel entry={entry} availableRecipes={availableRecipes} manageable={manageable} verified={verified} consentEnabled={dinnerConsentEnabled} csrfToken={csrfToken} />
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}
