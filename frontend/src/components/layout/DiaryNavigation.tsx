import { Link, useLocation } from 'react-router-dom';

export default function DiaryNavigation() {
  const { pathname } = useLocation();
  const activityCurrent = pathname === '/activity';
  return (
    <nav aria-label="Sezioni del Diario" className="mb-6 flex flex-wrap gap-2 border-b border-[var(--ik-border)] pb-3">
      <Link to="/dinner-diary" aria-current={!activityCurrent ? 'page' : undefined} className="inline-flex min-h-11 items-center rounded-xl border border-transparent px-4 py-2 font-bold text-[var(--ik-ink-muted)] hover:bg-[var(--ik-mist)] hover:text-[var(--ik-ink)] aria-[current=page]:border-[var(--ik-border)] aria-[current=page]:bg-[var(--ik-sage)] aria-[current=page]:text-[var(--ik-basil-dark)]">Cene</Link>
      <Link to="/activity" aria-current={activityCurrent ? 'page' : undefined} className="inline-flex min-h-11 items-center rounded-xl border border-transparent px-4 py-2 font-bold text-[var(--ik-ink-muted)] hover:bg-[var(--ik-mist)] hover:text-[var(--ik-ink)] aria-[current=page]:border-[var(--ik-border)] aria-[current=page]:bg-[var(--ik-sage)] aria-[current=page]:text-[var(--ik-basil-dark)]">Attività</Link>
    </nav>
  );
}
