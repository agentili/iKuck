import { X } from 'lucide-react';
import type { ParsedIngredient } from '../../domain/types';

interface IngredientChipProps {
  item: ParsedIngredient;
  onRemove: (id: string) => void;
}

export default function IngredientChip({ item, onRemove }: IngredientChipProps) {
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span className="font-semibold text-ink">{item.label}</span>
      {!item.known && <small className="max-w-32 text-xs leading-tight text-amber-800">Ingrediente personalizzato</small>}
      <button type="button" aria-label={`Rimuovi ${item.label}`} onClick={() => onRemove(item.id)} className="ml-auto grid min-h-11 min-w-11 place-items-center rounded-full text-emerald-800 hover:bg-emerald-100">
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}
