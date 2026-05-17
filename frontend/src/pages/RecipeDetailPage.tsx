import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSuggestionStore } from '../store/suggestionStore';
import InstructionsSection from '../components/recipe/InstructionsSection';
import RatingModal from '../components/recipe/RatingModal';
import { Clock, ChefHat, Users, Check } from 'lucide-react';
import * as api from '../utils/apiClient';
import { ApiResponse } from '../types';

const RecipeDetailPage: React.FC = () => {
  const { recipeId } = useParams<{ recipeId: string }>();
  const navigate = useNavigate();
  const { suggestions } = useSuggestionStore();
  const [recipe, setRecipe] = useState<any>(null);
  const [isRatingModalOpen, setIsRatingModalOpen] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);

  useEffect(() => {
    const found = suggestions.find((s) => s.id === recipeId);
    if (found) {
      setRecipe(found);
    } else {
      // Fallback: fetch from API if not in store
      // For now just redirect
      // navigate('/suggest');
    }
  }, [recipeId, suggestions, navigate]);

  if (!recipe) return <div className="p-8 text-center">Caricamento...</div>;

  const handleComplete = async () => {
    try {
      const res = await api.post<ApiResponse<any>>('/recipes/history', {
        recipeId: recipe.id,
        mealType: 'dinner',
        completedDate: new Date().toISOString(),
      });
      if (res.success && res.data) {
        setHistoryId(res.data.id);
        setIsRatingModalOpen(true);
      }
    } catch (err) {
      console.error(err);
      alert('Errore nel salvare lo storico.');
    }
  };

  const handleRatingSubmit = async (rating: number, notes: string) => {
    if (!historyId) return;
    try {
      await api.put(`/recipes/history/${historyId}`, { rating, notes });
      navigate('/suggest');
    } catch (err) {
      console.error(err);
      alert('Errore nel salvare il rating.');
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-white pb-24">
      <header className="p-4 bg-gray-50 border-b">
        <button onClick={() => navigate(-1)} className="text-primary font-semibold mb-2">← Indietro</button>
        <h1 className="text-3xl font-bold text-gray-800 leading-tight">{recipe.title}</h1>
      </header>

      <main className="p-4 space-y-8">
        {/* Info Grid */}
        <div className="grid grid-cols-3 gap-2 py-4 border-b border-gray-100">
          <div className="flex flex-col items-center">
            <Clock size={20} className="text-primary mb-1" />
            <span className="text-xs text-gray-500 font-medium">Tempo</span>
            <span className="font-bold">{recipe.preparation_time} min</span>
          </div>
          <div className="flex flex-col items-center">
            <ChefHat size={20} className="text-primary mb-1" />
            <span className="text-xs text-gray-500 font-medium">Difficoltà</span>
            <span className="font-bold">{recipe.difficulty === 'easy' ? 'Facile' : 'Media'}</span>
          </div>
          <div className="flex flex-col items-center">
            <Users size={20} className="text-primary mb-1" />
            <span className="text-xs text-gray-500 font-medium">Porzioni</span>
            <span className="font-bold">{recipe.servings}</span>
          </div>
        </div>

        {/* Ingredients */}
        <section>
          <h2 className="text-xl font-bold text-gray-800 mb-4">Ingredienti</h2>
          <ul className="space-y-3">
            {recipe.ingredients.map((ing: any, idx: number) => (
              <li key={idx} className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
                <div className="w-5 h-5 rounded border border-gray-300 flex items-center justify-center bg-white">
                  <Check size={14} className="text-primary" />
                </div>
                <span className="flex-1 text-gray-700">
                  <span className="font-bold">{ing.quantity} {ing.unit}</span> {ing.name}
                </span>
                {ing.isOptional && <span className="text-xs text-gray-400 italic">Opzionale</span>}
              </li>
            ))}
          </ul>
        </section>

        {/* Instructions */}
        <InstructionsSection instructions={recipe.instructions} />

        {/* Complete Button */}
        <button
          onClick={handleComplete}
          className="w-full py-4 bg-primary text-white font-bold rounded-xl shadow-lg hover:bg-emerald-700 transition-all active:scale-95"
        >
          Ho finito di cucinare!
        </button>
      </main>

      <RatingModal
        isOpen={isRatingModalOpen}
        onClose={() => navigate('/suggest')}
        onSubmit={handleRatingSubmit}
      />
    </div>
  );
};

export default RecipeDetailPage;
