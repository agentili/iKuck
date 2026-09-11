import { Search } from 'lucide-react';

interface SuggestionControlsProps {
  allowOneMissing: boolean;
  disabled: boolean;
  onAllowOneMissingChange: (value: boolean) => void;
  onSearch: () => void;
}

export default function SuggestionControls({ allowOneMissing, disabled, onAllowOneMissingChange, onSearch }: SuggestionControlsProps) {
  return (
    <section aria-label="Opzioni ricette" className="flex flex-col gap-3 rounded-2xl bg-gray-900 p-4 text-white sm:flex-row sm:items-center sm:justify-between">
      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        <input type="checkbox" checked={allowOneMissing} onChange={(event) => onAllowOneMissingChange(event.target.checked)} className="h-5 w-5 accent-amber-400" />
        <span>Anche con 1 ingrediente in più</span>
      </label>
      <button type="button" disabled={disabled} onClick={onSearch} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-gray-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-45">
        <Search size={19} aria-hidden="true" />
        Trova ricette
      </button>
    </section>
  );
}
