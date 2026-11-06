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
        ? 'bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'
        : variant === 'missing'
        ? 'bg-[var(--ik-yolk-soft)] text-[var(--ik-warn-ink)]'
        : 'bg-[var(--ik-sage)] text-[var(--ik-basil-dark)]'
    }`}
  >
    {children}
  </span>
);

const AssistantBubble = memo(({ message }: { message: TextMessage }) => (
  <div
    className="chat-bubble-assistant max-w-[85%] animate-slide-up"
    style={{
      backgroundColor: 'var(--ik-porcelain)',
      color: 'var(--ik-ink)',
      borderRadius: 'var(--ik-radius-panel)',
      borderBottomLeftRadius: '6px',
      padding: '14px 18px',
      border: '1px solid var(--ik-sage)',
      boxShadow: 'var(--ik-shadow-card)',
    }}
  >
    <p className="whitespace-pre-wrap text-[var(--ik-ink)] leading-relaxed" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif', fontSize: '0.9375rem', lineHeight: 1.5 }}>
      {message.content}
    </p>
    <time dateTime={message.timestamp.toISOString()} className="mt-2 block text-[var(--ik-ink-muted)] text-xs text-right" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
      {formatTime(message.timestamp)}
    </time>
  </div>
));

const UserBubble = memo(({ message }: { message: TextMessage }) => (
  <div
    className="chat-bubble-user max-w-[85%] ml-auto animate-slide-up"
    style={{
      backgroundColor: 'var(--ik-basil-dark)',
      color: 'var(--ik-porcelain)',
      borderRadius: 'var(--ik-radius-panel)',
      borderBottomRightRadius: '6px',
      padding: '14px 18px',
      opacity: message.isOptimistic ? 0.7 : 1,
    }}
  >
    <p className="whitespace-pre-wrap text-[var(--ik-porcelain)] leading-relaxed" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif', fontSize: '0.9375rem', lineHeight: 1.5 }}>
      {message.content}
    </p>
    <time dateTime={message.timestamp.toISOString()} className="mt-2 block text-[var(--ik-porcelain)]/70 text-xs text-right" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
      {formatTime(message.timestamp)}
    </time>
  </div>
));

const RecipeBubble = memo(({ message, onStartCooking, onSaveRecipe, onViewRecipe }: { message: RecipeMessage; onStartCooking?: (r: RecipeMessage['recipe']) => void; onSaveRecipe?: (r: RecipeMessage['recipe']) => void; onViewRecipe?: (r: RecipeMessage['recipe']) => void }) => {
  const { recipe } = message;
  return (
    <div
      className="chat-bubble-recipe w-full max-w-xl animate-slide-up"
      role="article"
      aria-label={`Ricetta: ${recipe.title}`}
      style={{
        backgroundColor: 'var(--ik-porcelain)',
        borderRadius: 'var(--ik-radius-feature)',
        border: '1px solid var(--ik-sage)',
        boxShadow: 'var(--ik-shadow-card)',
        overflow: 'hidden',
      }}
      onClick={() => onViewRecipe?.(recipe)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewRecipe?.(recipe); }
      }}
      tabIndex={0}
    >
      <div className="relative aspect-[16/9] overflow-hidden" style={{ backgroundColor: 'var(--ik-sage)' }}>
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
          <span className="chat-badge" style={{ fontSize: '12px', padding: '6px 10px' }}>
            <Clock className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
            {recipe.time}
          </span>
          <span className="chat-badge" style={{ fontSize: '12px', padding: '6px 10px' }}>
            <Users className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
            {recipe.servings} pers.
          </span>
        </div>
      </div>
      <div className="p-5" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {recipe.tags.map((tag) => (
            <Tag key={tag} variant="default">{tag}</Tag>
          ))}
        </div>
        <h3 className="text-xl font-bold text-[var(--ik-ink)] mb-2" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
          {recipe.emoji} {recipe.title}
        </h3>
        <p className="text-[var(--ik-ink-muted)] text-sm mb-4 leading-relaxed">{recipe.description}</p>
        <div className="flex gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); onStartCooking?.(recipe); }}
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--ik-basil-dark)',
              color: 'var(--ik-porcelain)',
              borderRadius: '16px',
              padding: '14px 24px',
              fontWeight: 600,
              fontSize: '15px',
              border: 'none',
              cursor: 'pointer',
              boxShadow: 'var(--ik-shadow-card)',
            }}
          >
            <ChefHat className="w-5 h-5" aria-hidden="true" />
            Cuciniamo
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onSaveRecipe?.(recipe); }}
            className="btn-secondary flex-1 flex items-center justify-center"
            style={{
              backgroundColor: 'var(--ik-porcelain)',
              color: 'var(--ik-basil-dark)',
              border: '2px solid var(--ik-basil-dark)',
              borderRadius: '16px',
              padding: '12px 24px',
              fontWeight: 600,
              fontSize: '14px',
              cursor: 'pointer',
            }}
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
      className="chat-bubble-recipe w-full max-w-xl animate-slide-up border-dashed border-2"
      role="article"
      aria-label={`Anteprima ricetta: ${recipe.title}`}
      style={{
        backgroundColor: 'var(--ik-sage)',
        borderColor: 'var(--ik-basil-dark)',
        borderRadius: 'var(--ik-radius-feature)',
        boxShadow: 'var(--ik-shadow-card)',
        overflow: 'hidden',
      }}
    >
      <div className="relative aspect-[16/9] overflow-hidden" style={{ backgroundColor: 'var(--ik-sage)' }}>
        <img
          src={recipe.image}
          alt={recipe.title}
          className="w-full h-full object-cover opacity-90"
          loading="lazy"
        />
        <div className="absolute top-3 left-3">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[var(--ik-basil-dark)] text-[var(--ik-porcelain)]">
            <Sparkles className="w-3 h-3 mr-1" aria-hidden="true" />
            Anteprima
          </span>
        </div>
      </div>
      <div className="p-5" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--ik-basil-dark)] mb-1">Anteprima — non ancora salvata</p>
        <h3 className="text-xl font-bold text-[var(--ik-ink)] mb-2" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
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
            className="btn-primary flex-1 flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--ik-basil-dark)',
              color: 'var(--ik-porcelain)',
              borderRadius: '16px',
              padding: '14px 24px',
              fontWeight: 600,
              fontSize: '15px',
              border: 'none',
              cursor: 'pointer',
              boxShadow: 'var(--ik-shadow-card)',
            }}
          >
            <Save className="w-5 h-5" aria-hidden="true" />
            Salva ricetta
          </button>
          <button
            onClick={() => onDiscardDraft?.(recipe.id)}
            className="btn-secondary flex-1 flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--ik-porcelain)',
              color: 'var(--ik-basil-dark)',
              border: '2px solid var(--ik-basil-dark)',
              borderRadius: '16px',
              padding: '12px 24px',
              fontWeight: 600,
              fontSize: '14px',
              cursor: 'pointer',
            }}
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
    style={{
      backgroundColor: 'var(--ik-tomato-soft)',
      color: 'var(--ik-tomato)',
      borderRadius: 'var(--ik-radius-panel)',
      padding: '12px 16px',
      border: '1px solid var(--ik-tomato-soft)',
    }}
  >
    <p className="text-[var(--ik-tomato)] text-sm leading-relaxed" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}>
      {message.content}
    </p>
    {message.action && (
      <button
        onClick={message.action.onAction}
        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-[var(--ik-tomato)] hover:underline"
        style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif' }}
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
    style={{
      backgroundColor: 'var(--ik-porcelain)',
      color: 'var(--ik-ink)',
      borderRadius: 'var(--ik-radius-panel)',
      borderBottomLeftRadius: '6px',
      padding: '14px 18px',
      border: '1px solid var(--ik-sage)',
      boxShadow: 'var(--ik-shadow-card)',
    }}
  >
    <div className="flex items-center gap-2 text-[var(--ik-ink-muted)]" style={{ fontFamily: 'Bricolage Grotesque Variable, system-ui, sans-serif', fontSize: '0.9375rem' }}>
      <span className="relative flex h-5 w-5">
        <span className="animate-bounce absolute top-0 left-0 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil-dark)]" style={{ animationDelay: '0ms' }} />
        <span className="animate-bounce absolute top-0 left-1.5 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil-dark)]" style={{ animationDelay: '150ms' }} />
        <span className="animate-bounce absolute top-0 left-3 h-1.5 w-1.5 rounded-full bg-[var(--ik-basil-dark)]" style={{ animationDelay: '300ms' }} />
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