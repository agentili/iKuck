import { useRef, useState } from 'react';
import { Mic, Camera, Send } from 'lucide-react';
import { useChatStore } from './chatStore';

interface InputBarProps {
  onSendMessage: (text: string) => void;
  onVoiceInput?: () => void;
  onScanner?: () => void;
  disabled?: boolean;
}

export const InputBar = ({ onSendMessage, onVoiceInput, onScanner, disabled = false }: InputBarProps) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = useChatStore((state) => state.isGenerating);
  const isSaving = useChatStore((state) => state.isSaving);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled || isGenerating || isSaving) return;
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

  const handleVoice = () => {
    if (onVoiceInput) onVoiceInput();
  };

  const handleScanner = () => {
    if (onScanner) onScanner();
  };

  return (
    <form onSubmit={handleSubmit} className="chat-input-bar">
      <div className="chat-input-controls">
        <button
          type="button"
          onClick={handleVoice}
          disabled={disabled || isGenerating || isSaving}
          className="p-2 rounded-xl text-[var(--ik-ink-muted)] hover:bg-[var(--ik-sage)] transition-colors"
          aria-label="Input vocale"
        >
          <Mic className="w-6 h-6" aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Chiedimi una ricetta..."
          className="flex-1 bg-transparent text-[var(--ik-ink)] placeholder-[var(--ik-ink-muted)] text-base resize-none min-h-[48px] max-h-40 px-4 py-2 input-bar-textarea"
          disabled={disabled || isGenerating || isSaving}
          rows={1}
        />
        <button
          type="button"
          onClick={handleScanner}
          disabled={disabled || isGenerating || isSaving}
          className="p-2 rounded-xl text-[var(--ik-ink-muted)] hover:bg-[var(--ik-sage)] transition-colors"
          aria-label="Scanner ingredienti"
        >
          <Camera className="w-6 h-6" aria-hidden="true" />
        </button>
        <button
          type="submit"
          disabled={!text.trim() || disabled || isGenerating || isSaving}
          className="chat-action-primary chat-submit-button btn-primary flex items-center justify-center px-5"
          aria-label="Invia messaggio"
        >
          <Send className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
};

InputBar.displayName = 'InputBar';