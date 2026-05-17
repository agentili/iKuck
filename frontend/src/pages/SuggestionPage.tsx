import React, { useEffect } from 'react';
import { useSuggestionStore } from '../store/suggestionStore';
import { usePantryStore } from '../store/pantryStore';
import MealTypeSelector from '../components/suggestions/MealTypeSelector';
import RecipeCard from '../components/suggestions/RecipeCard';
import { RefreshCw, LayoutGrid } from 'lucide-react';
import { Link } from 'react-router-dom';

const SuggestionPage: React.FC = () => {
  const { suggestions, mealType, isLoading, setMealType, fetchSuggestions } = useSuggestionStore();
  const { items: pantryItems } = usePantryStore();

  useEffect(() => {
    fetchSuggestions(mealType);
  }, [fetchSuggestions, mealType]);

  const handleRefresh = () => {
    fetchSuggestions(mealType);
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <header className="p-4 bg-white border-b sticky top-0 z-10 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-800">Cosa ceno?</h1>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="p-2 text-gray-500 hover:text-primary disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={20} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </header>

      <main className="flex-1 p-4 space-y-6">
        <MealTypeSelector selected={mealType} onChange={setMealType} />

        {pantryItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
            <LayoutGrid size={48} className="text-gray-300" />
            <div>
              <p className="text-lg font-semibold text-gray-700">La tua dispensa è vuota</p>
              <p className="text-sm text-gray-500">Aggiungi degli ingredienti per ricevere suggerimenti.</p>
            </div>
            <Link
              to="/pantry"
              className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-emerald-700"
            >
              Vai alla dispensa
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {isLoading ? (
              [1, 2, 3].map((n) => (
                <div key={n} className="h-64 bg-gray-200 animate-pulse rounded-xl"></div>
              ))
            ) : suggestions.length === 0 ? (
              <div className="col-span-full text-center py-12 text-gray-500">
                <p>Nessun suggerimento trovato con i tuoi ingredienti.</p>
                <p className="text-sm">Prova ad aggiungere altro in dispensa.</p>
              </div>
            ) : (
              suggestions.map((recipe) => (
                <RecipeCard key={recipe.id} recipe={recipe} />
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default SuggestionPage;
