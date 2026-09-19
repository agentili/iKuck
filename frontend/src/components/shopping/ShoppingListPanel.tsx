import { Check, Circle, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { PantryUnit, ShoppingListItem, ShoppingListItemPayload } from '@ikuck/shared/contracts';
import { parseIngredientInput } from '../../domain/ingredients';
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
  if (errors.includes('quantity_finite')) return 'La quantità deve essere un numero valido.';
  if (errors.includes('quantity_positive')) return 'La quantità deve essere maggiore di zero.';
  if (errors.includes('unit_required')) return 'Se indichi una quantità, scegli anche l’unità.';
  if (errors.includes('quantity_required')) return 'Scegli una quantità oppure lascia vuota l’unità.';
  if (errors.includes('note_too_long')) return 'La nota è troppo lunga.';
  return 'Controlla i dettagli inseriti.';
};

const unitLabel = (unit: PantryUnit | null): string => units.find((option) => option.value === unit)?.label ?? unit ?? '';

function ShoppingItemEditor({ item, onUpdate }: { item: ShoppingListItem; onUpdate: ShoppingListPanelProps['onUpdate'] }) {
  const [label, setLabel] = useState(item.label);
  const [quantity, setQuantity] = useState(item.quantity === null ? '' : String(item.quantity));
  const [unit, setUnit] = useState<PantryUnit | ''>(item.unit ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedQuantity = parseQuantity(quantity);
    const parsedUnit = unit === '' ? null : unit;
    const parsedNote = note.trim().length > 0 ? note.trim() : null;
    const errors = validateShoppingListItemDetails(label, parsedQuantity, parsedUnit, parsedNote);
    if (errors.length > 0) {
      setSaved(false);
      setError(errorMessage(errors));
      return;
    }
    if (!onUpdate(item.id, { label, quantity: parsedQuantity, unit: parsedUnit, note: parsedNote })) {
      setSaved(false);
      setError('Non è stato possibile aggiornare l’elemento.');
      return;
    }
    setError(null);
    setSaved(true);
  };

  return (
    <details className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold text-gray-700">Modifica dettagli</summary>
      <form className="mt-3 grid gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-sm font-semibold text-gray-700">
          Nome
          <input value={label} onChange={(event) => setLabel(event.target.value)} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-semibold text-gray-700">
            Quantità
            <input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3" />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-gray-700">
            Unità
            <select value={unit} onChange={(event) => setUnit(event.target.value as PantryUnit | '')} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3">
              <option value="">Nessuna</option>
              {units.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <label className="grid gap-1 text-sm font-semibold text-gray-700">
          Nota
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={120} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3" />
        </label>
        {error !== null && <p role="alert" className="text-sm font-semibold text-rose-700">{error}</p>}
        {saved && <p role="status" className="text-sm font-semibold text-emerald-700">Dettagli aggiornati.</p>}
        <button type="submit" className="min-h-10 rounded-lg bg-gray-900 px-3 py-2 text-sm font-bold text-white hover:bg-gray-800">Salva dettagli</button>
      </form>
    </details>
  );
}

function ShoppingListItemRow({ item, onTogglePurchased, onRemove, onUpdate }: Omit<ShoppingListPanelProps, 'items' | 'onAdd' | 'onClearPurchased'> & { item: ShoppingListItem }) {
  const recipe = item.sourceRecipeId === null ? undefined : getRecipeById(item.sourceRecipeId);
  const quantity = item.quantity === null ? 'Quantità non indicata' : `${item.quantity} ${unitLabel(item.unit)}`;

  return (
    <li className={`rounded-2xl border-2 p-4 ${item.purchased ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-pressed={item.purchased}
          aria-label={item.purchased ? `Segna ${item.label} come da acquistare` : `Segna ${item.label} come acquistato`}
          onClick={() => onTogglePurchased(item.id)}
          className="mt-0.5 grid min-h-11 min-w-11 place-items-center rounded-xl border-2 border-gray-300 text-emerald-700 hover:border-emerald-600"
        >
          {item.purchased ? <Check size={20} aria-hidden="true" /> : <Circle size={20} aria-hidden="true" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className={`font-bold text-gray-950 ${item.purchased ? 'line-through decoration-2' : ''}`}>{item.label}</p>
          <p className="mt-1 text-sm text-gray-600">{quantity}</p>
          {item.note !== null && <p className="mt-1 text-sm text-gray-600">Nota: {item.note}</p>}
          {recipe !== undefined && <p className="mt-1 text-sm font-semibold text-emerald-800">Dalla ricetta: {recipe.title}</p>}
        </div>
        <button type="button" aria-label={`Rimuovi ${item.label}`} onClick={() => onRemove(item.id)} className="grid min-h-11 min-w-11 place-items-center rounded-xl text-gray-600 hover:bg-rose-50 hover:text-rose-700">
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </div>
      {!item.purchased && <ShoppingItemEditor item={item} onUpdate={onUpdate} />}
    </li>
  );
}

export default function ShoppingListPanel({ items, onAdd, onTogglePurchased, onRemove, onRestoreItem, onUpdate, onClearPurchased }: ShoppingListPanelProps) {
  const [label, setLabel] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<PantryUnit | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removedItems, setRemovedItems] = useState<ShoppingListItem[] | null>(null);
  const pendingItems = items.filter((item) => !item.purchased);
  const purchasedItems = items.filter((item) => item.purchased);

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
    const restored = removedItems.every((item) => onRestoreItem !== undefined
      ? onRestoreItem(item)
      : onAdd(item) !== null);
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
    <section aria-labelledby="shopping-list-title" className="rounded-3xl border-2 border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-emerald-800"><ShoppingCart size={16} aria-hidden="true" /> Spesa</p>
          <h2 id="shopping-list-title" className="mt-1 text-3xl font-black text-gray-950">Lista della spesa</h2>
          <p className="mt-1 text-gray-600">Aggiungi quello che manca. La lista resta disponibile anche offline.</p>
        </div>
        {purchasedItems.length > 0 && <button type="button" onClick={clearPurchased} className="min-h-11 rounded-xl border-2 border-gray-300 px-3 py-2 text-sm font-bold text-gray-800 hover:border-gray-900">Rimuovi gli acquistati</button>}
      </header>

      <form className="mt-6 grid gap-3" onSubmit={submit}>
        <label htmlFor="shopping-item-label" className="text-sm font-semibold text-gray-700">Cosa ti serve?</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input id="shopping-item-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="es. latte, detersivo, mele" className="min-h-12 flex-1 rounded-xl border-2 border-gray-200 bg-gray-50 px-3 text-base outline-none focus:border-emerald-600" />
          <button type="submit" aria-label="Aggiungi alla lista" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800"><Plus size={18} aria-hidden="true" /> Aggiungi</button>
        </div>
        <details className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-gray-700">Aggiungi dettagli (facoltativi)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-gray-700">
              Quantità da acquistare
              <input type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3" />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-gray-700">
              Unità di misura della spesa
              <select value={unit} onChange={(event) => setUnit(event.target.value as PantryUnit | '')} className="min-h-10 rounded-lg border border-gray-300 bg-white px-3">
                <option value="">Nessuna</option>
                {units.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-semibold text-gray-700 sm:col-span-2">
              Nota (facoltativa)
              <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={120} placeholder="es. senza lattosio" className="min-h-10 rounded-lg border border-gray-300 bg-white px-3" />
            </label>
          </div>
        </details>
        {error !== null && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800">{error}</p>}
        {message !== null && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{message}</p>}
      </form>

      {items.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-gray-300 p-5 text-gray-600">La lista è vuota</p>
      ) : (
        <div className="mt-6 space-y-6">
          {pendingItems.length > 0 && (
            <section aria-labelledby="shopping-pending-title">
              <h3 id="shopping-pending-title" className="text-lg font-black text-gray-950">Da acquistare <span className="font-semibold text-gray-500">({pendingItems.length})</span></h3>
              <ul className="mt-3 grid gap-3">{pendingItems.map((item) => <ShoppingListItemRow key={item.id} item={item} onTogglePurchased={onTogglePurchased} onRemove={removeItem} onUpdate={onUpdate} />)}</ul>
            </section>
          )}
          {purchasedItems.length > 0 && (
            <section aria-labelledby="shopping-purchased-title">
              <h3 id="shopping-purchased-title" className="text-lg font-black text-gray-950">Acquistati <span className="font-semibold text-gray-500">({purchasedItems.length})</span></h3>
              <ul className="mt-3 grid gap-3">{purchasedItems.map((item) => <ShoppingListItemRow key={item.id} item={item} onTogglePurchased={onTogglePurchased} onRemove={removeItem} onUpdate={onUpdate} />)}</ul>
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
