import { Link } from 'react-router-dom';
import { DailyRecipeCard } from './DailyRecipeCard';

const quickNavigationDestinations = [
  { label: 'Piano settimanale', description: 'Una ricetta al giorno', to: '/plan', icon: 'calendar' },
  { label: 'Ricettario', description: 'Ritrova le tue ricette', to: '/recipes', icon: 'book' },
  { label: 'Dispensa', description: 'Aggiungi ingredienti e conferma gli acquisti', to: '/pantry', icon: 'pantry' },
  { label: 'Lista della spesa Bring', description: 'Leggi e aggiorna la lista Bring', to: '/shopping-list', icon: 'basket' },
] as const;

type QuickNavigationIconName = (typeof quickNavigationDestinations)[number]['icon'];

const QuickNavigationIcon = ({ name }: { name: QuickNavigationIconName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5">
    {name === 'calendar' && <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" /></>}
    {name === 'book' && <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20M8 7h8M8 10h7" /></>}
    {name === 'pantry' && <><path d="M4 7h16l1 13H3L4 7zM5 7l2-4h10l2 4" /><path d="M12 10v6M9 13h6" /></>}
    {name === 'basket' && <><path d="M3 10h18l-2 10H5L3 10zM7 10l3-6M17 10l-3-6M8 13v4M12 13v4M16 13v4" /></>}
  </svg>
);

const ChefQuickLinks = () => (
  <section aria-labelledby="chef-tools-title" className="px-4 pb-5 pt-5">
    <h2 id="chef-tools-title" className="text-lg font-bold text-[var(--ik-ink)]">Prosegui in cucina</h2>
    <div role="group" aria-label="Prosegui in cucina" className="chef-chat-quick-navigation mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
    {quickNavigationDestinations.map(({ label, description, to, icon }) => (
      <Link
        key={to}
        to={to}
        className="group flex min-h-[4.5rem] items-center gap-3 rounded-2xl border border-[var(--ik-border)] bg-[var(--ik-surface)] px-4 py-3 text-[var(--ik-ink)] transition-colors hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-basil)]"
      >
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--ik-sage)] text-[var(--ik-basil-dark)] group-hover:bg-[var(--ik-surface)]">
          <QuickNavigationIcon name={icon} />
        </span>
        <span className="min-w-0 text-left">
          <span className="block text-sm font-bold">{label}</span>
          <span className="mt-0.5 block text-xs font-normal text-[var(--ik-ink-muted)]">{description}</span>
        </span>
      </Link>
    ))}
    </div>
  </section>
);

export const ChatView = () => (
  <main id="main-content" className="chef-chat-page mx-auto w-full max-w-2xl bg-[var(--ik-porcelain)]">
    <header className="px-4 pb-1 pt-5">
      <h1 className="text-[1.5rem] font-bold tracking-tight text-[var(--ik-ink)]">Cosa cuciniamo oggi?</h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--ik-ink-muted)]">
        Trova una ricetta adatta alla tua dispensa e organizza i pasti della settimana.
      </p>
    </header>
    <DailyRecipeCard />
    <ChefQuickLinks />
  </main>
);

ChatView.displayName = 'ChatView';
