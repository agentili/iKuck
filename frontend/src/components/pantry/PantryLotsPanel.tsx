import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import { aggregatePantryLots, getExpiryStatus } from '../../domain/pantryLots';
import type { ParsedIngredient } from '../../domain/types';
import PantryLotEditor, { type PantryLotDetails } from './PantryLotEditor';
import UndoToast from '../feedback/UndoToast';
import { Badge } from '../../components/shared';

interface PantryLotsPanelProps {
  ingredients: readonly ParsedIngredient[];
  lots: readonly PantryLot[];
  onAddLot: (details: PantryLotDetails & Pick<PantryLot, 'ingredientId' | 'label' | 'known'>) => string | null;
  onRemoveLot: (id: string) => void;
  onRestoreLot?: (lot: PantryLot) => boolean;
  onUpdateLot: (id: string, details: PantryLotDetails) => boolean;
}

const UNIT_LABELS: Record<PantryUnit, string> = {
  g: 'g', kg: 'kg', ml: 'ml', l: 'l', piece: 'pezzi', pack: 'confezioni',
};

const formatQuantity = (quantity: number): string => new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(quantity);

const formatExpiry = (date: string): string => new Intl.DateTimeFormat('it-IT', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${date}T00:00:00.000Z`));

const expiryLabel = (date: string | null): string => {
  const status = getExpiryStatus(date);
  if (status === 'expired') return `Scaduto il ${formatExpiry(date!)}`;
  if (status === 'expiring_soon') return `Scade presto: ${formatExpiry(date!)}`;
  if (status === 'okay') return `Scade il ${formatExpiry(date!)}`;
  return 'Scadenza non indicata';
};

const expiryVariant = (date: string | null): 'default' | 'warning' | 'danger' => {
  const status = getExpiryStatus(date);
  if (status === 'expired') return 'danger';
  if (status === 'expiring_soon') return 'warning';
  return 'default';
};

const detailsFromLot = (lot: PantryLot): PantryLotDetails => ({
  quantity: lot.quantity,
  unit: lot.unit,
  expiresAt: lot.expiresAt,
});

export default function PantryLotsPanel({ ingredients, lots, onAddLot, onRemoveLot, onRestoreLot, onUpdateLot }: PantryLotsPanelProps) {
  const [editorKey, setEditorKey] = useState<string | null>(null);
  const [removedLot, setRemovedLot] = useState<PantryLot | null>(null);
  const aggregates = aggregatePantryLots(lots);
  const lotCountLabel = lots.length === 0 ? 'Nessun lotto' : `${lots.length} ${lots.length === 1 ? 'lotto' : 'lotti'}`;

  const removeLot = (lot: PantryLot) => {
    onRemoveLot(lot.id);
    setRemovedLot(lot);
  };

  const restoreLot = () => {
    if (removedLot === null) return;
    const restored = onRestoreLot !== undefined
      ? onRestoreLot(removedLot)
      : onAddLot({
        ingredientId: removedLot.ingredientId,
        label: removedLot.label,
        known: removedLot.known,
        quantity: removedLot.quantity,
        unit: removedLot.unit,
        expiresAt: removedLot.expiresAt,
      }) !== null;
    if (restored) setRemovedLot(null);
  };

  return (
    <>
    <details aria-labelledby="pantry-lots-title" className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="pantry-lots-title" className="text-lg font-bold text-[var(--color-text)]">Dettagli lotti</h3>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">Puoi aggiungere lotti, quantità e scadenze senza complicare la ricerca delle ricette.</p>
          </div>
          <Badge variant="neutral">{lotCountLabel}</Badge>
        </div>
      </summary>
      <div className="mt-3 grid gap-3">
        {ingredients.map((ingredient) => {
          const ingredientLots = lots.filter((lot) => lot.ingredientId === ingredient.id);
          const aggregate = aggregates.find((item) => item.ingredientId === ingredient.id);
          const newEditorKey = `new:${ingredient.id}`;
          return (
            <article key={ingredient.id} className="ik-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="font-bold text-[var(--color-text)]">Lotti di {ingredient.label}</h4>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {aggregate?.totalQuantity !== null && aggregate?.totalQuantity !== undefined && aggregate.totalUnit !== null
                      ? `Totale: ${formatQuantity(aggregate.totalQuantity)} ${UNIT_LABELS[aggregate.totalUnit]}`
                      : aggregate?.quantities.length
                        ? `Quantità separate: ${aggregate.quantities.map((item) => `${formatQuantity(item.quantity)} ${UNIT_LABELS[item.unit]}`).join(' + ')}`
                        : 'Quantità non indicata'}
                    {' · '}{ingredientLots.length} {ingredientLots.length === 1 ? 'lotto' : 'lotti'}
                  </p>
                  <Badge variant={expiryVariant(aggregate?.earliestExpiresAt ?? null)} dot>
                    {expiryLabel(aggregate?.earliestExpiresAt ?? null)}
                  </Badge>
                </div>
                <button
                  type="button"
                  onClick={() => setEditorKey(newEditorKey)}
                  className="ik-button-secondary min-h-10 text-sm"
                >
                  <Plus size={16} aria-hidden="true" />
                  Aggiungi lotto
                </button>
              </div>
              <ul className="mt-3 grid gap-2" aria-label={`Lotti di ${ingredient.label}`}>
                {ingredientLots.map((lot, index) => (
                  <li key={lot.id} className="ik-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-[var(--color-text-muted)]">
                        <span className="font-semibold">Lotto {index + 1}:</span>{' '}
                        {lot.quantity !== null && lot.unit !== null ? `${formatQuantity(lot.quantity)} ${UNIT_LABELS[lot.unit]}` : 'presenza indicata'}
                        {' · '}
                        <Badge variant={expiryVariant(lot.expiresAt)} dot>
                          {expiryLabel(lot.expiresAt)}
                        </Badge>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setEditorKey(lot.id)} className="ik-button-secondary min-h-9 text-sm">Modifica</button>
                        <button type="button" onClick={() => removeLot(lot)} aria-label={`Rimuovi lotto ${index + 1} di ${ingredient.label}`} className="ik-button-secondary min-h-9 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-on-primary-action)]">
                          <Trash2 size={15} aria-hidden="true" />
                          Rimuovi
                        </button>
                      </div>
                    </div>
                    {editorKey === lot.id && (
                      <PantryLotEditor
                        initialDetails={detailsFromLot(lot)}
                        onCancel={() => setEditorKey(null)}
                        onSubmit={(details) => {
                          const saved = onUpdateLot(lot.id, details);
                          if (saved) setEditorKey(null);
                          return saved;
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {editorKey === newEditorKey && (
                <PantryLotEditor
                  onCancel={() => setEditorKey(null)}
                  onSubmit={(details) => {
                    const created = onAddLot({ ...details, ingredientId: ingredient.id, label: ingredient.label, known: ingredient.known });
                    if (created !== null) setEditorKey(null);
                    return created !== null;
                  }}
                />
              )}
            </article>
          );
        })}
      </div>
    </details>
    {removedLot !== null && (
      <UndoToast
        message={`Lotto di ${removedLot.label} rimosso.`}
        onUndo={restoreLot}
        onExpire={() => setRemovedLot(null)}
      />
    )}
    </>
  );
}