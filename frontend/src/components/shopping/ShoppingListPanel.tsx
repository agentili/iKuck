import { Check, Circle, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { PantryUnit, ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import { parseIngredientInput } from '@ikuck/shared/ingredients';
import { getRecipeById } from '../../domain/recipes';
import { validateShoppingListItemDetails } from '../../domain/shoppingList';
import type { ShoppingListItemPatch } from '../../store/shoppingListStore';
import UndoToast from '../feedback/UndoToast';

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
  if (errors.includes('unit_required')) return 'Se indichi una quantità, scegli anche l’unità.';
  if (errors.includes('quantity_required')) return 'Scegli una quantità oppure lascia vuota l’unità.';
  if (errors.includes('unit_invalid')) return 'Unità di misura non valida.';
  if (errors.includes('note_too_long')) return 'La nota è troppo lunga.';
  return 'Controlla i dettagli inseriti.';
};

const unitLabel = (unit: PantryUnit | null): string => units.find((option) => option.value === unit)?.label ?? unit ?? '';

function pendingCountText(count: number): string {
  return count === 1 ? '1 da acquistare' : `${count} da acquistare`;
}

function ShoppingItemEditor({ item, onUpdate, onSaved, onCancel }: { item: ShoppingListItem; onUpdate: ShoppingListPanelProps['onUpdate']; onSaved: () => void; onCancel: () => void }) {
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
      setError('Non è stato possibile aggiornare l’elemento.');
      return;
    }
    setError(null);
    onSaved();
  };

  return (
    <form aria-label={`Modifica ${item.label}`} className="mt-4 grid min-w-0 gap-3 border-t border-[var(--ik-border)] pt-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
        Nome
        <input
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
        />
      </label>
      <div className="grid min-w-0 gap-3 sm:col-span-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
          Quantità
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
          Unità
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
            className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
          >
            <option value="">Nessuna</option>
            {units.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)] sm:col-span-2">
        Nota (facoltativa)
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={120}
          placeholder="es. senza lattosio"
          className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
        />
      </label>
      {error !== null && (
        <p role="alert" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 text-sm font-semibold text-[var(--ik-tomato)]">
          {error}
        </p>
      )}
      <div className="grid min-w-0 gap-2 sm:col-span-2 sm:flex sm:flex-wrap">
        <button
          type="submit"
          className="min-h-11 rounded-[var(--ik-radius-control)] bg-[var(--ik-basil)] px-4 py-2 text-sm font-bold text-[var(--ik-porcelain)] hover:bg-[var(--ik-basil-dark)]"
        >
          Salva dettagli
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-[var(--ik-radius-control)] border border-[var(--ik-border-strong)] px-4 py-2 text-sm font-bold text-[var(--ik-ink)]">
          Annulla modifiche
        </button>
      </div>
    </form>
  );
}

