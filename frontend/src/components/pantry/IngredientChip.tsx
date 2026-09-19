import { X } from 'lucide-react';
import type { ParsedIngredient } from '../../domain/types';

interface IngredientChipProps {
  item: ParsedIngredient;
  onRemove: (id: string) => void;
}

export default function IngredientChip({ item, onRemove }: IngredientChipProps) {
  return (
    <li className="flex min-h-11 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-950">
      <span className="font-semibold">{item.label}</span>
      {!item.known && <small className="max-w-32 text-xs leading-tight text-amber-800">Non ancora usato nelle ricette</small>}
      <button type="button" aria-label={`Rimuovi ${item.label}`} onClick={() => onRemove(item.id)} className="ml-auto grid min-h-11 min-w-11 place-items-center rounded-full text-emerald-800 hover:bg-emerald-100">
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}
