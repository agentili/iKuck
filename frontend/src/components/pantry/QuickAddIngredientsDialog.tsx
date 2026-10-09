import { useEffect, useRef } from 'react';
import type { ParsedIngredient } from '../../domain/types';
import { getActiveDataScope } from '../../sync/scopeContext';
import IngredientInput from './IngredientInput';

interface QuickAddIngredientsDialogProps {
  open: boolean;
  scope: string;
  onClose: () => void;
  onAdd: (items: ParsedIngredient[]) => void;
}

export default function QuickAddIngredientsDialog({ open, scope, onClose, onAdd }: QuickAddIngredientsDialogProps) {
  const scopeAtOpen = useRef(scope);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) {
      scopeAtOpen.current = scope;
      return;
    }
    if (scopeAtOpen.current !== scope) {
      onClose();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    document.getElementById('quick-add-input')?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute('open');
    };
  }, [onClose, open, scope]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgb(24_48_40_/_0.55)] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <dialog
        ref={dialogRef}
        aria-labelledby="quick-add-title"
        className="ik-quick-add-dialog w-full max-w-xl rounded-3xl border border-[var(--ik-border)] bg-[var(--ik-porcelain)] p-5 shadow-2xl sm:p-7"
        onCancel={(event) => {
          event.preventDefault();
          if (dialogRef.current?.querySelector('[role="combobox"]')?.getAttribute('aria-expanded') !== 'true') onClose();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const dialog = dialogRef.current;
          if (dialog === null) return;
          const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter((element) => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="ik-eyebrow">Dispensa · {scope.startsWith('house:') ? 'Casa' : scope === 'guest' ? 'dati locali' : 'account'}</p>
            <h2 id="quick-add-title" className="mt-1 text-2xl font-black">Aggiungi ingredienti</h2>
            <p className="mt-1 text-sm text-gray-700">Le aggiunte aggiornano la stessa dispensa usata in Dispensa.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Chiudi dialogo" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-gray-300 font-bold hover:bg-white">×</button>
        </div>
        <IngredientInput
          idBase="quick-add"
          onAdd={(items) => {
            if (scopeAtOpen.current !== scope || getActiveDataScope() !== scopeAtOpen.current) {
              onClose();
              return;
            }
            onAdd(items);
            onClose();
          }}
        />
      </dialog>
    </div>
  );
}
