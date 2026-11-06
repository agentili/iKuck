import { Heart, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { getRecipeById } from '../../domain/recipes';
import { retryPersistence, usePersistenceStatusStore } from '../../store/persistenceStatusStore';
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

export default function ActivityPanel({ events, preferences, onRemoveEvent, onRestoreEvent, onClearActivity }: ActivityPanelProps) {
  const [removedEvents, setRemovedEvents] = useState<CookEvent[] | null>(null);
  const activityPersistenceStatus = usePersistenceStatusStore((state) => state.statuses.activity);
  const persistenceError = activityPersistenceStatus.state === 'memory-only'
    ? 'Le modifiche all’attività sono disponibili solo in memoria.'
    : activityPersistenceStatus.state === 'sync-error'
      ? 'La sincronizzazione dell’attività non è riuscita.'
      : null;

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
    {persistenceError !== null && (
      <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--ik-radius-panel)] border-2 border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] px-4 py-3 text-[var(--ik-ink)]">
        <p className="min-w-0 flex-1 text-sm leading-relaxed">{persistenceError} Puoi riprovare quando vuoi.</p>
        <button type="button" onClick={() => void retryPersistence('activity')} className="min-h-11 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-tomato)] bg-[var(--ik-surface)] px-3 py-1.5 font-bold text-[var(--ik-ink)] hover:bg-[var(--ik-sage)]">
          Riprova
        </button>
      </div>
    )}
    <PageSection
      eyebrow="Attività"
      title="La tua attività"
      titleId="activity-title"
      description="Tieni traccia delle ricette provate e delle tue preferenze."
      action={
        events.length > 0 ? (
          <button type="button" onClick={clearActivity} className="min-h-11 rounded-xl border-2 border-[var(--ik-tomato)] bg-[var(--ik-surface)] px-3 py-2 text-sm font-bold text-[var(--ik-tomato)] hover:bg-[var(--ik-tomato-soft)]">
            Svuota attività
          </button>
        ) : undefined
      }
      className="border-[var(--ik-border)] bg-[var(--ik-surface)] sm:space-y-5"
    >
      <div className="mt-6 grid gap-6">
        <section aria-labelledby="cooking-history-title">
          <h2 id="cooking-history-title" className="text-xl font-black text-[var(--ik-ink)]">Ricette cucinate</h2>
          {events.length === 0 ? (
            <EmptyState text="Non hai ancora segnato ricette come cucinate." />
          ) : (
            <ul className="mt-3 grid gap-3">
              {events.map((event) => (
                <li key={event.id} className="flex items-start gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-[var(--ik-ink)]">{event.recipeTitle}</p>
                    <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">{formatDate(event.cookedAt)} · {event.servings} {event.servings === 1 ? 'porzione' : 'porzioni'}</p>
                    {event.note !== null && <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Nota: {event.note}</p>}
                  </div>
                  <button type="button" aria-label={`Rimuovi evento ${event.recipeTitle}`} onClick={() => removeEvent(event.id)} className="grid min-h-11 min-w-11 place-items-center rounded-xl text-[var(--ik-ink-muted)] hover:bg-[var(--ik-tomato-soft)] hover:text-[var(--ik-tomato)]">
                    <Trash2 size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {preferences.length > 0 && (
          <section aria-labelledby="recipe-preferences-title">
            <h2 id="recipe-preferences-title" className="text-xl font-black text-[var(--ik-ink)]">Preferiti e valutazioni</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {preferences.map((preference) => {
                const title = getRecipeById(preference.recipeId)?.title ?? preference.recipeId;
                return (
                  <li key={preference.recipeId} className="rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-4">
                    <p className="font-bold text-[var(--ik-ink)]">{title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm font-semibold text-[var(--ik-ink-muted)]">
                      {preference.favorite && <span className="inline-flex items-center gap-1"><Heart size={16} fill="currentColor" aria-hidden="true" /> Preferita</span>}
                      {preference.rating !== null && <span className="inline-flex items-center gap-1"><Star size={16} fill="currentColor" aria-hidden="true" /> {preference.rating}/5</span>}
                    </div>
                    {preference.note !== null && <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Nota privata: {preference.note}</p>}
                  </li>
                );
              })}
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
