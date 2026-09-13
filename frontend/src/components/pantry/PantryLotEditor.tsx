import { useState } from 'react';
import type { PantryUnit } from '@ikuck/shared/contracts';
import { validatePantryLotDetails } from '../../domain/pantryLots';

export interface PantryLotDetails {
  quantity: number | null;
  unit: PantryUnit | null;
  expiresAt: string | null;
}

interface PantryLotEditorProps {
  initialDetails?: PantryLotDetails;
  onCancel: () => void;
  onSubmit: (details: PantryLotDetails) => boolean;
}

const UNIT_LABELS: Record<PantryUnit, string> = {
  g: 'grammi',
  kg: 'chilogrammi',
  ml: 'millilitri',
  l: 'litri',
  piece: 'pezzi',
  pack: 'confezioni',
};

const errorMessage = (errors: string[]): string | null => {
  if (errors.includes('quantity_positive') || errors.includes('quantity_finite')) return 'Inserisci una quantità maggiore di zero.';
  if (errors.includes('unit_required')) return 'Scegli l’unità di misura della quantità.';
  if (errors.includes('quantity_required')) return 'Inserisci una quantità oppure lascia vuota l’unità.';
  if (errors.includes('expiry_invalid')) return 'Inserisci una data di scadenza valida.';
  return errors.length > 0 ? 'Controlla i dettagli del lotto.' : null;
};

export default function PantryLotEditor({ initialDetails, onCancel, onSubmit }: PantryLotEditorProps) {
  const [quantity, setQuantity] = useState(initialDetails?.quantity?.toString() ?? '');
  const [unit, setUnit] = useState<PantryUnit | ''>(initialDetails?.unit ?? '');
  const [expiresAt, setExpiresAt] = useState(initialDetails?.expiresAt ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const parsedQuantity = quantity.trim() === '' ? null : Number(quantity);
    const details: PantryLotDetails = {
      quantity: parsedQuantity,
      unit: unit === '' ? null : unit,
      expiresAt: expiresAt === '' ? null : expiresAt,
    };
    const errors = validatePantryLotDetails(details.quantity, details.unit, details.expiresAt);
    const validationError = errorMessage(errors);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    if (!onSubmit(details)) {
      setError('Non è stato possibile salvare il lotto. Riprova.');
      return;
    }
    setError(null);
  };

  return (
    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-semibold text-gray-700">
          Quantità (opzionale)
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            aria-label="Quantità del lotto"
            className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-200 bg-white px-3 py-2 font-normal text-gray-900 outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100"
          />
        </label>
        <label className="text-sm font-semibold text-gray-700">
          Unità (opzionale)
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
            aria-label="Unità di misura"
            className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-200 bg-white px-3 py-2 font-normal text-gray-900 outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100"
          >
            <option value="">Nessuna unità</option>
            {(Object.keys(UNIT_LABELS) as PantryUnit[]).map((value) => <option key={value} value={value}>{UNIT_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-gray-700">
          Scadenza (opzionale)
          <input
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            aria-label="Data di scadenza"
            className="mt-1 min-h-11 w-full rounded-xl border-2 border-gray-200 bg-white px-3 py-2 font-normal text-gray-900 outline-none focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100"
          />
        </label>
      </div>
      <p className="mt-2 text-sm text-emerald-900">Lascia vuota la quantità se vuoi indicare soltanto che l’ingrediente è presente.</p>
      {error !== null && <p role="alert" className="mt-2 text-sm font-semibold text-red-700">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={handleSubmit} className="min-h-10 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800">Salva dettagli</button>
        <button type="button" onClick={onCancel} className="min-h-10 rounded-xl border-2 border-gray-300 bg-white px-4 py-2 font-semibold text-gray-800 hover:border-gray-900">Annulla</button>
      </div>
    </div>
  );
}
