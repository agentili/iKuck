import { ArrowLeft, ChefHat, Clock, ShoppingCart, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getIngredient } from '../domain/ingredients';
import { getRecipeById } from '../domain/recipes';
import type { RecipeCategory } from '../domain/types';
import { usePantryStore } from '../store/localPantryStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import NotFoundPage from './NotFoundPage';

const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  meat: 'Carne',
  fish: 'Pesce',
  eggs: 'Uova',
  legumes: 'Legumi',
  vegetables: 'Verdure',
};

export default function RecipeDetailPage() {
  const { recipeId = '' } = useParams();
  const recipe = getRecipeById(recipeId);
  const [shoppingMessage, setShoppingMessage] = useState<string | null>(null);
  const availableIds = usePantryStore((state) => state.getAvailableIngredientIds());
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);

  if (!recipe) return <NotFoundPage />;

  const addMissingToShoppingList = () => {
    const added = addMissingRecipeIngredients(recipe, availableIds);
    setShoppingMessage(added > 0
      ? `${added} ${added === 1 ? 'ingrediente aggiunto' : 'ingredienti aggiunti'} alla lista.`
      : 'Non ci sono nuovi ingredienti mancanti da aggiungere.');
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 py-2 font-semibold text-emerald-800 hover:bg-emerald-50">
        <ArrowLeft size={18} aria-hidden="true" />
        Torna alla dispensa
      </Link>

      <header className="mt-6 rounded-3xl bg-gray-950 px-5 py-8 text-white sm:px-9 sm:py-10">
        <p className="font-semibold text-amber-300">{CATEGORY_LABELS[recipe.category]}</p>
        <h1 className="mt-2 max-w-3xl text-4xl font-black leading-tight sm:text-6xl">{recipe.title}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-gray-300">{recipe.description}</p>
        <dl className="mt-7 flex flex-wrap gap-3">
          <div className="flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-4 py-2">
            <Clock size={18} aria-hidden="true" />
            <dt className="sr-only">Tempo</dt>
            <dd>{recipe.durationMinutes} min</dd>
          </div>
          <div className="flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-4 py-2">
            <Users size={18} aria-hidden="true" />
            <dt className="sr-only">Porzioni</dt>
            <dd>{recipe.servings} porzioni</dd>
          </div>
          <div className="flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-4 py-2">
            <ChefHat size={18} aria-hidden="true" />
            <dt className="sr-only">Difficoltà</dt>
            <dd>{recipe.difficulty === 'easy' ? 'Facile' : 'Media'}</dd>
          </div>
        </dl>
      </header>

      <div className="grid gap-8 py-10 lg:grid-cols-[0.9fr_1.1fr]">
        <section aria-labelledby="ingredients-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="ingredients-title" className="text-3xl font-black text-gray-950">Ingredienti</h2>
            <button type="button" onClick={addMissingToShoppingList} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-800">
              <ShoppingCart size={17} aria-hidden="true" /> Aggiungi mancanti alla spesa
            </button>
          </div>
          {shoppingMessage !== null && (
            <div className="mt-3 rounded-2xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
              <p role="status">{shoppingMessage}</p>
              <Link to="/shopping-list" className="mt-2 inline-flex min-h-10 items-center rounded-lg font-bold underline underline-offset-2">Apri la lista della spesa</Link>
            </div>
          )}
          <ul className="mt-5 divide-y divide-gray-200 rounded-3xl border-2 border-gray-200 bg-white px-5">
            {recipe.ingredients.map((item) => (
              <li key={item.ingredientId} className="flex items-start justify-between gap-4 py-4">
                <span className="font-semibold text-gray-900">{getIngredient(item.ingredientId)?.label}</span>
                <span className="text-right text-gray-600">{item.amount}{item.optional ? ' · facoltativo' : ''}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="steps-title">
          <h2 id="steps-title" className="text-3xl font-black text-gray-950">Preparazione</h2>
          <ol className="mt-5 space-y-4">
            {recipe.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[2.75rem_1fr] gap-4 rounded-3xl bg-emerald-50 p-5">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-emerald-700 font-black text-white" aria-hidden="true">{index + 1}</span>
                <p className="pt-2 leading-relaxed text-gray-800">{step}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
