import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CalendarDays, Check, Pencil, Save, Trash2, X } from 'lucide-react';
import type { AiConsent, AiRecipeProvider } from '@ikuck/shared/contracts';
import type { DinnerEntry } from '@ikuck/shared/dinnerDiary';
import type { DinnerConsumptionCommand, DinnerConsumptionIngredient, PantryConsumptionPlan } from '@ikuck/shared/pantryConsumption';
import { planPantryConsumption } from '@ikuck/shared/pantryConsumption';
import { DIARY_NOTE_MAX_LENGTH, DIARY_SERVINGS_MAX, DIARY_SERVINGS_MIN, DIARY_TEXT_MAX_LENGTH } from '@ikuck/shared/limits';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { fetchAiConsentStatus, updateAiConsent, updateDinnerAiConsent } from '../ai/aiRecipeApi';
import { clearAiRecipeProposalHistory } from '../ai/aiRecipeHistory';
import DinnerConsumptionSelection from '../components/dinnerDiary/DinnerConsumptionSelection';
import DinnerRecipePanel from '../components/dinnerDiary/DinnerRecipePanel';
import DinnerConsentSection from '../components/dinnerDiary/DinnerConsentSection';
import DiaryNavigation from '../components/layout/DiaryNavigation';
import ErrorBanner from '../components/ui/ErrorBanner';
import EmptyState from '../components/ui/EmptyState';
import PageSection from '../components/ui/PageSection';
import { useHouseStore } from '../house/houseStore';
import { usePantryStore } from '../store/localPantryStore';
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

const createLocalId = (prefix: string): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
};

