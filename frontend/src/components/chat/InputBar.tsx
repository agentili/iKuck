import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { useChefChatStore } from '../../ai/chefChatStore';

interface InputBarProps {
  onSendMessage: (text: string) => void;
  disabled?: boolean;
}

export const InputBar = ({ onSendMessage, disabled = false }: InputBarProps) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSending = useChefChatStore((state) => state.isSending);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled || isSending) return;
    onSendMessage(trimmed);
    setText('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="chat-input-bar" style={{ position: 'fixed', bottom: '88px', left: '16px', right: '16px', maxWidth: '600px', margin: '0 auto', zIndex: 90 }}>
      <div style={{ backgroundColor: 'var(--sc-cream)', border: '1px solid var(--sc-peach-soft)', borderRadius: '16px', padding: '2px', display: 'flex', alignItems: 'center', gap: '2px' }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Chiedimi una ricetta..."
          className="flex-1 bg-transparent text-[var(--sc-ink)] placeholder-[var(--sc-ink-faint)] text-base resize-none min-h-[48px] max-h-40 px-4 py-2 input-bar-textarea"
          style={{ fontFamily: 'inherit', border: 'none', outline: 'none', minHeight: '48px' }}
          disabled={disabled || isSending}
          rows={1}
        />
        <button
          type="submit"
          disabled={!text.trim() || disabled || isSending}
          className="btn-primary px-5 flex items-center justify-center"
          style={{
            backgroundColor: 'var(--sc-terracotta)',
            color: 'var(--sc-cream)',
            borderRadius: '14px',
            padding: '8px 16px',
            fontWeight: 600,
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            boxShadow: 'var(--sc-shadow-card)',
            opacity: text.trim() && !disabled && !isSending ? 1 : 0.5,
            transition: 'opacity 0.2s',
          }}
          aria-label="Invia messaggio"
        >
          <Send className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
};

InputBar.displayName = 'InputBar';