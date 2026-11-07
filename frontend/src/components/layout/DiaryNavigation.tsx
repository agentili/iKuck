import { Link, useLocation } from 'react-router-dom';

export default function DiaryNavigation() {
  const { pathname } = useLocation();
  const isDiary = pathname === '/dinner-diary';
  const isActivity = pathname === '/activity';

  return (
    <nav aria-label="Sezioni del Diario" className="mb-5 flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-3">
      <Link
        to="/dinner-diary"
        aria-current={isDiary ? 'page' : undefined}
        className={`inline-flex min-h-11 items-center rounded-xl px-4 py-2 font-bold transition-colors ${
          isDiary
            ? 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]'
            : 'text-[var(--color-text)] hover:bg-[var(--color-surface)]'
        }`}
      >
        Cene
      </Link>
      <Link
        to="/activity"
        aria-current={isActivity ? 'page' : undefined}
        className={`inline-flex min-h-11 items-center rounded-xl px-4 py-2 font-bold transition-colors ${
          isActivity
            ? 'bg-[var(--color-primary)] text-[var(--color-on-primary-action)]'
            : 'text-[var(--color-text)] hover:bg-[var(--color-surface)]'
        }`}
      >
        Attività
      </Link>
    </nav>
  );
}