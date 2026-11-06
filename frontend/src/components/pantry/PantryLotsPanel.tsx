import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PantryLot, PantryUnit } from '@ikuck/shared/contracts';
import { aggregatePantryLots, getExpiryStatus } from '../../domain/pantryLots';
import type { ParsedIngredient } from '../../domain/types';
import PantryLotEditor, { type PantryLotDetails } from './PantryLotEditor';
import UndoToast from '../feedback/UndoToast';

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

const expiryClassName = (date: string | null): string => {
  const status = getExpiryStatus(date);
  if (status === 'expired') return 'text-[var(--ik-tomato)]';
  if (status === 'expiring_soon') return 'text-[var(--ik-warn-ink)]';
  return 'text-[var(--ik-ink-muted)]';
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
    <details aria-labelledby="pantry-lots-title" className="ik-disclosure min-w-0 border p-4">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="pantry-lots-title" className="text-lg font-bold text-[var(--ik-ink)]">Dettagli lotti</h3>
          <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Aggiungi quantità e scadenze solo quando ti servono.</p>
          </div>
          <span className="shrink-0 rounded-full bg-[var(--ik-mist)] px-3 py-1 text-sm font-bold text-[var(--ik-ink-muted)]">{lotCountLabel}</span>
      </summary>
      <div className="mt-3 grid min-w-0 gap-3 border-t border-[var(--ik-border)] pt-3">
        {ingredients.map((ingredient) => {
          const ingredientLots = lots.filter((lot) => lot.ingredientId === ingredient.id);
          const aggregate = aggregates.find((item) => item.ingredientId === ingredient.id);
          const newEditorKey = `new:${ingredient.id}`;
          return (
            <article key={ingredient.id} className="min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="font-bold text-[var(--ik-ink)]">Lotti di {ingredient.label}</h4>
                  <p className="break-words text-sm text-[var(--ik-ink-muted)]">
                    {aggregate?.totalQuantity !== null && aggregate?.totalQuantity !== undefined && aggregate.totalUnit !== null
                      ? `Totale: ${formatQuantity(aggregate.totalQuantity)} ${UNIT_LABELS[aggregate.totalUnit]}`
                      : aggregate?.quantities.length
                        ? `Quantità separate: ${aggregate.quantities.map((item) => `${formatQuantity(item.quantity)} ${UNIT_LABELS[item.unit]}`).join(' + ')}`
                        : 'Quantità non indicata'}
                    {' · '}{ingredientLots.length} {ingredientLots.length === 1 ? 'lotto' : 'lotti'}
                  </p>
                  <p className={`text-sm font-semibold ${expiryClassName(aggregate?.earliestExpiresAt ?? null)}`}>
                    {expiryLabel(aggregate?.earliestExpiresAt ?? null)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditorKey(newEditorKey)}
                  className="ik-button-secondary inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 border-2 bg-[var(--ik-surface)] px-3 py-2 text-sm font-bold hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto"
                >
                  <Plus size={16} aria-hidden="true" />
                  Aggiungi lotto
                </button>
              </div>
              <ul className="mt-3 grid min-w-0 gap-2" aria-label={`Lotti di ${ingredient.label}`}>
                {ingredientLots.map((lot, index) => (
                  <li key={lot.id} className="min-w-0 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3">
                    <div className="grid min-w-0 gap-2 sm:flex sm:items-center sm:justify-between">
                      <p className="break-words text-sm text-[var(--ik-ink)]">
                        <span className="font-semibold">Lotto {index + 1}:</span>{' '}
                        {lot.quantity !== null && lot.unit !== null ? `${formatQuantity(lot.quantity)} ${UNIT_LABELS[lot.unit]}` : 'presenza indicata'}
                        <span className="text-[var(--ik-ink-muted)]">{' · '}{expiryLabel(lot.expiresAt)}</span>
                      </p>
                      <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex">
                        <button type="button" onClick={() => setEditorKey(lot.id)} className="ik-button-secondary min-h-11 w-full border-2 bg-[var(--ik-surface)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">Modifica</button>
                        <button type="button" onClick={() => removeLot(lot)} aria-label={`Rimuovi lotto ${index + 1} di ${ingredient.label}`} className="inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-surface)] px-3 py-1.5 text-sm font-semibold text-[var(--ik-tomato)] hover:bg-[var(--ik-tomato-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ik-focus)] sm:w-auto">
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
