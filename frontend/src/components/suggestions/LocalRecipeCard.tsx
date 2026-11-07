import { Clock, ShoppingBasket, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getIngredient } from '@ikuck/shared/ingredients';
import { getRecipeMetadata } from '../../domain/recipeMetadata';
import type { RecipeCategory, RecipeSuggestion } from '../../domain/types';
import RecipeNutritionSummary from '../diet/RecipeNutritionSummary';
import RecipeImage from './RecipeImage';
import { Button } from '../../components/shared';

const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  meat: 'Carne',
  fish: 'Pesce',
  eggs: 'Uova',
  legumes: 'Legumi',
  vegetables: 'Verdure',
  diary: 'Dal diario',
};

interface LocalRecipeCardProps {
  suggestion: RecipeSuggestion;
  missingIngredientInShoppingList?: boolean;
  onAddMissingIngredient?: (suggestion: RecipeSuggestion) => void;
}

export default function LocalRecipeCard({ suggestion, missingIngredientInShoppingList = false, onAddMissingIngredient }: LocalRecipeCardProps) {
  const missingId = suggestion.missingIngredientIds[0];
  const missingLabel = missingId ? getIngredient(missingId)?.label ?? suggestion.recipe.ingredients.find((item) => item.ingredientId === missingId)?.name ?? missingId : null;
  const metadata = getRecipeMetadata(suggestion.recipe.id);
  const categoryLabel = suggestion.recipe.category === 'diary' ? 'Dal diario' : CATEGORY_LABELS[suggestion.recipe.category];
  const detailHref = suggestion.recipe.diary === undefined
    ? `/recipes/${suggestion.recipe.id}`
    : `/recipes/${encodeURIComponent(suggestion.recipe.diary.savedRecipeId)}?scope=${encodeURIComponent(suggestion.recipe.diary.scope)}`;
  const availability = missingLabel ? 'one-missing' : 'ready';
  const titleId = `recipe-title-${suggestion.recipe.id}`;

  return (
    <article aria-labelledby={titleId} data-availability={availability} className="ik-recipe-card flex flex-col rounded-3xl border-2 p-5">
      <RecipeImage recipeId={suggestion.recipe.id} recipeTitle={suggestion.recipe.title} />
      <p className="mb-4 flex items-center gap-2 font-semibold">
        {missingLabel ? <ShoppingBasket size={18} aria-hidden="true" /> : null}
        {missingLabel ? `Ti manca solo: ${missingLabel}` : suggestion.quantityWarnings.length > 0 ? 'Verifica le quantità' : 'Hai tutto'}
      </p>
      <h3 id={titleId} className="text-xl font-bold leading-tight text-[var(--color-text)]">{suggestion.recipe.title}</h3>
      <p className="mt-2 flex-1 leading-relaxed text-[var(--color-text-muted)]">{suggestion.recipe.description}</p>
      {metadata !== undefined && <RecipeNutritionSummary nutrition={metadata.nutrition} />}
      {suggestion.quantityWarnings.length > 0 && (
        <p className="mt-3 rounded-xl bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-[var(--color-on-primary-action)]">
          La quantità potrebbe non bastare per: {suggestion.quantityWarnings.map((id) => getIngredient(id)?.label ?? id).join(', ')}.
        </p>
      )}
      <dl className="mt-5 flex items-center gap-4 text-sm text-[var(--color-text-muted)]">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Tempo</dt>
          <Clock size={17} aria-hidden="true" />
          <dd>{suggestion.recipe.durationMinutes === null ? 'Tempo non indicato' : `${suggestion.recipe.durationMinutes} min`}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Porzioni</dt>
          <Users size={17} aria-hidden="true" />
          <dd>{suggestion.recipe.servings === null ? 'Porzioni non indicate' : `${suggestion.recipe.servings} porzioni`}</dd>
        </div>
        <div>
          <dt className="sr-only">Categoria</dt>
          <dd>{categoryLabel}</dd>
        </div>
      </dl>
      <div className="mt-5 flex flex-wrap gap-2">
        {missingLabel && onAddMissingIngredient !== undefined && (
          missingIngredientInShoppingList ? (
            <Link to="/shopping-list" aria-label="Apri lista della spesa" className="ik-button-secondary min-h-11 flex-1">
              Già nella lista · Apri lista
            </Link>
          ) : (
            <Button onClick={() => onAddMissingIngredient(suggestion)} aria-label={`Aggiungi ${missingLabel} alla lista della spesa`} className="min-h-11 flex-1">
              <ShoppingBasket size={18} aria-hidden="true" />
              Aggiungi alla lista
            </Button>
          )
        )}
        <Link to={detailHref} aria-label={`Apri ${suggestion.recipe.title}`} className="ik-button-secondary min-h-11 flex-1">
          Apri ricetta
        </Link>
      </div>
    </article>
  );
}