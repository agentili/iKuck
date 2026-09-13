import { ArrowLeft, ChefHat, Clock, Heart, ShoppingCart, Star, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getIngredient } from '../domain/ingredients';
import { ALLERGEN_LABELS } from '../domain/dietary';
import { getRecipeMetadata } from '../domain/recipeMetadata';
import { getRecipeById } from '../domain/recipes';
import type { RecipeCategory } from '../domain/types';
import { usePantryStore } from '../store/localPantryStore';
import { useShoppingListStore } from '../store/shoppingListStore';
import { useActivityStore } from '../store/activityStore';
import NotFoundPage from './NotFoundPage';
import RecipeNutritionSummary from '../components/diet/RecipeNutritionSummary';

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
  const [activityMessage, setActivityMessage] = useState<string | null>(null);
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [privateNote, setPrivateNote] = useState('');
  const availableIds = usePantryStore((state) => state.getAvailableIngredientIds());
  const addMissingRecipeIngredients = useShoppingListStore((state) => state.addMissingRecipeIngredients);
  const preferences = useActivityStore((state) => state.preferences);
  const recordCookEvent = useActivityStore((state) => state.recordCookEvent);
  const setRecipePreference = useActivityStore((state) => state.setRecipePreference);
  const currentPreference = recipe === undefined ? undefined : preferences.find((item) => item.recipeId === recipe.id);

  useEffect(() => {
    setFavorite(currentPreference?.favorite ?? false);
    setRating(currentPreference?.rating ?? null);
    setPrivateNote(currentPreference?.note ?? '');
  }, [currentPreference]);

  if (!recipe) return <NotFoundPage />;
  const metadata = getRecipeMetadata(recipe.id);

  const addMissingToShoppingList = () => {
    const added = addMissingRecipeIngredients(recipe, availableIds);
    setShoppingMessage(added > 0
      ? `${added} ${added === 1 ? 'ingrediente aggiunto' : 'ingredienti aggiunti'} alla lista.`
      : 'Non ci sono nuovi ingredienti mancanti da aggiungere.');
  };

  const markAsCooked = () => {
    if (recipe === undefined) return;
    const eventId = recordCookEvent(recipe);
    setActivityMessage(eventId === null ? 'Non è stato possibile aggiornare la cronologia.' : 'Ricetta aggiunta alla cronologia.');
  };

  const savePreference = () => {
    if (recipe === undefined) return;
    const saved = setRecipePreference(recipe.id, favorite, rating, privateNote);
    setPreferenceMessage(saved ? 'Preferenza salvata.' : 'Controlla la valutazione inserita.');
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

      {metadata !== undefined && (
        <section aria-labelledby="nutrition-title" className="mt-6 rounded-3xl border-2 border-gray-200 bg-white p-5 sm:p-6">
          <h2 id="nutrition-title" className="text-2xl font-black text-gray-950">Nutrizione stimata per porzione</h2>
          <RecipeNutritionSummary nutrition={metadata.nutrition} />
          <p className="mt-3 text-sm font-semibold text-gray-700">
            Allergeni dichiarati: {metadata.allergens.length === 0 ? 'nessuno' : metadata.allergens.map((allergen) => ALLERGEN_LABELS[allergen]).join(', ')}
          </p>
        </section>
      )}

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
          <section aria-labelledby="recipe-actions-title" className="mt-6 rounded-3xl border-2 border-amber-200 bg-amber-50 p-4 sm:p-5">
            <h3 id="recipe-actions-title" className="text-xl font-black text-gray-950">La tua esperienza</h3>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={markAsCooked} className="min-h-11 rounded-xl bg-gray-950 px-4 py-2 font-bold text-white hover:bg-gray-800">
                Segna come cucinata
              </button>
              <button type="button" aria-pressed={favorite} onClick={() => setFavorite((value) => !value)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-amber-300 bg-white px-4 py-2 font-bold text-gray-900 hover:border-amber-500">
                <Heart size={18} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
                {favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
              </button>
            </div>
            {activityMessage !== null && <p role="status" className="mt-3 text-sm font-semibold text-emerald-800">{activityMessage}</p>}
            <div className="mt-5 grid gap-3 border-t border-amber-200 pt-4">
              <span className="text-sm font-bold text-gray-800">Valuta questa ricetta</span>
              <div role="group" aria-label="Valutazione" className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button key={value} type="button" aria-pressed={rating === value} aria-label={`Valuta ${recipe.title}: ${value} stelle`} onClick={() => setRating(value)} className="grid min-h-11 min-w-11 place-items-center rounded-xl text-amber-700 hover:bg-white">
                    <Star size={22} fill={rating !== null && value <= rating ? 'currentColor' : 'none'} aria-hidden="true" />
                  </button>
                ))}
              </div>
              <label htmlFor="private-recipe-note" className="text-sm font-semibold text-gray-800">Nota privata sulla ricetta</label>
              <textarea id="private-recipe-note" value={privateNote} onChange={(event) => setPrivateNote(event.target.value)} maxLength={500} rows={3} placeholder="Cosa vuoi ricordare?" className="rounded-xl border-2 border-amber-200 bg-white px-3 py-2 outline-none focus:border-amber-500" />
              <button type="button" onClick={savePreference} className="min-h-11 w-fit rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Salva preferenza</button>
              {preferenceMessage !== null && <p role="status" className="text-sm font-semibold text-emerald-800">{preferenceMessage}</p>}
            </div>
          </section>
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
