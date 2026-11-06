import { memo } from 'react';
import { Save, X, Sparkles, ChefHat, Clock, Users } from 'lucide-react';
import type { ChatMessage, TextMessage, RecipeMessage, DraftMessage, ErrorMessage } from './types';

interface MessageBubbleProps {
  message: ChatMessage;
  onSaveDraft?: (recipe: DraftMessage['recipe']) => void;
  onDiscardDraft?: (id: string) => void;
  onStartCooking?: (recipe: RecipeMessage['recipe']) => void;
  onViewRecipe?: (recipe: RecipeMessage['recipe']) => void;
  onSaveRecipe?: (recipe: RecipeMessage['recipe']) => void;
}

const formatTime = (date: Date) => date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

const Tag = ({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'ready' | 'missing' }) => (
  <span
    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
      variant === 'ready'
        ? 'bg-[var(--ik-sage)] text-[var(--ik-ink)]'
        : variant === 'missing'
        ? 'bg-[var(--ik-yolk-soft)] text-[var(--ik-warn-ink)]'
        : 'bg-[var(--ik-sage)] text-[var(--ik-ink)]'
    }`}
  >
    {children}
  </span>
);

const AssistantBubble = memo(({ message }: { message: TextMessage }) => (
  <div
    className="chat-bubble-assistant max-w-[85%] animate-slide-up"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-[var(--ik-ink)]">
      {message.content}
    </p>
    <p className="mt-2 text-right text-xs text-[var(--ik-ink-muted)]">
      {formatTime(message.timestamp)}
    </p>
  </div>
));

const UserBubble = memo(({ message }: { message: TextMessage }) => (
  <div
    className="chat-bubble-user max-w-[85%] ml-auto animate-slide-up"
  >
    <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-[var(--ik-porcelain)]">
      {message.content}
    </p>
    <p className="mt-2 text-right text-xs text-[var(--ik-porcelain)]/70">
      {formatTime(message.timestamp)}
    </p>
  </div>
));

const RecipeBubble = memo(({ message, onStartCooking, onSaveRecipe, onViewRecipe }: { message: RecipeMessage; onStartCooking?: (r: RecipeMessage['recipe']) => void; onSaveRecipe?: (r: RecipeMessage['recipe']) => void; onViewRecipe?: (r: RecipeMessage['recipe']) => void }) => {
  const { recipe } = message;
  return (
    <div
      className="chat-bubble-recipe w-full max-w-xl animate-slide-up"
      role="article"
      aria-label={`Ricetta: ${recipe.title}`}
      onClick={() => onViewRecipe?.(recipe)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewRecipe?.(recipe); }}}
      tabIndex={0}
    >
      <div className="chat-recipe-media relative aspect-[16/9] overflow-hidden">
        <img
          src={recipe.image}
          alt={recipe.title}
          className="w-full h-full object-cover opacity-90"
          loading="lazy"
        />
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
          {recipe.tags.slice(0, 2).map((tag) => (
            <Tag key={tag} variant="default">{tag}</Tag>
          ))}
        </div>
        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
          <span className="chat-badge">
            <Clock className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
            {recipe.time}
          </span>
          <span className="chat-badge">
            <Users className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
            {recipe.servings} pers.
          </span>
        </div>
      </div>
      <div className="p-5">
        <div className="flex flex-wrap gap-1.5 mb-3">
          {recipe.tags.map((tag) => (
            <Tag key={tag} variant="default">{tag}</Tag>
          ))}
        </div>
        <h3 className="mb-2 text-xl font-bold text-[var(--ik-ink)]">
          {recipe.emoji} {recipe.title}
        </h3>
        <p className="text-[var(--ik-ink-muted)] text-sm mb-4 leading-relaxed">{recipe.description}</p>
        <div className="flex gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); onStartCooking?.(recipe); }}
            className="chat-action-primary flex flex-1 items-center justify-center gap-2"
          >
            <ChefHat className="w-5 h-5" aria-hidden="true" />
            Cuciniamo
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onSaveRecipe?.(recipe); }}
            className="chat-action-secondary flex flex-1 items-center justify-center gap-2"
          >
            <Save className="w-5 h-5" aria-hidden="true" />
            Salva
          </button>
        </div>
      </div>
    </div>
  );
});

const DraftBubble = memo(({ message, onSaveDraft, onDiscardDraft }: { message: DraftMessage; onSaveDraft?: (r: DraftMessage['recipe']) => void; onDiscardDraft?: (id: string) => void }) => {
  const { recipe } = message;
  return (
    <div
      className="chat-bubble-draft w-full max-w-xl animate-slide-up"
      role="article"
      aria-label={`Anteprima ricetta: ${recipe.title}`}
    >
      <div className="chat-recipe-media relative aspect-[16/9] overflow-hidden">
        <img
          src={recipe.image}
          alt={recipe.title}
          className="w-full h-full object-cover opacity-90"
          loading="lazy"
        />
        <div className="absolute top-3 left-3">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[var(--ik-yolk)] text-[var(--ik-on-yolk)]">
            <Sparkles className="w-3 h-3 mr-1" aria-hidden="true" />
            Anteprima
          </span>
        </div>
      </div>
      <div className="p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--ik-basil-dark)] mb-1">Anteprima — non ancora salvata</p>
        <h3 className="mb-2 text-xl font-bold text-[var(--ik-ink)]">
          {recipe.emoji} {recipe.title}
        </h3>
        <p className="text-[var(--ik-ink-muted)] text-sm mb-4 leading-relaxed">{recipe.description}</p>
        <div className="grid gap-4 sm:grid-cols-2 mb-4">
          <div>
            <h4 className="font-bold text-[var(--ik-ink)] mb-2">Ingredienti</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--ik-ink-muted)]">
              {recipe.ingredients.map((ing) => (
                <li key={`${recipe.id}-${ing.name}`}>{ing.amount} {ing.name}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-[var(--ik-ink)] mb-2">Procedimento</h4>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--ik-ink-muted)]">
              {recipe.steps.map((step, i) => (
                <li key={`${recipe.id}-step-${i}`}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onSaveDraft?.(recipe)}
            className="chat-action-primary flex flex-1 items-center justify-center gap-2"
          >
            <Save className="w-5 h-5" aria-hidden="true" />
            Salva ricetta
          </button>
          <button
            onClick={() => onDiscardDraft?.(recipe.id)}
            className="chat-action-secondary flex flex-1 items-center justify-center gap-2"
          >
            <X className="w-5 h-5" aria-hidden="true" />
            Scarta
          </button>
        </div>
      </div>
    </div>
  );
});

const ErrorBubble = memo(({ message }: { message: ErrorMessage }) => (
  <div
    className="chat-bubble-error max-w-[85%] animate-slide-up"
    role="alert"
  >
    <p className="text-sm leading-relaxed text-[var(--ik-tomato)]">
      {message.content}
    </p>
    {message.action && (
      <button
        onClick={message.action.onAction}
        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-[var(--ik-tomato)] hover:underline"
      >
        {message.action.label}
      </button>
    )}
  </div>
));

const TypingBubble = memo(() => (
  <div
    className="chat-bubble-assistant max-w-[85%] animate-pulse"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div className="flex items-center gap-2 text-[0.9375rem] text-[var(--ik-ink-muted)]">
      <span className="relative flex h-5 w-5">
        <span className="animate-bounce absolute top-0 left-0 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil)]" style={{ animationDelay: '0ms' }} />
        <span className="animate-bounce absolute top-0 left-1.5 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil)]" style={{ animationDelay: '150ms' }} />
        <span className="animate-bounce absolute top-0 left-3 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil)]" style={{ animationDelay: '300ms' }} />
      </span>
      <span>Chef sta pensando...</span>
    </div>
  </div>
));

export const MessageBubble = memo(({ message, onSaveDraft, onDiscardDraft, onStartCooking, onViewRecipe, onSaveRecipe }: MessageBubbleProps) => {
  switch (message.type) {
    case 'text':
      return message.role === 'user' ? <UserBubble message={message} /> : <AssistantBubble message={message} />;
    case 'recipe':
      return <RecipeBubble message={message} onStartCooking={onStartCooking} onSaveRecipe={onSaveRecipe} onViewRecipe={onViewRecipe} />;
    case 'draft':
      return <DraftBubble message={message} onSaveDraft={onSaveDraft} onDiscardDraft={onDiscardDraft} />;
    case 'error':
      return <ErrorBubble message={message} />;
    case 'typing':
      return <TypingBubble />;
    default:
      return null;
  }
});

MessageBubble.displayName = 'MessageBubble';