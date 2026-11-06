import { Link } from 'react-router-dom';
import { DailyRecipeCard } from './DailyRecipeCard';

const quickNavigationDestinations = [
  { label: 'Ricette', to: '/recipes' },
  { label: 'Dispensa', to: '/pantry' },
  { label: 'Spesa', to: '/shopping-list' },
  { label: 'Casa', to: '/house' },
  { label: 'Cucina viva', to: '/cucina' },
] as const;

const ChefQuickLinks = () => (
  <div role="group" aria-label="Risposte rapide" className="chef-chat-quick-navigation mt-3 flex flex-wrap items-center gap-2">
    {quickNavigationDestinations.map(({ label, to }) => (
      <Link
        key={to}
        to={to}
        className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-[var(--ik-border)] bg-[var(--ik-surface)] px-3 py-2 text-sm font-semibold text-[var(--ik-ink)] hover:bg-[var(--ik-sage)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ik-basil)]"
      >
        {label}
      </Link>
    ))}
  </div>
);

export const ChatView = () => (
  <main id="main-content" className="chef-chat-page mx-auto w-full max-w-2xl bg-[var(--ik-porcelain)]">
    <DailyRecipeCard />
    <section className="px-4 pt-3" aria-labelledby="chef-landing-title">
      <h1 id="chef-landing-title" className="text-2xl font-bold text-[var(--ik-ink)]">Chef</h1>
      <div className="mt-3 rounded-[var(--ik-radius-panel)] border border-[var(--ik-border)] bg-[var(--ik-surface)] p-4" role="status">
        <p className="font-semibold text-[var(--ik-ink)]">Chat AI non disponibile. La chat AI è stata rinviata.</p>
        <p className="mt-1 text-sm text-[var(--ik-ink-muted)]">
          La ricetta del giorno e le scorciatoie qui sotto restano disponibili.
        </p>
      </div>
      <ChefQuickLinks />
    </section>
  </main>
);

ChatView.displayName = 'ChatView';
