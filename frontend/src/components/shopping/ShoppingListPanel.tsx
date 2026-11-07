import { Check, Circle, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { PantryUnit, ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import { parseIngredientInput } from '@ikuck/shared/ingredients';
import { getRecipeById } from '../../domain/recipes';
import { validateShoppingListItemDetails } from '../../domain/shoppingList';
import type { ShoppingListItemPatch } from '../../store/shoppingListStore';
import UndoToast from '../feedback/UndoToast';
import { Button, Input, Select } from '../../components/shared';

interface ShoppingListPanelProps {
  items: ShoppingListItem[];
  onAdd: (input: ShoppingListItemPayload) => string | null;
  onTogglePurchased: (id: string) => boolean;
  onRemove: (id: string) => void;
  onRestoreItem?: (item: ShoppingListItem) => boolean;
  onUpdate: (id: string, patch: ShoppingListItemPatch) => boolean;
  onClearPurchased: () => number;
}

const units: Array<{ value: PantryUnit; label: string }> = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'l', label: 'l' },
  { value: 'piece', label: 'pezzi' },
  { value: 'pack', label: 'confezioni' },
];

const parseQuantity = (value: string): number | null => {
  if (value.trim() === '') return null;
  return Number(value.replace(',', '.'));
};

const errorMessage = (errors: readonly string[]): string => {
  if (errors.includes('label_required')) return 'Scrivi cosa vuoi aggiungere alla lista.';
  if (errors.includes('label_too_long')) return 'Il nome è troppo lungo.';
  if (errors.includes('quantity_finite')) return 'La quantità deve essere un numero valido.';
  if (errors.includes('quantity_positive')) return 'La quantità deve essere maggiore di zero.';
  if (errors.includes('unit_required')) return 'Se indichi una quantità, scegli anche l\'unità.';
  if (errors.includes('quantity_required')) return 'Scegli una quantità oppure lascia vuota l\'unità.';
  if (errors.includes('unit_invalid')) return 'Unità di misura non valida.';
  if (errors.includes('note_too_long')) return 'La nota è troppo lunga.';
  return 'Controlla i dettagli inseriti.';
};

const unitLabel = (unit: PantryUnit | null): string => units.find((option) => option.value === unit)?.label ?? unit ?? '';

function pendingCountText(count: number): string {
  return count === 1 ? '1 da acquistare' : `${count} da acquistare`;
}

function ShoppingItemEditor({ item, onUpdate, onSaved }: { item: ShoppingListItem; onUpdate: ShoppingListPanelProps['onUpdate']; onSaved: () => void }) {
  const [label, setLabel] = useState(item.label);
  const [quantity, setQuantity] = useState(item.quantity === null ? '' : String(item.quantity));
  const [unit, setUnit] = useState<PantryUnit | ''>(item.unit ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedQuantity = parseQuantity(quantity);
    const parsedUnit = unit === '' ? null : unit;
    const parsedNote = note.trim().length > 0 ? note.trim() : null;
    const errors = validateShoppingListItemDetails(label, parsedQuantity, parsedUnit, parsedNote);
    if (errors.length > 0) {
      setError(errorMessage(errors));
      return;
    }
    if (!onUpdate(item.id, { label, quantity: parsedQuantity, unit: parsedUnit, note: parsedNote })) {
      setError('Non è stato possibile aggiornare l\'elemento.');
      return;
    }
    setError(null);
    onSaved();
  };

  return (
    <form className="ik-surface mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end" onSubmit={submit}>
      <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
        Nome
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="min-h-10"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
          Quantità
          <Input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="min-h-10"
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
          Unità
          <Select
            value={unit}
            onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
            options={[{ value: '', label: 'Nessuna' }, ...units]}
            className="min-h-10"
          />
        </label>
      </div>
      <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)] sm:col-span-2">
        Nota (facoltativa)
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={120}
          placeholder="es. senza lattosio"
          className="min-h-10"
        />
      </label>
      {error !== null && (
        <p role="alert" className="ik-status-danger rounded-[var(--radius-control)] p-3 text-sm font-semibold">
          {error}
        </p>
      )}
      <Button type="submit" className="min-h-11" variant="primary">
        Salva dettagli
      </Button>
    </form>
  );
}

