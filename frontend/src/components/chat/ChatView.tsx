import { DailyRecipeCard } from './DailyRecipeCard';

export const ChatView = () => (
  <main id="main-content" className="chef-chat-page mx-auto w-full max-w-2xl bg-[var(--ik-porcelain)]">
    <header className="px-4 pb-1 pt-5">
      <h1 className="text-[1.5rem] font-bold tracking-tight text-[var(--ik-ink)]">Oggi lo chef propone...</h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--ik-ink-muted)]">
        Trova una ricetta adatta alla tua dispensa e organizza i pasti della settimana.
      </p>
    </header>
    <DailyRecipeCard />
  </main>
);

ChatView.displayName = 'ChatView';
