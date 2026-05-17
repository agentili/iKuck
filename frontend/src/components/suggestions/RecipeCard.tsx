import React from 'react';
import { Suggestion } from '../../types';
import { Clock, ChefHat, CheckCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface RecipeCardProps {
  recipe: Suggestion;
}

const RecipeCard: React.FC<RecipeCardProps> = ({ recipe }) => {
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-5">
        <div className="flex justify-between items-start mb-2">
          <h3 className="text-lg font-bold text-gray-800 leading-tight">{recipe.title}</h3>
          {recipe.wasExecuted && (
            <span className="flex items-center text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
              <CheckCircle size={12} className="mr-1" /> Già preparata
            </span>
          )}
        </div>

        <div className="flex items-center space-x-4 mb-4 text-sm text-gray-500">
          <div className="flex items-center">
            <Clock size={16} className="mr-1" />
            {recipe.preparation_time} min
          </div>
          <div className="flex items-center">
            <ChefHat size={16} className="mr-1" />
            <span className={recipe.difficulty === 'easy' ? 'text-green-600' : 'text-orange-600'}>
              {recipe.difficulty === 'easy' ? 'Facile' : 'Media'}
            </span>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Match ingredienti</span>
            <span>{Math.round(recipe.matchPct)}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-1.5">
            <div
              className="bg-primary h-1.5 rounded-full"
              style={{ width: `${recipe.matchPct}%` }}
            ></div>
          </div>
        </div>

        <button
          onClick={() => navigate(`/recipe/${recipe.id}`)}
          className="w-full py-2 bg-primary text-white font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
        >
          Cucina questa →
        </button>
      </div>
    </div>
  );
};

export default RecipeCard;