export default function DinnerDiaryPage() {
  const hasHydrated = useDinnerDiaryStore((state) => state.hasHydrated);
  const entries = useDinnerDiaryStore((state) => state.entries);
  const storeError = useDinnerDiaryStore((state) => state.error);
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
  const [consumptionIngredients, setConsumptionIngredients] = useState<DinnerConsumptionIngredient[]>([]);
  const [consumptionNoneUsed, setConsumptionNoneUsed] = useState(false);
  const [confirmingDinner, setConfirmingDinner] = useState(false);
  const [confirmedPlan, setConfirmedPlan] = useState<PantryConsumptionPlan | null>(null);
  const [confirmedNoIngredientsUsed, setConfirmedNoIngredientsUsed] = useState(false);
  const confirmEntry = useDinnerDiaryStore((state) => state.confirmEntry);
  const pantryLots = usePantryStore((state) => state.pantryLots);

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

  const enteredServings = servings === '' ? null : Number(servings);
  const previewServings = enteredServings !== null && Number.isInteger(enteredServings) && enteredServings > 0
    ? enteredServings
    : null;

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
          setConsentError('Il consenso è cambiato in un\'altra scheda. Ho aggiornato lo stato: verifica la scelta prima di salvare di nuovo.');
        } catch {
          setConsentError('Il consenso è cambiato in un\'altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
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
          setConsentError('Il consenso è cambiato in un\'altra scheda. Ho aggiornato lo stato: verifica la scelta prima di salvare di nuovo.');
        } catch {
          setConsentError('Il consenso è cambiato in un\'altra scheda. Aggiorna la pagina e verifica la scelta prima di riprovare.');
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
    if (confirmingDinner) return;
    if (text.trim().length === 0) {
      setFormError('Scrivi cosa avete mangiato prima di registrare la cena.');
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
      resetForm();
      return;
    }
    void confirmNewDinner(numericServings);
  };

  const confirmNewDinner = async (numericServings: number | null) => {
    const scope = getActiveDataScope();
    if (numericServings === null) {
      setFormError('Indica le porzioni della cena per poterla registrare.');
      return;
    }
    const ingredients = consumptionNoneUsed ? [] : consumptionIngredients;
    if (!consumptionNoneUsed && !ingredients.some((ingredient) => ingredient.used && ingredient.ingredientId !== null)) {
      setFormError('Indica gli ingredienti utilizzati oppure seleziona "Nessun ingrediente della dispensa utilizzato".');
      return;
    }
    const committedAt = new Date().toISOString();
    const entry: DinnerEntry = {
      id: createLocalId('dinner'),
      date,
      text,
      servings: numericServings,
      note: note.trim() === '' ? null : note,
      recipes: [],
      authorId: scope === 'guest' ? null : userId,
      createdAt: committedAt,
      updatedAt: committedAt,
    };
    const command: DinnerConsumptionCommand = {
      operationId: createLocalId('consume'),
      entryId: entry.id,
      scope,
      servings: numericServings,
      ingredients,
    };
    const plan = consumptionNoneUsed ? null : planPantryConsumption({ lots: pantryLots, command, updatedAt: committedAt });
    if (plan !== null && plan.unresolvedIngredients.length > 0) {
      setFormError('Chiarisci ogni ingrediente o quantità ambigua prima di registrare la cena.');
      return;
    }
    setFormError(null);
    setConfirmingDinner(true);
    try {
      const confirmed = await confirmEntry(command, entry);
      if (getActiveDataScope() !== scope) return;
      if (!confirmed) {
        setFormError('La dispensa non è stata aggiornata; il modulo resta disponibile per riprovare.');
        return;
      }
      setConfirmedPlan(plan);
      setConfirmedNoIngredientsUsed(consumptionNoneUsed);
      setConsumptionIngredients([]);
      setConsumptionNoneUsed(false);
      resetForm();
    } finally {
      setConfirmingDinner(false);
    }
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
      <main className="ik-page mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm text-center">
          <p role="status" className="font-semibold text-[var(--color-text)]">Caricamento del diario…</p>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-4xl px-4 pb-24 pt-5 sm:px-6 sm:pb-10 sm:pt-8 lg:px-8">
      <DiaryNavigation />
      <header className="ik-page-intro mb-5 max-w-2xl sm:mb-7">
        <p className="ik-eyebrow text-sm font-bold uppercase tracking-[0.14em] text-[var(--color-primary)]">
          La memoria della tavola
        </p>
        <h1 className="mt-1 text-4xl font-black leading-[1.04] text-[var(--color-text)] sm:text-5xl">
          Diario delle cene
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--color-text-muted)] sm:text-lg">
          Segna cosa avete mangiato, senza modificare la dispensa. Potrai ricostruire una ricetta in un secondo momento.
        </p>
      </header>

      <PageSection
        featured
        eyebrow="Impostazioni"
        title="Consenso AI per Dinner"
        titleId="dinner-consent-title"
      >
        <DinnerConsentSection
          verified={verified}
          userId={userId}
          dinnerProviderName={dinnerProviderName}
          consent={consent}
          selectedProvider={selectedProvider}
          consentDraft={consentDraft}
          dinnerConsentDraft={dinnerConsentDraft}
          consentLoading={consentLoading}
          consentSaving={consentSaving}
          consentError={consentError}
          homeConsentEnabled={homeConsentEnabled}
          dinnerConsentEnabled={dinnerConsentEnabled}
          onConsentDraftChange={setConsentDraft}
          onDinnerConsentDraftChange={setDinnerConsentDraft}
          onSaveConsent={saveConsent}
          onSaveDinnerConsent={saveDinnerConsent}
        />
      </PageSection>

      <PageSection
        featured
        eyebrow="Il tuo diario"
        title={editingEntry === null ? 'Registra una cena' : 'Modifica la cena'}
        titleId="dinner-entry-form-title"
      >
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <label className="block text-sm font-bold text-[var(--color-text)]" htmlFor="dinner-date">
              Data della cena
              <span className="mt-1 flex min-h-11 items-center gap-2 rounded-xl border-2 border-[var(--color-border)] bg-[var(--color-surface)] px-3 focus-within:border-[var(--color-primary)]">
                <CalendarDays size={18} aria-hidden="true" className="shrink-0 text-[var(--color-text-muted)]" />
                <input id="dinner-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-base text-[var(--color-text)] outline-none" />
              </span>
            </label>
            <label className="block text-sm font-bold text-[var(--color-text)]" htmlFor="dinner-servings">
              Porzioni <span className="font-normal text-[var(--color-text-muted)]">(facoltative)</span>
              <input id="dinner-servings" type="number" inputMode="numeric" min={DIARY_SERVINGS_MIN} max={DIARY_SERVINGS_MAX} value={servings} onChange={(event) => setServings(event.target.value)} className="ik-input mt-1 min-h-11 w-full" />
            </label>
          </div>
          <label className="block text-sm font-bold text-[var(--color-text)]" htmlFor="dinner-text">
            Com'è andata la cena?
            <textarea id="dinner-text" required maxLength={DIARY_TEXT_MAX_LENGTH} rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="Per esempio: pasta con zucchine, poi insalata con pomodorini e feta." className="ik-input mt-1 min-h-28 w-full resize-y" />
            <span className="mt-1 block text-right text-xs font-medium text-[var(--color-text-muted)]">{text.length}/{DIARY_TEXT_MAX_LENGTH}</span>
          </label>
          <label className="block text-sm font-bold text-[var(--color-text)]" htmlFor="dinner-note">
            Nota <span className="font-normal text-[var(--color-text-muted)]">(facoltativa)</span>
            <textarea id="dinner-note" maxLength={DIARY_NOTE_MAX_LENGTH} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Un dettaglio da ricordare" className="ik-input mt-1 min-h-20 w-full resize-y" />
          </label>
          {editingEntry === null && (
            <DinnerConsumptionSelection
              mode="free-text"
              ingredients={consumptionIngredients}
              lots={pantryLots}
              servings={previewServings}
              noneUsed={consumptionNoneUsed}
              onIngredientsChange={setConsumptionIngredients}
              onNoneUsedChange={setConsumptionNoneUsed}
              disabled={confirmingDinner}
              confirmedPlan={confirmedPlan}
              confirmedNoIngredientsUsed={confirmedNoIngredientsUsed}
            />
          )}
          {formError !== null && <ErrorBanner message={formError} />}
          {storeError !== null && <p role="status" className="text-sm text-[var(--color-warning)]">Alcune modifiche potrebbero non essersi sincronizzate. Riprova quando sei online.</p>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={confirmingDinner} className="ik-button-primary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2 font-bold disabled:opacity-60">
              {!confirmingDinner && (editingEntry === null ? <Check size={18} aria-hidden="true" /> : <Save size={18} aria-hidden="true" />)}
              {confirmingDinner ? 'Registro…' : editingEntry === null ? 'Registra la cena' : 'Salva modifiche'}
            </button>
            {editingEntry !== null && (
              <button type="button" onClick={resetForm} className="ik-button-secondary inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold">
                <X size={17} aria-hidden="true" /> Annulla modifica
              </button>
            )}
          </div>
        </form>
      </PageSection>

      <PageSection
        featured
        eyebrow="Il tuo archivio"
        title="Le tue cene"
        titleId="dinner-history-title"
        action={
          <p className="text-sm font-semibold text-[var(--color-text-muted)]">
            {orderedEntries.length} {orderedEntries.length === 1 ? 'cena' : 'cene'}
          </p>
        }
      >
        {orderedEntries.length === 0 ? (
          <EmptyState text="Non hai ancora registrato una cena." />
        ) : (
          <ol className="space-y-3">
            {orderedEntries.map((entry) => {
              const manageable = canManageEntry(entry, userId, houseId, houseRole);
              const linkedRecipeIds = new Set(entry.value.recipes.map((recipe) => recipe.recipeId));
              const availableRecipes = savedRecipes.filter((recipe) => recipe.scope === entry.scope && !linkedRecipeIds.has(recipe.value.id));
              return (
                <li key={`${entry.scope}:${entry.value.id}`}>
                  <article className="ik-card p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-[var(--color-primary)]">{formatDinnerDate(entry.value.date)}</p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-base leading-relaxed text-[var(--color-text)]">{entry.value.text}</p>
                        {entry.value.note !== null && <p className="mt-2 text-sm text-[var(--color-text-muted)]">Nota: {entry.value.note}</p>}
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                          <span className="ik-badge">{entry.scope.startsWith('house:') ? 'Condivisa con la Casa' : 'Personale'}</span>
                          {entry.value.servings !== null && <span className="ik-badge">{entry.value.servings} {entry.value.servings === 1 ? 'porzione' : 'porzioni'}</span>}
                          <span className={`ik-badge ${entry.value.recipes.length === 0 ? 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]' : 'bg-[var(--color-primary)]/20 text-[var(--color-primary)]'}`}>
                            {entry.value.recipes.length === 0 ? 'Da completare' : `${entry.value.recipes.length} ${entry.value.recipes.length === 1 ? 'ricetta collegata' : 'ricette collegate'}`}
                          </span>
                        </div>
                        {entry.value.recipes.length > 0 && <ul className="mt-2 list-inside list-disc text-sm text-[var(--color-text-muted)]">{entry.value.recipes.map((recipe) => <li key={recipe.recipeId}>{recipe.title}</li>)}</ul>}
                      </div>
                      {manageable && (
                        <div className="flex shrink-0 gap-2">
                          <button type="button" onClick={() => edit(entry)} aria-label={`Modifica cena del ${formatDinnerDate(entry.value.date)}`} className="ik-button-secondary inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold">
                            <Pencil size={15} aria-hidden="true" /> <span>Modifica</span>
                          </button>
                          <button type="button" onClick={() => remove(entry)} aria-label={`Elimina cena del ${formatDinnerDate(entry.value.date)}`} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border-2 border-[var(--color-danger)]/30 px-3 py-1.5 text-sm font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10">
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
      </PageSection>
    </main>
  );
}