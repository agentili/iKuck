import { Clock3, Heart, Star, Trash2 } from 'lucide-react';
import type { CookEvent, RecipePreference } from '@ikuck/shared/contracts';
import { getRecipeById } from '../../domain/recipes';

interface ActivityPanelProps {
  events: CookEvent[];
  preferences: RecipePreference[];
  onRemoveEvent: (id: string) => boolean;
  onClearActivity: () => number;
}

const formatDate = (value: string): string => new Intl.DateTimeFormat('it-IT', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value));

export default function ActivityPanel({ events, preferences, onRemoveEvent, onClearActivity }: ActivityPanelProps) {
  return (
    <section aria-labelledby="activity-title" className="rounded-3xl border-2 border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-emerald-800"><Clock3 size={16} aria-hidden="true" /> Attività</p>
          <h1 id="activity-title" className="mt-1 text-3xl font-black text-gray-950">La tua attività</h1>
          <p className="mt-1 text-gray-600">Tieni traccia delle ricette provate e delle tue preferenze.</p>
        </div>
        {events.length > 0 && (
          <button type="button" onClick={onClearActivity} className="min-h-11 rounded-xl border-2 border-gray-300 px-3 py-2 text-sm font-bold text-gray-800 hover:border-gray-900">
            Svuota attività
          </button>
        )}
      </header>

      <div className="mt-6 grid gap-6">
        <section aria-labelledby="cooking-history-title">
          <h2 id="cooking-history-title" className="text-xl font-black text-gray-950">Ricette cucinate</h2>
          {events.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-dashed border-gray-300 p-5 text-gray-600">Non hai ancora segnato ricette come cucinate.</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {events.map((event) => (
                <li key={event.id} className="flex items-start gap-3 rounded-2xl border-2 border-gray-200 bg-gray-50 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-gray-950">{event.recipeTitle}</p>
                    <p className="mt-1 text-sm text-gray-600">{formatDate(event.cookedAt)} · {event.servings} {event.servings === 1 ? 'porzione' : 'porzioni'}</p>
                    {event.note !== null && <p className="mt-2 text-sm text-gray-700">Nota: {event.note}</p>}
                  </div>
                  <button type="button" aria-label={`Rimuovi evento ${event.recipeTitle}`} onClick={() => onRemoveEvent(event.id)} className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-600 hover:bg-rose-50 hover:text-rose-700">
                    <Trash2 size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {preferences.length > 0 && (
          <section aria-labelledby="recipe-preferences-title">
            <h2 id="recipe-preferences-title" className="text-xl font-black text-gray-950">Preferiti e valutazioni</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {preferences.map((preference) => {
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
              })}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
