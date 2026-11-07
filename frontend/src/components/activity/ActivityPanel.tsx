import { Heart, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { getRecipeById } from '../../domain/recipes';
import UndoToast from '../feedback/UndoToast';
import EmptyState from '../ui/EmptyState';
import PageSection from '../ui/PageSection';
import { Button } from '../../components/shared';

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
          <Button variant="secondary" size="sm" onClick={clearActivity}>
            Svuota attività
          </Button>
        ) : undefined
      }
    >
      <div className="mt-6 grid gap-6">
        <section aria-labelledby="cooking-history-title" className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6">
          <h2 id="cooking-history-title" className="text-xl font-black text-[var(--color-text)]">Ricette cucinate</h2>
          {events.length === 0 ? (
            <EmptyState text="Non hai ancora segnato ricette come cucinate." />
          ) : (
            <ul className="mt-3 grid gap-3">
              {events.map((event) => (
                <li key={event.id} className="ik-card p-4 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-[var(--color-text)]">{event.recipeTitle}</p>
                    <p className="mt-1 text-sm text-[var(--color-text-muted)]">{formatDate(event.cookedAt)} · {event.servings} {event.servings === 1 ? 'porzione' : 'porzioni'}</p>
                    {event.note !== null && <p className="mt-2 text-sm text-[var(--color-text-muted)]">Nota: {event.note}</p>}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Rimuovi evento ${event.recipeTitle}`}
                    onClick={() => removeEvent(event.id)}
                  >
                    <Trash2 size={18} aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {preferences.length > 0 && (
          <section aria-labelledby="recipe-preferences-title" className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6">
            <h2 id="recipe-preferences-title" className="text-xl font-black text-[var(--color-text)]">Preferiti e valutazioni</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {preferences.map((preference) => {
                const title = getRecipeById(preference.recipeId)?.title ?? preference.recipeId;
                return (
                  <li key={preference.recipeId} className="ik-card p-4">
                    <p className="font-bold text-[var(--color-text)]">{title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm font-semibold text-[var(--color-text-muted)]">
                      {preference.favorite && <span className="inline-flex items-center gap-1"><Heart size={16} fill="currentColor" aria-hidden="true" /> Preferita</span>}
                      {preference.rating !== null && <span className="inline-flex items-center gap-1"><Star size={16} fill="currentColor" aria-hidden="true" /> {preference.rating}/5</span>}
                    </div>
                    {preference.note !== null && <p className="mt-2 text-sm text-[var(--color-text-muted)]">Nota privata: {preference.note}</p>}
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