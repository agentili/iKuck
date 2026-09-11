import { FormEvent, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { INGREDIENTS, normalizeIngredientName, parseIngredientInput } from '../../domain/ingredients';
import type { ParsedIngredient } from '../../domain/types';

interface IngredientInputProps {
  onAdd: (items: ParsedIngredient[]) => void;
}

export default function IngredientInput({ onAdd }: IngredientInputProps) {
  const [value, setValue] = useState('');
  const suggestions = useMemo(() => {
    const currentToken = value.split(/[,;\n]/).at(-1)?.trim() ?? '';
    const normalizedToken = normalizeIngredientName(currentToken);
    if (normalizedToken.length < 2) return [];

    return INGREDIENTS.filter((ingredient) =>
      !ingredient.staple &&
      [ingredient.label, ...ingredient.aliases].some((candidate) =>
        normalizeIngredientName(candidate).startsWith(normalizedToken),
      ),
    ).slice(0, 5);
  }, [value]);

  const submitValue = (nextValue: string) => {
    const items = parseIngredientInput(nextValue);
    if (items.length === 0) return;
    onAdd(items);
    setValue('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitValue(value);
  };

  const handleSuggestion = (label: string) => {
    const parts = value.split(/[,;\n]/);
    parts[parts.length - 1] = label;
    submitValue(parts.join(','));
  };

  return (
    <form onSubmit={handleSubmit} className="relative space-y-3">
      <label htmlFor="pantry-input" className="block text-sm font-semibold text-gray-700">
        Ingredienti presenti
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="pantry-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="es. pasta, pomodori, tonno"
          autoComplete="off"
          className="min-h-12 flex-1 rounded-2xl border-2 border-gray-200 bg-white px-4 py-3 text-base text-gray-900 outline-none transition focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100"
        />
        <button type="submit" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-emerald-700 px-5 py-3 font-semibold text-white transition hover:bg-emerald-800">
          <Plus size={19} aria-hidden="true" />
          Aggiungi ingredienti
        </button>
      </div>
      {suggestions.length > 0 && (
        <ul aria-label="Ingredienti suggeriti" className="absolute left-0 right-0 z-20 grid gap-1 rounded-2xl border border-gray-200 bg-white p-2 shadow-xl sm:right-auto sm:min-w-72">
          {suggestions.map((ingredient) => (
            <li key={ingredient.id}>
              <button type="button" onClick={() => handleSuggestion(ingredient.label)} className="min-h-11 w-full rounded-xl px-3 py-2 text-left font-medium text-gray-800 hover:bg-emerald-50">
                {ingredient.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
