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
    <div role="group" aria-label="Dettagli lotto" className="mt-3 min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-sage)] p-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <label className="min-w-0 text-sm font-semibold text-[var(--ik-ink)]">
          Quantità (opzionale)
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            aria-label="Quantità del lotto"
            className="ik-input mt-1 min-h-11 w-full min-w-0 border-2 px-3 py-2 font-normal outline-none focus:ring-4 focus:ring-[var(--ik-focus)]"
          />
        </label>
        <label className="min-w-0 text-sm font-semibold text-[var(--ik-ink)]">
          Unità (opzionale)
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
            aria-label="Unità di misura"
            className="ik-input mt-1 min-h-11 w-full min-w-0 border-2 px-3 py-2 font-normal outline-none focus:ring-4 focus:ring-[var(--ik-focus)]"
          >
            <option value="">Nessuna unità</option>
            {(Object.keys(UNIT_LABELS) as PantryUnit[]).map((value) => <option key={value} value={value}>{UNIT_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-sm font-semibold text-[var(--ik-ink)]">
          Scadenza (opzionale)
          <input
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            aria-label="Data di scadenza"
            className="ik-input mt-1 min-h-11 w-full min-w-0 border-2 px-3 py-2 font-normal outline-none focus:ring-4 focus:ring-[var(--ik-focus)]"
          />
        </label>
      </div>
      <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Lascia vuota la quantità se vuoi indicare soltanto che l’ingrediente è presente.</p>
      {error !== null && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--ik-tomato)]">{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <button type="button" onClick={handleSubmit} className="ik-button-primary min-h-11 w-full px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Salva dettagli</button>
        <button type="button" onClick={onCancel} className="ik-button-secondary min-h-11 w-full border-2 bg-[var(--ik-surface)] px-4 py-2 font-semibold hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Annulla</button>
      </div>
    </div>
  );
}
