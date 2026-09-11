import { Clock, ShoppingBasket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getIngredient } from '../../domain/ingredients';
import type { RecipeCategory, RecipeSuggestion } from '../../domain/types';

const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  meat: 'Carne',
  fish: 'Pesce',
  eggs: 'Uova',
  legumes: 'Legumi',
  vegetables: 'Verdure',
};

interface LocalRecipeCardProps {
  suggestion: RecipeSuggestion;
}

export default function LocalRecipeCard({ suggestion }: LocalRecipeCardProps) {
  const missingId = suggestion.missingIngredientIds[0];
  const missingLabel = missingId ? getIngredient(missingId)?.label ?? missingId : null;

  return (
    <article className="flex h-full flex-col rounded-3xl border-2 border-gray-200 bg-white p-5">
      <p className={missingLabel ? 'mb-4 flex items-center gap-2 font-semibold text-red-700' : 'mb-4 font-semibold text-emerald-700'}>
        {missingLabel ? <ShoppingBasket size={18} aria-hidden="true" /> : null}
        {missingLabel ? `Ti manca solo: ${missingLabel}` : 'Hai tutto'}
      </p>
      <h3 className="text-xl font-bold leading-tight text-gray-950">{suggestion.recipe.title}</h3>
      <p className="mt-2 flex-1 leading-relaxed text-gray-600">{suggestion.recipe.description}</p>
      <dl className="mt-5 flex items-center gap-4 text-sm text-gray-600">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Tempo</dt>
          <Clock size={17} aria-hidden="true" />
          <dd>{suggestion.recipe.durationMinutes} min</dd>
        </div>
        <div>
          <dt className="sr-only">Categoria</dt>
          <dd>{CATEGORY_LABELS[suggestion.recipe.category]}</dd>
        </div>
      </dl>
      <Link to={`/recipes/${suggestion.recipe.id}`} aria-label={`Apri ${suggestion.recipe.title}`} className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-gray-900 px-4 py-2 font-bold text-gray-900 hover:bg-gray-900 hover:text-white">
        Apri ricetta
      </Link>
    </article>
  );
}
