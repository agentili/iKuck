import React, { useEffect, useState } from 'react';
import * as api from '../utils/apiClient';
import { RecipeHistory, ApiResponse } from '../types';
import { Star, Clock, ChefHat } from 'lucide-react';

const HistoryPage: React.FC = () => {
  const [history, setHistory] = useState<RecipeHistory[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await api.get<ApiResponse<RecipeHistory[]>>('/recipes/history');
        if (res.success && res.data) {
          setHistory(res.data);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchHistory();
  }, []);

  if (isLoading) return <div className="p-8 text-center animate-pulse">Caricamento storico...</div>;

  return (
    <div className="flex flex-col min-h-screen bg-gray-50 pb-24">
      <header className="p-4 bg-white border-b sticky top-0 z-10">
        <h1 className="text-2xl font-bold text-gray-800">Le mie cene</h1>
      </header>

      <main className="p-4 space-y-4">
        {history.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p>Non hai ancora cucinato nulla.</p>
            <p className="text-sm">Inizia con un suggerimento!</p>
          </div>
        ) : (
          history.map((item) => (
            <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-bold text-gray-800">{item.title}</h3>
                <span className="text-xs text-gray-400">
                  {new Date(item.completed_date).toLocaleDateString()}
                </span>
              </div>
              
              <div className="flex items-center space-x-4 mb-3 text-xs text-gray-500">
                <div className="flex items-center">
                  <Star size={14} className="text-amber-400 mr-1" fill="#fbbf24" />
                  <span className="font-bold text-gray-700">{item.rating || '-'}</span>
                </div>
                <div className="flex items-center capitalize">
                  {item.meal_type}
                </div>
              </div>

              {item.notes && (
                <p className="text-sm text-gray-600 bg-gray-50 p-2 rounded italic">
                  "{item.notes}"
                </p>
              )}
            </div>
          ))
        )}
      </main>
    </div>
  );
};

export default HistoryPage;
