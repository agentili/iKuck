import { useEffect } from 'react';
import ActivityPanel from '../components/activity/ActivityPanel';
import DiaryNavigation from '../components/layout/DiaryNavigation';
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
    <main id="main-content" className="ik-page mx-auto min-h-screen w-full max-w-4xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8 lg:px-8">
      <DiaryNavigation />
      <ActivityPanel events={events} preferences={preferences} onRemoveEvent={removeCookEvent} onRestoreEvent={restoreCookEvent} onClearActivity={clearActivity} />
    </main>
  );
}
