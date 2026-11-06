import { Search } from 'lucide-react';

interface SuggestionControlsProps {
  allowOneMissing: boolean;
  disabled: boolean;
  onAllowOneMissingChange: (value: boolean) => void;
  onSearch: () => void;
}

export default function SuggestionControls({ allowOneMissing, disabled, onAllowOneMissingChange, onSearch }: SuggestionControlsProps) {
  return (
    <section aria-label="Opzioni ricette" className="ik-action-panel flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
      <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm sm:text-base">
        <input type="checkbox" checked={allowOneMissing} onChange={(event) => onAllowOneMissingChange(event.target.checked)} className="h-5 w-5 accent-[var(--ik-yolk)]" />
        <span>Anche con 1 ingrediente in più</span>
      </label>
      <button type="button" disabled={disabled} onClick={onSearch} className="inline-flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--ik-yolk)] px-3 py-3 text-center text-sm font-bold leading-snug text-[var(--ik-on-yolk)] transition hover:bg-[var(--ik-yolk-hover)] disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none sm:px-5 sm:text-base">
        <Search size={19} aria-hidden="true" />
        Trova ricette
      </button>
    </section>
  );
}
