import { useState, useSyncExternalStore } from 'react';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

export function usePagination<T>(items: readonly T[], identity: string, label = 'Paginazione') {
  const scope = useSyncExternalStore(subscribeActiveDataScope, getActiveDataScope, getActiveDataScope);
  const key = JSON.stringify([scope, identity]);
  const [selection, setSelection] = useState({ page: 1, size: 20, key });
  const pages = Math.max(1, Math.ceil(items.length / selection.size));
  const page = key === selection.key ? Math.min(selection.page, pages) : 1;
  // Remember resets and clamps so returning to a filter or adding an item cannot restore an old page.
  if (selection.key !== key || selection.page !== page) setSelection({ ...selection, page, key });
  const changePage = (next: number) => setSelection((current) => ({ ...current, page: Math.max(1, Math.min(next, pages)), key }));
  const controls = <nav className="pagination" aria-label={label}>
    <label>Per pagina <select value={selection.size} onChange={(event) => setSelection({ page: 1, size: Number(event.target.value), key })}>{[10, 20, 40].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    <button type="button" disabled={page === 1} onClick={() => changePage(page - 1)}>Indietro</button>
    <span role="status">Pagina {page} di {pages} · {items.length} elementi</span>
    <button type="button" disabled={page === pages} onClick={() => changePage(page + 1)}>Avanti</button>
  </nav>;
  return { visible: items.slice((page - 1) * selection.size, page * selection.size), controls };
}