function ShoppingListItemRow({
  item,
  onTogglePurchased,
  onRemove,
  onUpdate,
  onEdit,
  registerToggle,
  onSaved,
  onCancel,
  isEditing,
}: Omit<ShoppingListPanelProps, 'items' | 'onAdd' | 'onClearPurchased' | 'onTogglePurchased'> & {
  item: ShoppingListItem;
  onTogglePurchased: (item: ShoppingListItem) => void;
  onEdit: (id: string) => void;
  registerToggle: (id: string, node: HTMLButtonElement | null) => void;
  onSaved: () => void;
  onCancel: () => void;
  isEditing: boolean;
}) {
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const recipe = item.sourceRecipeId === null ? undefined : getRecipeById(item.sourceRecipeId);
  const quantity = item.quantity === null ? 'Quantità non indicata' : `${item.quantity} ${unitLabel(item.unit)}`;

  return (
    <li className="min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3 sm:p-4" data-state={item.purchased ? 'purchased' : 'pending'}>
    <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]">
      <button
        ref={(node) => registerToggle(item.id, node)}
        type="button"
        aria-pressed={item.purchased}
        aria-label={item.purchased ? `Segna ${item.label} come da acquistare` : `Segna ${item.label} come acquistato`}
        onClick={() => onTogglePurchased(item)}
        className={`grid min-h-11 min-w-11 place-items-center rounded-[var(--ik-radius-control)] text-[var(--ik-basil-dark)] hover:bg-[var(--ik-mist)] ${
          item.purchased ? 'border-2 border-[var(--ik-basil)] bg-[var(--ik-basil)] text-[var(--ik-porcelain)]' : 'border-2 border-[var(--ik-border)] bg-[var(--ik-surface)]'
        }`}
      >
        {item.purchased ? <Check size={20} aria-hidden="true" /> : <Circle size={20} aria-hidden="true" />}
      </button>
      <div className="min-w-0 self-center">
        <p className={`font-bold text-[var(--ik-ink)] ${item.purchased ? 'line-through decoration-2 text-[var(--ik-ink-muted)]' : ''}`}>
          {item.label}
        </p>
        <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">{quantity}</p>
        {item.note !== null && <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">Nota: {item.note}</p>}
        {recipe !== undefined && (
          <p className="mt-1 text-sm font-semibold text-[var(--ik-basil-dark)]">Dalla ricetta: {recipe.title}</p>
        )}
      </div>
      <div className="col-span-2 grid min-w-0 grid-cols-2 gap-2 sm:col-span-1 sm:flex sm:flex-wrap sm:justify-end">
        <button
          ref={editButtonRef}
          type="button"
          aria-label={`Modifica ${item.label}`}
          onClick={() => onEdit(item.id)}
          className="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] px-2 py-2 text-sm font-semibold text-[var(--ik-ink)] hover:bg-[var(--ik-mist)] sm:px-3"
          title="Modifica"
          >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          <span>Modifica</span>
        </button>
        <button
          type="button"
          aria-label={`Rimuovi ${item.label}`}
          onClick={() => onRemove(item.id)}
          className="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] px-2 py-2 text-sm font-semibold text-[var(--ik-ink)] hover:bg-[var(--ik-tomato-soft)] hover:text-[var(--ik-tomato)] sm:px-3"
          title="Rimuovi"
          >
          <Trash2 size={18} aria-hidden="true" />
          <span>Rimuovi</span>
        </button>
      </div>
    </div>
    {isEditing && <ShoppingItemEditor item={item} onUpdate={onUpdate} onSaved={() => { onSaved(); editButtonRef.current?.focus(); }} onCancel={() => { onCancel(); editButtonRef.current?.focus(); }} />}
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
  const toggleButtons = useRef(new Map<string, HTMLButtonElement>());
  const purchasedDisclosure = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<string | null>(null);
  const focusAfterRestore = useRef<string | null>(null);
  const undoToastContainer = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (removedItems !== null) undoToastContainer.current?.querySelector('button')?.focus();
  }, [removedItems]);

  useLayoutEffect(() => {
    const id = focusAfterToggle.current;
    if (id !== null) {
      (toggleButtons.current.get(id) ?? purchasedDisclosure.current)?.focus();
      focusAfterToggle.current = null;
    }
  }, [items]);

  useLayoutEffect(() => {
    const id = focusAfterRestore.current;
    if (removedItems === null && id !== null) {
      (toggleButtons.current.get(id) ?? purchasedDisclosure.current)?.focus();
      focusAfterRestore.current = null;
    }
  }, [items, removedItems]);

  const registerToggle = (id: string, node: HTMLButtonElement | null) => {
    if (node === null) toggleButtons.current.delete(id);
    else toggleButtons.current.set(id, node);
  };

  const toggleItem = (item: ShoppingListItem) => {
    focusAfterToggle.current = item.id;
    if (onTogglePurchased(item.id)) {
      setError(null);
      setMessage(item.purchased ? `Da acquistare: ${item.label}.` : `Acquistato: ${item.label}.`);
    } else {
      focusAfterToggle.current = null;
      setMessage(null);
      setError('Non è stato possibile cambiare lo stato dell’elemento.');
    }
  };

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
    const failed: ShoppingListItem[] = [];
    let firstRestoredId: string | null = null;
    for (const item of removedItems) {
      const restoredId = onRestoreItem !== undefined
        ? (onRestoreItem(item) ? item.id : null)
        : onAdd(item);
      if (restoredId === null) failed.push(item);
      else firstRestoredId ??= restoredId;
    }
    if (failed.length === 0) focusAfterRestore.current = firstRestoredId;
    setRemovedItems(failed.length > 0 ? failed : null);
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
      setError('Non è stato possibile aggiungere l’elemento.');
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
    <section aria-labelledby="shopping-list-title" className="min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-[var(--ik-basil-dark)]">
            <ShoppingCart size={14} aria-hidden="true" /> Spesa
          </p>
          <h1 id="shopping-list-title" className="mt-1 text-3xl font-black leading-tight text-[var(--ik-ink)]">Lista della spesa</h1>
          <p className="mt-1 text-[var(--ik-ink-muted)]">Aggiungi quello che manca. La lista resta disponibile anche offline.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 py-1 text-[var(--ik-ink-muted)] text-xs font-bold">
          {pendingCountText(pendingItems.length)}
        </span>
      </header>

      <form aria-label="Aggiungi un prodotto" className="mt-5 grid min-w-0 gap-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] p-4 sm:p-5" onSubmit={submit}>
        <label htmlFor="shopping-item-label" className="text-sm font-semibold text-[var(--ik-ink)]">
          Cosa ti serve?
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="shopping-item-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="es. latte, detersivo, mele"
            className="ik-input min-h-12 flex-1 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base outline-none focus:border-[var(--ik-basil)]"
          />
          <button type="submit" aria-label="Aggiungi alla lista" className="ik-button-primary inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--ik-radius-control)] px-4 py-2 font-bold text-[var(--ik-porcelain)]">
            <Plus size={18} aria-hidden="true" /> Aggiungi
          </button>
        </div>
        <details className="min-w-0 rounded-[var(--ik-radius-control)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[var(--ik-ink)]">
            Aggiungi dettagli (facoltativi)
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
              Quantità da acquistare
              <input
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)]">
              Unità di misura della spesa
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value as PantryUnit | '')}
                className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
              >
                <option value="">Nessuna</option>
                {units.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--ik-ink)] sm:col-span-2">
              Nota (facoltativa)
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={120}
                placeholder="es. senza lattosio"
                className="min-h-11 w-full min-w-0 rounded-[var(--ik-radius-control)] border-2 border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 text-base focus:border-[var(--ik-basil)]"
              />
            </label>
          </div>
        </details>
        {error !== null && (
          <p role="alert" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-tomato)] bg-[var(--ik-tomato-soft)] p-3 text-sm font-semibold text-[var(--ik-tomato)]">
            {error}
          </p>
        )}
        {message !== null && (
          <p role="status" aria-label="Stato della lista" className="rounded-[var(--ik-radius-control)] border border-[var(--ik-basil)] bg-[var(--ik-sage)] p-3 text-sm font-semibold text-[var(--ik-basil-dark)]">
            {message}
          </p>
        )}
      </form>

      {items.length === 0 ? (
        <div className="mt-6 text-center rounded-[var(--ik-radius-panel)] border-2 border-dashed border-[var(--ik-border)] p-5 text-[var(--ik-ink-muted)]">
          <span className="block text-4xl mb-3">🛒</span>
          <p className="font-bold text-[var(--ik-ink)]">La lista è vuota</p>
          <p className="mt-2 text-sm text-[var(--ik-ink-muted)]">Aggiungi il primo prodotto dalla barra sopra.</p>
        </div>
      ) : (
        <div className="mt-6 grid min-w-0 gap-6">
          <section aria-labelledby="shopping-pending-title" className="min-w-0">
            <h2 id="shopping-pending-title" className="text-xl font-black text-[var(--ik-ink)]">
              Da acquistare <span className="font-semibold text-[var(--ik-ink-muted)]">({pendingItems.length})</span>
            </h2>
            {pendingItems.length === 0 ? (
              <p className="mt-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-sage)] p-4 text-[var(--ik-ink)]">
                <strong className="block">Tutto acquistato</strong>
                Puoi aggiungere altri prodotti dalla barra sopra.
              </p>
            ) : (
              <ul className="mt-3 grid min-w-0 gap-3">
                {pendingItems.map((item) => (
                  <ShoppingListItemRow
                    key={item.id}
                    item={item}
                    onTogglePurchased={toggleItem}
                    registerToggle={registerToggle}
                    onRemove={removeItem}
                    onUpdate={onUpdate}
                    onEdit={openEditor}
                    onCancel={closeEditor}
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
          {purchasedItems.length > 0 && (
            <section aria-labelledby="shopping-purchased-title" className="min-w-0 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-mist)] p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="shopping-purchased-title" className="text-lg font-bold text-[var(--ik-ink)]">
                  Acquistati <span className="font-semibold text-[var(--ik-ink-muted)]">({purchasedItems.length})</span>
                </h2>
                <button
                  ref={purchasedDisclosure}
                  type="button"
                  onClick={() => setPurchasedSectionOpen((open) => !open)}
                  className="min-h-11 rounded-[var(--ik-radius-control)] px-2 py-2 text-sm font-semibold text-[var(--ik-ink-muted)] hover:bg-[var(--ik-sage)] hover:text-[var(--ik-ink)]"
                  aria-expanded={purchasedSectionOpen}
                >
                  {purchasedSectionOpen ? 'Nascondi acquistati' : 'Mostra acquistati'}
                </button>
              </div>
              <button
                type="button"
                onClick={clearPurchased}
                className="mt-3 min-h-11 w-full rounded-[var(--ik-radius-control)] border border-[var(--ik-border-strong)] px-3 py-2 text-sm font-bold text-[var(--ik-ink)] hover:bg-[var(--ik-tomato-soft)] sm:w-auto"
              >
                Rimuovi gli acquistati
              </button>
              {purchasedSectionOpen && (
                <ul className="mt-3 grid gap-3">
                  {purchasedItems.map((item) => (
                    <ShoppingListItemRow
                      key={item.id}
                      item={item}
                      onTogglePurchased={toggleItem}
                      registerToggle={registerToggle}
                      onRemove={removeItem}
                      onUpdate={onUpdate}
                      onEdit={openEditor}
                      onCancel={closeEditor}
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
    {removedItems !== null && createPortal(
      <div ref={undoToastContainer} className="[&_.app-overlay]:flex-col [&_.app-overlay]:items-stretch [&_.app-overlay]:gap-2 [&_.app-overlay_button]:min-h-11">
        <UndoToast
          message={removedItems.length === 1 ? `Elemento ${removedItems[0].label} rimosso.` : `${removedItems.length} elementi rimossi.`}
          onUndo={restoreItems}
          onExpire={() => setRemovedItems(null)}
        />
      </div>,
      document.body,
    )}
    </>
  );
}
