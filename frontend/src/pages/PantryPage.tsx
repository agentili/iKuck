import React, { useEffect, useState } from 'react';
import { usePantryStore } from '../store/pantryStore';
import IngredientCard from '../components/pantry/IngredientCard';
import AddIngredientModal from '../components/pantry/AddIngredientModal';
import { Plus, Search } from 'lucide-react';
import { PantryItem } from '../types';

const PantryPage: React.FC = () => {
  const { items, isLoading, fetchPantry, addItem, updateItem, deleteItem } = usePantryStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PantryItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetchPantry();
  }, [fetchPantry]);

  const handleAdd = (data: any) => {
    if (editingItem) {
      updateItem(editingItem.id, data);
    } else {
      addItem(data);
    }
    setEditingItem(null);
  };

  const handleEdit = (item: PantryItem) => {
    setEditingItem(item);
    setIsModalOpen(true);
  };

  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedItems = filteredItems.reduce((acc, item) => {
    const cat = item.category || 'Varie';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {} as Record<string, PantryItem[]>);

  return (
    <div className="flex flex-col min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <header className="p-4 bg-white border-b sticky top-0 z-10">
        <h1 className="text-2xl font-bold text-gray-800">La mia dispensa</h1>
        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder="Cerca ingredienti..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-gray-100 border-none rounded-lg focus:ring-2 focus:ring-primary focus:bg-white transition-all"
          />
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 p-4 space-y-6">
        {isLoading && items.length === 0 ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Nessun ingrediente trovato.</p>
          </div>
        ) : (
          Object.entries(groupedItems).map(([cat, catItems]) => (
            <section key={cat} className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">{cat}</h2>
              <div className="grid grid-cols-1 gap-3">
                {catItems.map((item) => (
                  <IngredientCard
                    key={item.id}
                    item={item}
                    onEdit={handleEdit}
                    onDelete={deleteItem}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </main>

      {/* Floating Action Button */}
      <button
        onClick={() => { setEditingItem(null); setIsModalOpen(true); }}
        className="fixed bottom-6 right-4 p-4 bg-primary text-white rounded-full shadow-lg hover:bg-emerald-700 transition-transform active:scale-95 z-20"
      >
        <Plus size={24} />
      </button>

      <AddIngredientModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingItem(null); }}
        onSubmit={handleAdd}
        initialData={editingItem}
      />
    </div>
  );
};

export default PantryPage;
