import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/apiClient';
import { useAuthStore } from '../auth/authStore';
import { useHouseStore } from '../house/houseStore';

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiClientError) {
    if (error.code === 'house_email_not_registered') return 'Questa email non è ancora registrata in iKuck.';
    if (error.code === 'house_user_already_member') return 'Questo account è già membro della casa.';
    if (error.code === 'house_user_already_in_house') return 'Questo account appartiene già a un’altra casa.';
    if (error.code === 'house_last_admin_required') return 'La casa deve mantenere almeno un admin.';
    if (error.code === 'house_admin_required') return 'Solo un admin può eseguire questa azione.';
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
      <main id="main-content" className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-3xl font-black text-gray-950">La mia casa</h1>
          <p className="mt-3 text-gray-600">Accedi per creare o gestire una casa condivisa.</p>
          <Link to="/profile" className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white">Vai al profilo</Link>
        </section>
      </main>
    );
  }

  const isAdmin = houseState?.membership?.role === 'admin';

  return (
    <main id="main-content" className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 pb-24 sm:px-6 sm:pb-8 lg:px-8">
      <div className="mb-5"><Link to="/profile" className="inline-flex min-h-11 items-center rounded-xl px-2 font-semibold text-gray-700 underline underline-offset-2">← Torna al profilo</Link></div>
      <section className="rounded-3xl border-2 border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-bold uppercase tracking-wide text-emerald-700">Condivisione familiare</p>
        <h1 className="mt-1 text-3xl font-black text-gray-950">{houseState?.house?.name ?? 'La mia casa'}</h1>
        {message !== null && <p role="status" className="mt-5 rounded-xl bg-emerald-50 p-3 font-semibold text-emerald-900">{message}</p>}
        {error !== null && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-3 font-semibold text-rose-900">{error}</p>}

        {houseState === null ? (
          <form className="mt-7 grid gap-3" onSubmit={handleCreate}>
            <h2 className="text-xl font-black text-gray-950">Crea una casa</h2>
            <p className="text-gray-600">La casa condividerà la dispensa: ingredienti, lotti e ingredienti di base. Lista della spesa, attività, ricette generate e dati del profilo restano personali.</p>
            <label className="grid gap-1 text-sm font-semibold text-gray-800">
              Nome della casa
              <input value={houseName} onChange={(event) => setHouseName(event.target.value)} maxLength={80} required className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900" />
            </label>
            <button type="submit" disabled={isLoading || csrfToken === null} className="min-h-11 w-fit rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800 disabled:opacity-60">Crea casa</button>
          </form>
        ) : (
          <>
            <div className="mt-7 grid gap-3 border-t border-gray-200 pt-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xl font-black text-gray-950">Membri</h2>
                <span className="text-sm font-semibold text-gray-600">Il tuo ruolo: {isAdmin ? 'admin' : 'member'}</span>
              </div>
              <ul className="grid gap-3" aria-label="Membri della casa">
                {houseState.members.map((member) => (
                  <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50 p-3">
                    <div>
                      <p className="font-bold text-gray-950">{member.displayName ?? member.email}</p>
                      {member.displayName !== null && <p className="text-sm text-gray-600">{member.email}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-gray-200 px-2.5 py-1 text-xs font-bold text-gray-700">{member.role}</span>
                      {isAdmin && member.userId !== user.id && (
                        <>
                          <button type="button" onClick={() => void run(() => changeRole(member.userId, member.role === 'admin' ? 'member' : 'admin', csrfToken ?? ''), 'Ruolo aggiornato.')} className="min-h-10 rounded-lg border-2 border-gray-300 px-3 text-sm font-bold text-gray-800">{member.role === 'admin' ? 'Declassa' : 'Promuovi'}</button>
                          <button type="button" onClick={() => { if (window.confirm('Rimuovere questa persona dalla casa?')) void run(() => removeMember(member.userId, csrfToken ?? ''), 'Persona rimossa.'); }} className="min-h-10 rounded-lg border-2 border-rose-200 px-3 text-sm font-bold text-rose-800">Rimuovi</button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {isAdmin && (
              <form className="mt-7 grid gap-3 border-t border-gray-200 pt-6" onSubmit={handleAddMember}>
                <h2 className="text-xl font-black text-gray-950">Aggiungi persona</h2>
                <p className="text-gray-600">Inserisci l’email di un account già registrato. La persona verrà informata esternamente.</p>
                <label className="grid gap-1 text-sm font-semibold text-gray-800">
                  Email della persona
                  <input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required className="min-h-11 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 outline-none focus:border-gray-900" />
                </label>
                <button type="submit" disabled={isLoading || csrfToken === null} className="min-h-11 w-fit rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800 disabled:opacity-60">Aggiungi persona</button>
              </form>
            )}

            <div className="mt-7 grid gap-3 border-t border-gray-200 pt-6">
              <h2 className="text-xl font-black text-gray-950">Dispensa condivisa</h2>
              <p className="text-gray-600">Quando una persona entra nella casa, ingredienti, lotti e ingredienti di base vengono uniti automaticamente. Dieta, allergeni, consenso e preferenze personali restano separati.</p>
              <button type="button" disabled={isLoading || csrfToken === null} onClick={() => void run(() => importPersonalData(csrfToken ?? ''), 'Unione della dispensa completata.')} className="min-h-11 w-fit rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-2 font-bold text-amber-950 disabled:opacity-60">Riprova unione della dispensa</button>
            </div>

            <div className="mt-7 border-t border-gray-200 pt-6">
              <button type="button" disabled={isLoading || csrfToken === null} onClick={() => { if (window.confirm('Lasciare la casa?')) void run(() => leave(csrfToken ?? ''), 'Hai lasciato la casa.'); }} className="min-h-11 rounded-xl border-2 border-rose-200 px-4 py-2 font-bold text-rose-800 disabled:opacity-60">Lascia la casa</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
