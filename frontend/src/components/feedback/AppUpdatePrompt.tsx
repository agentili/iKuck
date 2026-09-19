export type AppUpdateStatus = 'available' | 'updating' | 'failed';

interface AppUpdatePromptProps {
  status: AppUpdateStatus;
  errorMessage?: string;
  onUpdate: () => void;
  onLater: () => void;
}

export default function AppUpdatePrompt({
  status,
  errorMessage = 'Aggiornamento non riuscito. Riprova quando la connessione è disponibile.',
  onUpdate,
  onLater,
}: AppUpdatePromptProps) {
  const isUpdating = status === 'updating';
  const isFailed = status === 'failed';

  return (
    <aside
      className="app-overlay fixed inset-x-4 z-50 mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-4 rounded-2xl border-2 border-emerald-200 bg-white p-4 shadow-xl"
      aria-label="Aggiornamento applicazione"
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold text-gray-950" role={isFailed ? 'alert' : 'status'}>
          {isFailed ? 'Aggiornamento non riuscito' : 'Aggiornamento disponibile'}
        </p>
        <p className="mt-1 text-sm text-gray-700">
          {isUpdating
            ? 'Sto preparando la nuova versione…'
            : isFailed
              ? errorMessage
              : 'Puoi continuare a usare l’app e scegliere quando aggiornare.'}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <button
          type="button"
          onClick={onUpdate}
          disabled={isUpdating}
          className="min-h-10 rounded-xl bg-emerald-700 px-3 py-2 font-bold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
        >
          {isUpdating ? 'Aggiornamento in corso' : isFailed ? 'Riprova aggiornamento' : 'Aggiorna ora'}
        </button>
        <button
          type="button"
          onClick={onLater}
          disabled={isUpdating}
          className="min-h-10 rounded-xl border-2 border-gray-300 px-3 py-2 font-bold text-gray-800 hover:border-gray-900 disabled:opacity-60"
        >
          Più tardi
        </button>
      </div>
    </aside>
  );
}
