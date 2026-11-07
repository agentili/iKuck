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
      <main className="ik-page mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-4 py-8">
        <div className="ik-surface rounded-2xl p-5 text-center">
          <p role="status" className="font-semibold text-[var(--color-text)]">Caricamento dell'attività…</p>
        </div>
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