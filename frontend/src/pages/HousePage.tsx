import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';
import ErrorBanner from '../components/ui/ErrorBanner';
import PageSection from '../components/ui/PageSection';
import type { HouseRole } from '@ikuck/shared/contracts';

const roleLabel = (role: HouseRole): string => (role === 'admin' ? 'Amministratore' : 'Membro');

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === 'house_email_not_registered') return 'Questa email non è ancora registrata in iKuck.';
    if (error.code === 'house_user_already_member') return 'Questo account è già membro della casa.';
    if (error.code === 'house_user_already_in_house') return 'Questo account appartiene già a un’altra casa.';
    if (error.code === 'house_last_admin_required') return 'La casa deve mantenere almeno un admin.';
    if (error.code === 'house_admin_required') return 'Solo un admin può eseguire questa azione.';
    if (error.code === 'rate_limited') return 'Troppe richieste. Riprova più tardi.';
    if (error.code === 'rate_limit_unavailable') return 'Verifica temporaneamente non disponibile. Riprova più tardi.';
    if (error.code === 'network_error') return 'Operazione non disponibile offline. Riprova quando torni online.';
  }
  return 'Non è stato possibile completare l’operazione. Riprova.';
};

export default function HousePage() {
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const houseState = useHouseStore((state) => state.state);
  const isLoading = useHouseStore((state) => state.isLoading);
  const storeError = useHouseStore((state) => state.error);
  const refresh = useHouseStore((state) => state.refresh);
  const create = useHouseStore((state) => state.create);
  const addMember = useHouseStore((state) => state.addMember);
  const importPersonalData = useHouseStore((state) => state.importPersonalData);
  const changeRole = useHouseStore((state) => state.changeRole);
  const removeMember = useHouseStore((state) => state.removeMember);
  const leave = useHouseStore((state) => state.leave);
  const [houseName, setHouseName] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user === null) return;
    void refresh().catch(() => undefined);
  }, [refresh, user]);

  useEffect(() => {
    if (storeError !== null) setError(errorMessage(storeError));
  }, [storeError]);

  const run = async (operation: () => Promise<void>, successMessage: string): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      await operation();
      setMessage(successMessage);
    } catch (operationError) {
      setError(errorMessage(operationError));
    }
  };

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (csrfToken === null) return;
    void run(async () => {
      await create(houseName, csrfToken);
      setHouseName('');
    }, 'Casa creata.');
  };

  const handleAddMember = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (csrfToken === null) return;
    void run(async () => {
      await addMember(memberEmail, csrfToken);
      setMemberEmail('');
    }, 'Persona aggiunta alla casa.');
  };

  if (user === null) {
    return (
      <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 py-5 pb-24 text-[var(--ik-ink)] sm:px-6 sm:py-8 lg:px-8">
        <PageSection
          eyebrow="La tua casa"
          title="La mia casa"
          titleId="house-title"
          titleLevel="h1"
          description="Accedi o crea un account verificato per creare o gestire una casa condivisa."
          className="border-[var(--ik-sage)] shadow-sm sm:space-y-5"
        >
          <p className="mt-5 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 text-sm leading-relaxed text-[var(--ik-ink-muted)]">
            I dati ospite restano su questo dispositivo e non vengono importati automaticamente in una Casa. Dopo l’accesso puoi scegliere se importarli dal Profilo.
          </p>
          <Link to="/profile" className="ik-button-primary mt-5 inline-flex min-h-11 items-center rounded-[var(--ik-radius-control)] px-4 py-2 font-bold text-[var(--ik-porcelain)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">Accedi o crea un account</Link>
        </PageSection>
      </main>
    );
  }

  const isAdmin = houseState?.membership?.role === 'admin';

  return (
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-3xl px-4 py-5 pb-24 text-[var(--ik-ink)] sm:px-6 sm:py-8 lg:px-8">
      <div className="mb-5"><Link to="/profile" className="inline-flex min-h-11 items-center rounded-[var(--ik-radius-control)] px-2 font-semibold text-[var(--ik-ink-muted)] underline underline-offset-2 hover:bg-[var(--ik-mist)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">← Torna al profilo</Link></div>
      <PageSection
        eyebrow="Condivisione familiare"
        title={houseState?.house?.name ?? 'La mia casa'}
        titleId="house-title"
        titleLevel="h1"
        className="border-[var(--ik-sage)] shadow-sm sm:space-y-5"
      >
        {message !== null && <p role="status" className="mt-5 rounded-xl border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] p-3 font-semibold text-[var(--ik-ink)]">{message}</p>}
        {error !== null && <ErrorBanner message={error} />}

        {houseState === null ? (
          <form className="mt-7 grid gap-3" onSubmit={handleCreate}>
            <h2 className="text-xl font-black text-[var(--ik-ink)]">Crea una casa</h2>
            <p className="text-[var(--ik-ink-muted)]">La Casa condividerà dispensa, spesa, attività, ricette salvate, preferenze alimentari e di ricetta, Piano e Diario. Usa un unico profilo alimentare e allergeni. I dati funzionali già salvati nel tuo account verranno trasferiti alla Casa quando la crei o ne entri a far parte, senza copie personali divergenti. I dati ospite presenti solo su questo dispositivo non vengono importati automaticamente: puoi scegliere l’importazione dal Profilo. L’identità, il consenso AI e le anteprime non salvate restano personali.</p>
            <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
              Nome della casa
              <input value={houseName} onChange={(event) => setHouseName(event.target.value)} maxLength={80} required className="ik-input min-h-11 border-2 bg-[var(--ik-surface)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]" />
            </label>
            <button type="submit" disabled={isLoading || csrfToken === null} className="ik-button-primary min-h-11 w-fit rounded-[var(--ik-radius-control)] px-4 py-2 font-bold text-[var(--ik-porcelain)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60">Crea casa</button>
          </form>
        ) : (
          <>
            <div className="mt-7 grid gap-3 border-t border-[var(--ik-border)] pt-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xl font-black text-[var(--ik-ink)]">Membri</h2>
                <span className="text-sm font-semibold text-[var(--ik-ink-muted)]">Il tuo ruolo: {roleLabel(isAdmin ? 'admin' : 'member')}</span>
              </div>
              <ul className="grid gap-3" aria-label="Membri della casa">
                {houseState.members.map((member) => (
                  <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3">
                    <div>
                      <p className="font-bold text-[var(--ik-ink)]">{member.displayName ?? member.email}</p>
                      {member.displayName !== null && <p className="text-sm text-[var(--ik-ink-muted)]">{member.email}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[var(--ik-border)] px-2.5 py-1 text-xs font-bold text-[var(--ik-ink)]">{roleLabel(member.role)}</span>
                      {isAdmin && member.userId !== user.id && (
                        <>
                          <button type="button" onClick={() => void run(() => changeRole(member.userId, member.role === 'admin' ? 'member' : 'admin', csrfToken ?? ''), 'Ruolo aggiornato.')} className="min-h-10 rounded-lg border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-sm font-bold text-[var(--ik-ink)] hover:bg-[var(--ik-mist)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">{member.role === 'admin' ? 'Declassa' : 'Promuovi'}</button>
                          <button type="button" onClick={() => { if (window.confirm('Rimuovere questa persona dalla casa?')) void run(() => removeMember(member.userId, csrfToken ?? ''), 'Persona rimossa.'); }} className="min-h-10 rounded-lg border-2 border-[var(--ik-tomato)] px-3 text-sm font-bold text-[var(--ik-tomato)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]">Rimuovi</button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {isAdmin && (
              <form className="mt-7 grid gap-3 border-t border-[var(--ik-border)] pt-6" onSubmit={handleAddMember}>
                <h2 className="text-xl font-black text-[var(--ik-ink)]">Aggiungi persona</h2>
                <p className="text-[var(--ik-ink-muted)]">Inserisci l’email di un account già registrato. La persona verrà informata esternamente.</p>
                <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
                  Email della persona
                  <input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required className="ik-input min-h-11 border-2 bg-[var(--ik-surface)] px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)]" />
                </label>
                <button type="submit" disabled={isLoading || csrfToken === null} className="ik-button-primary min-h-11 w-fit rounded-[var(--ik-radius-control)] px-4 py-2 font-bold text-[var(--ik-porcelain)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60">Aggiungi persona</button>
              </form>
            )}

            <div className="mt-7 grid gap-3 border-t border-[var(--ik-border)] pt-6">
              <h2 className="text-xl font-black text-[var(--ik-ink)]">Dati della casa</h2>
              <p className="text-[var(--ik-ink-muted)]">Dispensa, spesa, attività, ricette salvate, preferenze alimentari e di ricetta, Piano e Diario appartengono alla Casa. Un unico profilo alimentare e allergeni vale per tutti i membri, che possono creare, modificare ed eliminare questi contenuti, anche quelli di altre persone. L’identità e il consenso AI restano personali; le anteprime non salvate non vengono condivise.</p>
              <button type="button" disabled={isLoading || csrfToken === null} onClick={() => void run(() => importPersonalData(csrfToken ?? ''), 'Importazione dati funzionali completata.')} className="min-h-11 w-fit rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-yolk)] bg-[var(--ik-yolk-soft)] px-4 py-2 font-bold text-[var(--ik-warn-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60">Riprova importazione dati funzionali</button>
            </div>

            <div className="mt-7 border-t border-[var(--ik-border)] pt-6">
              <button type="button" disabled={isLoading || csrfToken === null} onClick={() => { if (window.confirm('Lasciare la casa?')) void run(() => leave(csrfToken ?? ''), 'Hai lasciato la casa.'); }} className="min-h-11 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-tomato)] px-4 py-2 font-bold text-[var(--ik-tomato)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-focus)] disabled:cursor-wait disabled:opacity-60">Lascia la casa</button>
            </div>
          </>
        )}
      </PageSection>
    </main>
  );
}
