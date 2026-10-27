import PaginatedList from '../ui/PaginatedList';
import { Heart, Star, Trash2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { getRecipeById } from '../../domain/recipes';
import UndoToast from '../feedback/UndoToast';
import EmptyState from '../ui/EmptyState';
import PageSection from '../ui/PageSection';

interface ActivityPanelProps {
  events: CookEvent[];
  preferences: RecipePreference[];
  onRemoveEvent: (id: string) => boolean;
  onRestoreEvent: (event: CookEvent) => boolean;
  onClearActivity: () => number;
}

const formatDate = (value: string): string => new Intl.DateTimeFormat('it-IT', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value));

export default function ActivityPanel(props: ActivityPanelProps) {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  return <ActivityPanelContent key={scope} {...props} />;
}

function ActivityPanelContent({ events, preferences, onRemoveEvent, onRestoreEvent, onClearActivity }: ActivityPanelProps) {
  const [removedEvents, setRemovedEvents] = useState<CookEvent[] | null>(null);

  const removeEvent = (id: string) => {
    const event = events.find((candidate) => candidate.id === id);
    if (event !== undefined && onRemoveEvent(id) !== false) setRemovedEvents([event]);
  };

  const clearActivity = () => {
    const removed = [...events];
    const count = onClearActivity();
    if (count > 0) setRemovedEvents(removed);
  };

  const restoreEvents = () => {
    if (removedEvents === null) return;
    if (removedEvents.every((event) => onRestoreEvent(event))) setRemovedEvents(null);
  };

  return (
    <>
    <PageSection
      eyebrow="Attività"
      title="La tua attività"
      description="Tieni traccia delle ricette provate e delle tue preferenze."
      action={
        events.length > 0 ? (
          <button type="button" onClick={clearActivity} className="min-h-11 rounded-xl border-2 border-gray-300 px-3 py-2 text-sm font-bold text-gray-800 hover:border-gray-900">
            Svuota attività
          </button>
        ) : undefined
      }
      className="border-emerald-200 shadow-sm sm:space-y-5"
    >
      <div className="mt-6 grid gap-6">
        <section aria-labelledby="cooking-history-title">
          <h2 id="cooking-history-title" className="text-xl font-black text-gray-950">Ricette cucinate</h2>
          {events.length === 0 ? (
            <EmptyState text="Non hai ancora segnato ricette come cucinate." />
          ) : (
            <ul className="mt-3 grid gap-3">
              <PaginatedList list identity="cooking-history" label="Ricette cucinate">{events.map((event) => (
                <li key={event.id} className="flex items-start gap-3 rounded-2xl border-2 border-gray-200 bg-gray-50 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-gray-950">{event.recipeTitle}</p>
                    <p className="mt-1 text-sm text-gray-600">{formatDate(event.cookedAt)} · {event.servings} {event.servings === 1 ? 'porzione' : 'porzioni'}</p>
                    {event.note !== null && <p className="mt-2 text-sm text-gray-700">Nota: {event.note}</p>}
                  </div>
                  <button type="button" aria-label={`Rimuovi evento ${event.recipeTitle}`} onClick={() => removeEvent(event.id)} className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-600 hover:bg-rose-50 hover:text-rose-700">
                    <Trash2 size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}</PaginatedList>
            </ul>
          )}
        </section>

        {preferences.length > 0 && (
          <section aria-labelledby="recipe-preferences-title">
            <h2 id="recipe-preferences-title" className="text-xl font-black text-gray-950">Preferiti e valutazioni</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              <PaginatedList list identity="recipe-preferences" label="Preferiti e valutazioni">{preferences.map((preference) => {
                const title = getRecipeById(preference.recipeId)?.title ?? preference.recipeId;
                return (
                  <li key={preference.recipeId} className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-4">
                    <p className="font-bold text-gray-950">{title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm font-semibold text-gray-700">
                      {preference.favorite && <span className="inline-flex items-center gap-1"><Heart size={16} fill="currentColor" aria-hidden="true" /> Preferita</span>}
                      {preference.rating !== null && <span className="inline-flex items-center gap-1"><Star size={16} fill="currentColor" aria-hidden="true" /> {preference.rating}/5</span>}
                    </div>
                    {preference.note !== null && <p className="mt-2 text-sm text-gray-700">Nota privata: {preference.note}</p>}
                  </li>
                );
              })}</PaginatedList>
            </ul>
          </section>
        )}
      </div>
    </PageSection>
    {removedEvents !== null && (
      <UndoToast
        message={removedEvents.length === 1 ? `Evento di ${removedEvents[0].recipeTitle} rimosso.` : `${removedEvents.length} eventi rimossi.`}
        onUndo={restoreEvents}
        onExpire={() => setRemovedEvents(null)}
      />
    )}
    </>
  );
}
