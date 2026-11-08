import type { AiConsent, AiRecipeProvider } from '@ikuck/shared/contracts';

interface DinnerConsentSectionProps {
  verified: boolean;
  userId: string | null;
  dinnerProviderName: string | null;
  consent: AiConsent | null;
  selectedProvider: AiRecipeProvider | null;
  consentDraft: boolean;
  dinnerConsentDraft: boolean;
  consentLoading: boolean;
  consentSaving: boolean;
  consentError: string | null;
  homeConsentEnabled: boolean;
  dinnerConsentEnabled: boolean;
  onConsentDraftChange: (value: boolean) => void;
  onDinnerConsentDraftChange: (value: boolean) => void;
  onSaveConsent: (enabled?: boolean) => Promise<void>;
  onSaveDinnerConsent: (provider?: AiRecipeProvider | null) => Promise<void>;
}

export default function DinnerConsentSection({
  verified,
  userId,
  dinnerProviderName,
  consent,
  selectedProvider,
  consentDraft,
  dinnerConsentDraft,
  consentLoading,
  consentSaving,
  consentError,
  homeConsentEnabled,
  dinnerConsentEnabled,
  onConsentDraftChange,
  onDinnerConsentDraftChange,
  onSaveConsent,
  onSaveDinnerConsent,
}: DinnerConsentSectionProps) {

  if (!verified) {
    return (
      <>
      {userId === null ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">Come ospite, le cene restano sul dispositivo: non inviamo testo, porzioni o note a un servizio AI. La ricostruzione è disponibile solo con un account verificato; vedrai il provider attivo e potrai dare un consenso esplicito prima dell'invio.</p>
      ) : (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">Con un account non verificato, la ricostruzione AI è disattivata: il testo della cena, le porzioni e le note non vengono inviati a un provider AI. Verifica l'account per vedere il provider attivo e decidere se consentire la ricostruzione.</p>
      )}
      </>
    );
  }

  return (
    <>
    {dinnerProviderName !== null ? (
      <>
      <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">
        La ricostruzione invia esclusivamente a <strong>{dinnerProviderName}</strong> il testo originale della cena e le porzioni indicate; se le porzioni non sono indicate, non viene inviato un numero. Non invia la nota, gli ingredienti della dispensa, il profilo alimentare o le ricette AI. Le bozze restano modificabili e conservate solo su questo dispositivo finché non le confermi o le scarti; non vengono salvate sul server come ricette.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
        Per Home soltanto, inviamo a {dinnerProviderName} i nomi degli ingredienti della dispensa; il profilo alimentare (dieta scelta, allergeni esclusi, calorie massime e proteine minime per porzione); e i titoli e nomi/quantità degli ingredienti delle ricette AI salvate o già proposte. Home invia anche l'elenco dei vincoli di generazione, attualmente vuoto. Questi dati non sono inviati dalla ricostruzione Dinner.
      </p>
      </>
    ) : (
      <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">Non è stato possibile verificare il provider AI attivo. La ricostruzione resta disattivata e il testo della cena non viene inviato.</p>
    )}
    {consentLoading ? (
      <p role="status" className="mt-3 text-sm font-semibold text-[var(--color-primary)]">Verifico il consenso AI…</p>
    ) : consent !== null ? (
      <>
      {selectedProvider !== null && dinnerProviderName !== null ? (
        <>
        <label className="mt-3 flex items-start gap-3 text-sm font-semibold text-[var(--color-text)]">
          <input type="checkbox" checked={consentDraft} onChange={(e) => onConsentDraftChange(e.target.checked)} disabled={consentSaving} aria-label={`Acconsento all'invio a ${dinnerProviderName} degli ingredienti della dispensa, del profilo alimentare e dei titoli e ingredienti delle ricette AI salvate o proposte`} className="mt-0.5 h-5 w-5 accent-[var(--color-primary)]" />
          <span>Acconsento all'invio a {dinnerProviderName} di ingredienti della dispensa, profilo alimentare e dati delle ricette AI per Home. Questo consenso resta personale; disattivando il consenso generale qui, si revocano anche i permessi Dinner.</span>
        </label>
        {consent.enabled && !homeConsentEnabled && <p className="mt-2 text-xs font-semibold leading-relaxed text-[var(--color-warning)]">Il provider è cambiato o il consenso precedente non specificava il destinatario: il consenso Home non autorizza {dinnerProviderName} finché non approvi esplicitamente questa scelta.</p>}
        {consentDraft !== homeConsentEnabled && <button type="button" onClick={() => onSaveConsent()} disabled={consentSaving} className="ik-button-primary mt-3 min-h-11">{consentSaving ? 'Salvo…' : 'Salva consenso AI globale'}</button>}
        <label className="mt-3 flex items-start gap-3 text-sm font-semibold text-[var(--color-text)]">
          <input
            type="checkbox"
            checked={dinnerConsentDraft}
            onChange={(e) => onDinnerConsentDraftChange(e.target.checked)}
            disabled={consentSaving || !consent.enabled}
            aria-label={`Acconsento all'invio a ${dinnerProviderName} del testo della cena e delle porzioni`}
            className="mt-0.5 h-5 w-5 accent-[var(--color-primary)]"
          />
          <span>Acconsento a inviare a {dinnerProviderName} il testo originale della cena e le porzioni indicate per preparare bozze che restano solo su questo dispositivo finché non le confermi o le scarti; non sono salvate sul server come ricette.</span>
        </label>
        {!consent.enabled && <p className="mt-2 text-sm text-[var(--color-text-muted)]">Per usare Dinner, attiva prima il consenso AI generale e salva la scelta.</p>}
        {dinnerConsentDraft !== dinnerConsentEnabled && consent.enabled && <button type="button" onClick={() => onSaveDinnerConsent()} disabled={consentSaving} className="ik-button-primary mt-3 min-h-11">{consentSaving ? 'Salvo…' : 'Salva consenso Dinner'}</button>}
        </>
      ) : (
        <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">Il consenso non è disponibile; la generazione resta disattivata.</p>
      )}
      </>
    ) : (
      <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">Il consenso non è disponibile; la generazione resta disattivata.</p>
    )}
    {consentError !== null && <p role="alert" className="ik-status-danger mt-3 rounded-[var(--radius-control)] p-3 text-sm font-semibold">{consentError}</p>}
    {verified && consent?.enabled && (
      <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3 mt-4">
        {consent.dinnerProvider !== undefined && <button type="button" onClick={() => onSaveDinnerConsent(null)} disabled={consentSaving} className="ik-button-secondary min-h-11 border-2 border-[var(--color-danger)]/30 px-4 py-2 font-bold text-[var(--color-danger)] disabled:opacity-60">{consentSaving ? 'Salvataggio…' : 'Revoca consenso Dinner'}</button>}
        <button type="button" onClick={() => onSaveConsent(false)} disabled={consentSaving} className="ik-button-secondary min-h-11 border-2 border-[var(--color-danger)]/30 px-4 py-2 font-bold text-[var(--color-danger)] disabled:opacity-60">{consentSaving ? 'Salvataggio…' : 'Revoca consenso AI globale'}</button>
      </div>
    )}
    </>
  );
}