import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, MoreHorizontal, X } from 'lucide-react';
import { RECIPES, getRecipeById } from '../domain/recipes';
import { usePantryStore } from '../store/localPantryStore';
import RecipeImage from '../components/suggestions/RecipeImage';
import EmptyState from '../components/ui/EmptyState';
import { Button } from '../components/shared';

const addDays = (date: Date, days: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const startOfWeek = (date: Date): Date => {
  const result = new Date(date);
  const day = result.getDay();
  const diff = result.getDate() - day + (day === 0 ? -6 : 1);
  result.setDate(diff);
  result.setHours(0, 0, 0, 0);
  return result;
};

const isSameDay = (a: Date, b: Date): boolean => {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

const isPast = (date: Date): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today && !isSameDay(date, today);
};

export default function MealPlanPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [weekPlan, setWeekPlan] = useState<Record<string, { recipeId: string | null; servings: number }>>({});
  const [showRecipePicker, setShowRecipePicker] = useState<string | null>(null);
  const pantryItems = usePantryStore((state) => state.pantryItems);

  const weekDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart);
      day.setDate(weekStart.getDate() + i);
      days.push(day);
    }
    return days;
  }, [weekStart]);

  const availableIngredients = useMemo(() => {
    const ids = new Set<string>();
    pantryItems.forEach((item) => ids.add(item.id));
    return ids;
  }, [pantryItems]);

  const availableRecipes = useMemo(() => {
    return RECIPES.filter((recipe) => {
      return recipe.ingredients.every((ing) => availableIngredients.has(ing.ingredientId));
    });
  }, [availableIngredients]);

  const dayHasPlan = (day: Date): boolean => {
    const dayKey = day.toISOString().split('T')[0];
    return !!weekPlan[dayKey]?.recipeId;
  };

  const getDayPlan = (day: Date) => {
    const dayKey = day.toISOString().split('T')[0];
    const plan = weekPlan[dayKey];
    return plan?.recipeId ? getRecipeById(plan.recipeId!) : null;
  };

  const assignRecipe = (day: Date, recipeId: string | null) => {
    const dayKey = day.toISOString().split('T')[0];
    setWeekPlan((prev) => ({
      ...prev,
      [dayKey]: { ...prev[dayKey], recipeId, servings: recipeId ? 2 : 0 },
    }));
    if (showRecipePicker === dayKey) setShowRecipePicker(null);
  };

  const clearDay = (day: Date) => {
    const dayKey = day.toISOString().split('T')[0];
    setWeekPlan((prev) => {
      const next = { ...prev };
      delete next[dayKey];
      return next;
    });
  };

  return (
    <main className="ik-page mx-auto min-h-screen w-full max-w-4xl px-4 pb-8 pt-5 sm:px-6 sm:pt-8">
      <header className="ik-page-intro mb-5 max-w-2xl">
        <p className="ik-eyebrow">Organizza i pasti</p>
        <h1 className="mt-1">Piano della settimana</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-[var(--color-text-muted)]">
          Pianifica i pasti per la settimana. Tocca un giorno per aggiungere una ricetta.
        </p>
      </header>

      <div className="ik-surface rounded-[var(--radius-panel)] border-2 border-[var(--color-border)] p-4 shadow-sm mb-6">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Settimana precedente">
            <ChevronLeft size={20} aria-hidden="true" />
          </Button>
          <h2 className="text-lg font-bold text-[var(--color-text)] text-center flex-1">
            {weekStart.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })} - {addDays(weekStart, 6).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Settimana successiva">
            <ChevronRight size={20} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {weekDays.map((day) => {
          const dayKey = day.toISOString().split('T')[0];
          const weekDayNames = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
          const isTodayDay = isSameDay(day, new Date());
          const isPastDay = isPast(day);
          const plan = getDayPlan(day);
          const hasPlan = dayHasPlan(day);

          return (
            <article
              key={dayKey}
              className={`ik-card p-4 relative ${isTodayDay ? 'border-2 border-[var(--color-primary)]' : ''} ${isPastDay ? 'opacity-60' : ''}`}
            >
              {isTodayDay && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-[var(--color-primary)] text-[var(--color-on-primary-action)] text-xs font-semibold px-2 py-0.5 rounded-full">
                  Oggi
                </span>
              )}
              <header className="mb-3">
                <time dateTime={dayKey} className="text-sm font-semibold text-[var(--color-text)]">
                  {weekDayNames[day.getDay()]}
                </time>
                <p className="text-xs text-[var(--color-text-muted)]">{day.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}</p>
              </header>

              {hasPlan && plan ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <RecipeImage recipeId={plan.id} recipeTitle={plan.title} variant="card" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[var(--color-text)] truncate">{plan.title}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {plan.durationMinutes ? `${plan.durationMinutes} min` : 'Tempo non indicato'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); clearDay(day); }}
                      aria-label={`Rimuovi ${plan.title} da ${weekDayNames[day.getDay()]}`}
                    >
                      <X size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowRecipePicker(day.toISOString().split('T')[0])}
                      aria-label={`Cambia ricetta per ${weekDayNames[day.getDay()]}`}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4">
                  <p className="text-sm text-[var(--color-text-muted)] mb-3">
                    {isPastDay ? 'Giorno passato' : 'Nessun pasto pianificato'}
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowRecipePicker(day.toISOString().split('T')[0])}
                    disabled={isPastDay}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Aggiungi ricetta
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {showRecipePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="ik-surface rounded-[var(--radius-panel)] border-2 border-[var(--color-border)] w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
            <header className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <h2 className="text-lg font-bold text-[var(--color-text)]">Scegli una ricetta</h2>
              <Button variant="ghost" size="sm" onClick={() => setShowRecipePicker(null)} aria-label="Chiudi">
                <X size={20} aria-hidden="true" />
              </Button>
            </header>
            <div className="p-4 overflow-y-auto flex-1">
              {availableRecipes.length === 0 ? (
                <EmptyState text="Nessuna ricetta realizzabile con la dispensa attuale." />
              ) : (
                <ul className="space-y-2">
                  {availableRecipes.map((recipe) => (
                    <li key={recipe.id}>
                      <Button
                        variant="secondary"
                        className="w-full justify-start gap-3 p-3"
                        onClick={() => assignRecipe(new Date(showRecipePicker!), recipe.id)}
                      >
                        <RecipeImage recipeId={recipe.id} recipeTitle={recipe.title} variant="card" />
                        <div className="text-left">
                          <p className="font-semibold text-[var(--color-text)]">{recipe.title}</p>
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {recipe.durationMinutes ? `${recipe.durationMinutes} min` : 'Tempo non indicato'} · {recipe.servings} porzioni
                          </p>
                        </div>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}