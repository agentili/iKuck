import type { PantryMergeSummary } from '@ikuck/shared/pantryMerge';

interface PantryMergeNoticeProps {
  summary: PantryMergeSummary;
  onDismiss: () => void;
}

const pluralize = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;

export default function PantryMergeNotice({ summary, onDismiss }: PantryMergeNoticeProps) {
  return (
    <aside role="status" className="mx-auto mt-4 flex w-full max-w-6xl flex-wrap items-start justify-between gap-3 rounded-2xl border-2 border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-950 shadow-sm sm:px-5">
      <div>
        <p className="font-bold">Dispensa della casa aggiornata automaticamente.</p>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {summary.addedLots > 0 && <li>{pluralize(summary.addedLots, 'elemento aggiunto', 'elementi aggiunti')}</li>}
          {summary.mergedLots > 0 && <li>{pluralize(summary.mergedLots, 'duplicato unito', 'duplicati uniti')}</li>}
          {summary.importedStaples > 0 && <li>{pluralize(summary.importedStaples, 'ingrediente di base aggiunto', 'ingredienti di base aggiunti')}</li>}
        </ul>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Chiudi riepilogo fusione dispensa" className="min-h-10 rounded-xl border-2 border-emerald-700 px-3 py-1.5 text-sm font-bold text-emerald-900 hover:bg-emerald-100">Chiudi</button>
    </aside>
  );
}
