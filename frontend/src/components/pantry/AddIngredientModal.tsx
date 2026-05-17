import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PantryItem } from '../../types';
import { X } from 'lucide-react';

const itemSchema = z.object({
  name: z.string().min(1, 'Nome richiesto'),
  quantity: z.number().min(0.1, 'Quantità minima 0.1'),
  unit: z.string().min(1, 'Unità richiesta'),
  category: z.string().optional(),
  expiry_date: z.string().optional(),
});

type ItemForm = z.infer<typeof itemSchema>;

interface AddIngredientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ItemForm) => void;
  initialData?: PantryItem | null;
}

const AddIngredientModal: React.FC<AddIngredientModalProps> = ({ isOpen, onClose, onSubmit, initialData }) => {
  const { register, handleSubmit, formState: { errors }, reset } = useForm<ItemForm>({
    resolver: zodResolver(itemSchema),
    values: initialData ? {
      name: initialData.name,
      quantity: initialData.quantity,
      unit: initialData.unit || 'g',
      category: initialData.category,
      expiry_date: initialData.expiry_date?.split('T')[0],
    } : { name: '', quantity: 1, unit: 'g', category: 'Varie' },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="w-full max-w-md p-6 bg-white rounded-xl shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">
            {initialData ? 'Modifica ingrediente' : 'Aggiungi ingrediente'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit((data) => { onSubmit(data); reset(); onClose(); })} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Nome</label>
            <input
              type="text"
              {...register('name')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            />
            {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Quantità</label>
              <input
                type="number"
                step="0.1"
                {...register('quantity', { valueAsNumber: true })}
                className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Unità</label>
              <select
                {...register('unit')}
                className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
              >
                <option value="g">grammi (g)</option>
                <option value="kg">kilogrammi (kg)</option>
                <option value="ml">millilitri (ml)</option>
                <option value="l">litri (l)</option>
                <option value="piece">pezzi (pz)</option>
                <option value="tbsp">cucchiaio (tbsp)</option>
                <option value="tsp">cuchiaino (tsp)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Categoria</label>
            <select
              {...register('category')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            >
              <option value="Varie">Varie</option>
              <option value="Frutta e Verdura">Frutta e Verdura</option>
              <option value="Carne">Carne</option>
              <option value="Pesce">Pesce</option>
              <option value="Latticini">Latticini</option>
              <option value="Pasta e Cereali">Pasta e Cereali</option>
              <option value="Spezie">Spezie</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Data di scadenza (opzionale)</label>
            <input
              type="date"
              {...register('expiry_date')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            />
          </div>

          <div className="flex space-x-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Annulla
            </button>
            <button
              type="submit"
              className="flex-1 py-2 text-white bg-primary rounded-md hover:bg-emerald-700"
            >
              Salva
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddIngredientModal;