function ShoppingListItemRow({
  item,
  onTogglePurchased,
  onRemove,
  onUpdate,
  onEdit,
  onSaved,
  isEditing,
}: Omit<ShoppingListPanelProps, 'items' | 'onAdd' | 'onClearPurchased'> & {
  item: ShoppingListItem;
  onEdit: (id: string) => void;
  onSaved: () => void;
  isEditing: boolean;
}) {
  const recipe = item.sourceRecipeId === null ? undefined : getRecipeById(item.sourceRecipeId);
  const quantity = item.quantity === null ? 'Quantità non indicata' : `${item.quantity} ${unitLabel(item.unit)}`;

  return (
    <li className={`ik-card p-4 ${item.purchased ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary-action)]' : ''}`} data-state={item.purchased ? 'purchased' : 'pending'}>
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 flex-wrap">
        <button
          type="button"
          aria-pressed={item.purchased}
          aria-label={item.purchased ? `Segna ${item.label} come da acquistare` : `Segna ${item.label} come acquistato`}
          onClick={() => onTogglePurchased(item.id)}
          className={`mt-0.5 grid min-h-11 min-w-11 place-items-center rounded-[var(--radius-control)] text-[var(--color-primary)] hover:bg-[var(--color-surface)] ${item.purchased ? 'border-2 border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-on-primary-action)]' : 'border-2 border-[var(--color-border)] bg-[var(--color-surface)]'}`}
        >
          {item.purchased ? <Check size={20} aria-hidden="true" /> : <Circle size={20} aria-hidden="true" />}
        </button>
        <div className="min-w-0 flex-[1_1_auto] w-full sm:w-auto">
          <p className={`font-bold text-[var(--color-text)] ${item.purchased ? 'line-through decoration-2' : ''}`}>
            {item.label}
          </p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{quantity}</p>
          {item.note !== null && <p className="mt-1 text-sm text-[var(--color-text-muted)]">Nota: {item.note}</p>}
          {recipe !== undefined && (
            <p className="mt-1 text-sm font-semibold text-[var(--color-primary)]">Dalla ricetta: {recipe.title}</p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto flex-shrink-0">
          <Button
            type="button"
            aria-label={`Modifica ${item.label}`}
            onClick={() => onEdit(item.id)}
            variant="secondary"
            className="min-h-11 min-w-auto shrink-0 w-full sm:w-auto flex items-center gap-2 justify-center whitespace-normal sm:whitespace-nowrap"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span>Modifica</span>
          </Button>
          <Button
            type="button"
            aria-label={`Rimuovi ${item.label}`}
            onClick={() => onRemove(item.id)}
            variant="secondary"
            className="min-h-11 min-w-auto shrink-0 w-full sm:w-auto flex items-center gap-2 justify-center whitespace-normal sm:whitespace-nowrap text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-[var(--color-on-primary-action)]"
          >
            <Trash2 size={18} aria-hidden="true" />
            <span>Rimuovi</span>
          </Button>
        </div>
      </div>
      {isEditing && <ShoppingItemEditor item={item} onUpdate={onUpdate} onSaved={onSaved} />}
    </li>
  );
}

export default function ShoppingListPanel({
  items,
  onAdd,
  onTogglePurchased,
  onRemove,
  onRestoreItem,
  onUpdate,
  onClearPurchased,
}: ShoppingListPanelProps) {
  const [label, setLabel] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<PantryUnit | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removedItems, setRemovedItems] = useState<ShoppingListItem[] | null>(null);
  const [purchasedSectionOpen, setPurchasedSectionOpen] = useState(true);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  const pendingItems = items.filter((item) => !item.purchased);
  const purchasedItems = items.filter((item) => item.purchased);

  const openEditor = (id: string) => setEditingItemId(id);
  const closeEditor = () => setEditingItemId(null);

  const removeItem = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    onRemove(id);
    if (item !== undefined) setRemovedItems([item]);
  };

  const clearPurchased = () => {
    const removed = [...purchasedItems];
    const count = onClearPurchased();
    if (count > 0) setRemovedItems(removed);
  };

  const restoreItems = () => {
    if (removedItems === null) return;
    const restored = removedItems.every((item) =>
      onRestoreItem !== undefined ? onRestoreItem(item) : onAdd(item) !== null,
    );
    if (restored) setRemovedItems(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    const parsedQuantity = parseQuantity(quantity);
    const parsedUnit = unit === '' ? null : unit;
    const parsedNote = note.trim().length > 0 ? note.trim() : null;
    const errors = validateShoppingListItemDetails(trimmedLabel, parsedQuantity, parsedUnit, parsedNote);
    if (errors.length > 0) {
      setMessage(null);
      setError(errorMessage(errors));
      return;
    }
    const parsedIngredient = parseIngredientInput(trimmedLabel)[0];
    const itemId = onAdd({
      ingredientId: parsedIngredient?.id ?? `custom:${trimmedLabel.toLowerCase().replace(/\s+/g, '-')}`,
      label: parsedIngredient?.label ?? trimmedLabel,
      quantity: parsedQuantity,
      unit: parsedUnit,
      note: parsedNote,
      purchased: false,
      sourceRecipeId: null,
    });
    if (itemId === null) {
      setMessage(null);
      setError('Non è stato possibile aggiungere l\'elemento.');
      return;
    }
    setLabel('');
    setQuantity('');
    setUnit('');
    setNote('');
    setError(null);
    setMessage('Aggiunto alla lista.');
  };

  return (
    <>
    <section aria-labelledby="shopping-list-title" className="ik-surface ik-surface--feature rounded-[var(--radius-feature)] border-2 border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[var(--color-primary)]">
            <ShoppingCart size={14} aria-hidden="true" /> Spesa
          </p>
          <h1 id="shopping-list-title" className="mt-1 text-3xl font-black text-[var(--color-text)]">Lista della spesa</h1>
          <p className="mt-1 text-[var(--color-text-muted)]">Aggiungi quello che manca. La lista resta disponibile anche offline.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-[var(--color-text-muted)] text-xs font-bold">
          {pendingCountText(pendingItems.length)}
        </span>
        {purchasedItems.length > 0 && (
          <Button type="button" onClick={clearPurchased} variant="secondary" className="min-h-11">
            Rimuovi gli acquistati
          </Button>
        )}
      </header>

      <form className="mt-6 grid gap-3" onSubmit={submit}>
        <label htmlFor="shopping-item-label" className="text-sm font-semibold text-[var(--color-text)]">
          Cosa ti serve?
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            id="shopping-item-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="es. latte, detersivo, mele"
            className="ik-input min-h-12 flex-1"
          />
          <Button type="submit" aria-label="Aggiungi alla lista" variant="primary" className="min-h-12 shrink-0">
            <Plus size={18} aria-hidden="true" /> Aggiungi
          </Button>
        </div>
        <details className="ik-surface rounded-[var(--radius-panel)] p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[var(--color-text)]">
            Aggiungi dettagli (facoltativi)
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
              Quantità da acquistare
              <Input
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="min-h-10"
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)]">
              Unità di misura della spesa
              <Select
                value={unit}
                onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
                options={[{ value: '', label: 'Nessuna' }, ...units]}
                className="min-h-10"
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--color-text)] sm:col-span-2">
              Nota (facoltativa)
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={120}
                placeholder="es. senza lattosio"
                className="min-h-10"
              />
            </label>
          </div>
        </details>
        {error !== null && (
          <p role="alert" className="ik-status-danger rounded-[var(--radius-control)] p-3 text-sm font-semibold">
            {error}
          </p>
        )}
        {message !== null && (
          <p role="status" className="ik-status-warning rounded-[var(--radius-control)] p-3 text-sm font-semibold">
            {message}
          </p>
        )}
      </form>

      {items.length === 0 ? (
        <div className="mt-6 text-center ik-surface rounded-[var(--radius-panel)] border-2 border-dashed border-[var(--color-border)] p-5 text-[var(--color-text-muted)]">
          <span className="block text-4xl mb-3">🛒</span>
          <p className="font-bold text-[var(--color-text)]">La lista è vuota</p>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">Aggiungi il primo prodotto dalla barra sopra.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {pendingItems.length > 0 && (
            <section aria-labelledby="shopping-pending-title">
              <h3 id="shopping-pending-title" className="text-lg font-black text-[var(--color-text)]">
                Da acquistare <span className="font-semibold text-[var(--color-text-muted)]">({pendingItems.length})</span>
              </h3>
              <ul className="mt-3 grid gap-3">
                {pendingItems.map((item) => (
                  <ShoppingListItemRow
                    key={item.id}
                    item={item}
                    onTogglePurchased={onTogglePurchased}
                    onRemove={removeItem}
                    onUpdate={onUpdate}
                    onEdit={openEditor}
                    onSaved={() => {
                      closeEditor();
                      setMessage('Dettagli aggiornati.');
                    }}
                    isEditing={editingItemId === item.id}
                  />
                ))}
              </ul>
            </section>
          )}
          {purchasedItems.length > 0 && (
            <section aria-labelledby="shopping-purchased-title">
              <div className="flex items-baseline justify-between gap-3">
                <h3 id="shopping-purchased-title" className="text-lg font-black text-[var(--color-text)]">
                  Acquistati <span className="font-semibold text-[var(--color-text-muted)]">({purchasedItems.length})</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setPurchasedSectionOpen((open) => !open)}
                  className="text-sm font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline-offset-4"
                  aria-expanded={purchasedSectionOpen}
                >
                  {purchasedSectionOpen ? 'Nascondi acquistati' : 'Mostra acquistati'}
                </button>
              </div>
              {purchasedSectionOpen && (
                <ul className="mt-3 grid gap-3">
                  {purchasedItems.map((item) => (
                    <ShoppingListItemRow
                      key={item.id}
                      item={item}
                      onTogglePurchased={onTogglePurchased}
                      onRemove={removeItem}
                      onUpdate={onUpdate}
                      onEdit={openEditor}
                      onSaved={() => {
                        closeEditor();
                        setMessage('Dettagli aggiornati.');
                      }}
                      isEditing={editingItemId === item.id}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </section>
    {removedItems !== null && (
      <UndoToast
        message={removedItems.length === 1 ? `Elemento ${removedItems[0].label} rimosso.` : `${removedItems.length} elementi rimossi.`}
        onUndo={restoreItems}
        onExpire={() => setRemovedItems(null)}
      />
    )}
    </>
  );
}