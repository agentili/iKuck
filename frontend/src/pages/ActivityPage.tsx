import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import ActivityPanel from '../components/activity/ActivityPanel';
import { hydrateActivityStore, useActivityStore } from '../store/activityStore';

export default function ActivityPage() {
  const hasHydrated = useActivityStore((state) => state.hasHydrated);
  const events = useActivityStore((state) => state.events);
  const preferences = useActivityStore((state) => state.preferences);
  const removeCookEvent = useActivityStore((state) => state.removeCookEvent);
  const restoreCookEvent = useActivityStore((state) => state.restoreCookEvent);
  const clearActivity = useActivityStore((state) => state.clearActivity);

  useEffect(() => {
    void hydrateActivityStore();
  }, []);

  if (!hasHydrated) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8">
        <p role="status" className="rounded-2xl border border-gray-200 bg-white px-5 py-4 font-semibold text-gray-700">Caricamento dell’attività…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto min-h-screen w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50">
        <ArrowLeft size={18} aria-hidden="true" /> Torna alla dispensa
      </Link>
      <div className="mt-6">
        <ActivityPanel events={events} preferences={preferences} onRemoveEvent={removeCookEvent} onRestoreEvent={restoreCookEvent} onClearActivity={clearActivity} />
      </div>
    </main>
  );
}
