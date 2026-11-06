import { memo } from 'react';

interface QuickRepliesProps {
  onQuickReply: (prompt: string) => void;
}

const prompts = [
  { id: 'dinner', label: 'Idea per cena', prompt: 'Dammi un’idea per una cena semplice.' },
  { id: 'vegetarian', label: 'Ricetta vegetariana', prompt: 'Suggerisci una ricetta vegetariana semplice.' },
  { id: 'side-dish', label: 'Contorno semplice', prompt: 'Suggerisci un contorno facile da preparare.' },
] as const;

export const QuickReplies = memo(({ onQuickReply }: QuickRepliesProps) => (
  <div className="chef-quick-replies flex w-full flex-nowrap gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Spunti per iniziare" tabIndex={0}>
    {prompts.map(({ id, label, prompt }) => (
      <button
        key={id}
        type="button"
        onClick={() => onQuickReply(prompt)}
        className="chat-quick-reply inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-[var(--ik-border-strong)] bg-[var(--ik-sage)] px-3 py-2 text-sm font-medium text-[var(--ik-basil-dark)] transition-colors hover:bg-[var(--ik-mist)]"
      >
        {label}
      </button>
    ))}
  </div>
));

QuickReplies.displayName = 'QuickReplies';
