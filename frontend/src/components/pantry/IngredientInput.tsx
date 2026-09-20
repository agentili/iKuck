import { type FormEvent, type KeyboardEvent, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { INGREDIENTS, normalizeIngredientName, parseIngredientInput } from '../../domain/ingredients';
import type { ParsedIngredient } from '../../domain/types';

interface IngredientInputProps {
  onAdd: (items: ParsedIngredient[]) => void;
}

export default function IngredientInput({ onAdd }: IngredientInputProps) {
  const [value, setValue] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
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
    setSuggestionsOpen(false);
    setActiveSuggestionIndex(-1);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitValue(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!suggestionsOpen) return;
      event.preventDefault();
      setSuggestionsOpen(false);
      setActiveSuggestionIndex(-1);
      return;
    }

    if (!suggestionsOpen || suggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestionIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestionIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
      event.preventDefault();
      const activeSuggestion = suggestions[activeSuggestionIndex];
      if (activeSuggestion !== undefined) handleSuggestion(activeSuggestion.label);
    }
  };

  const handleSuggestion = (label: string) => {
    const parts = value.split(/[,;\n]/);
    parts[parts.length - 1] = label;
    submitValue(parts.join(','));
  };

  const showSuggestions = suggestionsOpen && suggestions.length > 0;
  const activeSuggestion = activeSuggestionIndex >= 0 ? suggestions[activeSuggestionIndex] : undefined;

  return (
    <form onSubmit={handleSubmit} className="relative space-y-3">
      <label htmlFor="pantry-input" className="block text-sm font-semibold text-gray-700">
        Ingredienti presenti
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id="pantry-input"
          role="combobox"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSuggestionsOpen(true);
            setActiveSuggestionIndex(-1);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setSuggestionsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          aria-autocomplete="list"
          aria-controls="pantry-suggestions"
          aria-expanded={showSuggestions}
          aria-activedescendant={activeSuggestion === undefined ? undefined : `pantry-suggestion-${activeSuggestion.id}`}
          aria-describedby="pantry-input-help"
          placeholder="es. pasta, pomodori, tonno"
          autoComplete="off"
          className="min-h-12 flex-1 rounded-2xl border-2 border-gray-200 bg-white px-4 py-3 text-base text-gray-900 outline-none transition focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100"
        />
        <button type="submit" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-emerald-700 px-5 py-3 font-semibold text-white transition hover:bg-emerald-800">
          <Plus size={19} aria-hidden="true" />
          Aggiungi ingredienti
        </button>
      </div>
      <p id="pantry-input-help" className="text-sm text-gray-600">Separa più ingredienti con una virgola. Puoi usare anche le frecce e Invio per scegliere un suggerimento.</p>
      {showSuggestions && (
        <ul id="pantry-suggestions" role="listbox" aria-label="Ingredienti suggeriti" className="absolute left-0 right-0 z-20 grid gap-1 rounded-2xl border border-gray-200 bg-white p-2 shadow-xl sm:right-auto sm:min-w-72">
          {suggestions.map((ingredient) => (
            <li
              key={ingredient.id}
              id={`pantry-suggestion-${ingredient.id}`}
              role="option"
              aria-selected={ingredient.id === activeSuggestion?.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => handleSuggestion(ingredient.label)}
              className={`flex min-h-11 cursor-pointer items-center rounded-xl px-3 py-2 text-left font-medium text-gray-800 hover:bg-emerald-50 ${ingredient.id === activeSuggestion?.id ? 'bg-emerald-100' : ''}`}
            >
              {ingredient.label}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
