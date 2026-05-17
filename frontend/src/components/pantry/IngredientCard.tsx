import React from 'react';
import { PantryItem } from '../../types';
import { Trash2, Edit2 } from 'lucide-react';

interface IngredientCardProps {
  item: PantryItem;
  onEdit: (item: PantryItem) => void;
  onDelete: (id: string) => void;
}

const IngredientCard: React.FC<IngredientCardProps> = ({ item, onEdit, onDelete }) => {
  return (
    <div className="flex items-center justify-between p-4 bg-white rounded-lg shadow-sm border border-gray-100">
      <div>
        <h3 className="font-semibold text-gray-800 capitalize">{item.name}</h3>
        <p className="text-sm text-gray-500">
          {item.quantity} {item.unit} • <span className="text-primary italic">{item.category || 'Varie'}</span>
        </p>
        {item.expiry_date && (
          <p className="text-xs text-orange-500 mt-1">
            Scade il: {new Date(item.expiry_date).toLocaleDateString()}
          </p>
        )}
      </div>
      <div className="flex space-x-2">
        <button
          onClick={() => onEdit(item)}
          className="p-2 text-gray-400 hover:text-primary transition-colors"
        >
          <Edit2 size={18} />
        </button>
        <button
          onClick={() => onDelete(item.id)}
          className="p-2 text-gray-400 hover:text-red-500 transition-colors"
        >
          <Trash2 size={18} />
        </button>
      </div>
    </div>
  );
};

export default IngredientCard;
