import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { useChefChatStore } from '../../ai/chefChatStore';
import { QuickReplies } from './QuickReplies';

interface InputBarProps {
  onSendMessage: (text: string) => void;
  disabled?: boolean;
  showPromptSuggestions?: boolean;
}

export const InputBar = ({ onSendMessage, disabled = false, showPromptSuggestions = false }: InputBarProps) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSending = useChefChatStore((state) => state.isSending);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled || isSending) return;
    onSendMessage(trimmed);
    setText('');
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  };

  const selectPrompt = (prompt: string) => {
    setText(prompt);
    textareaRef.current?.focus();
  };

  return (
    <div className="chef-chat-composer">
      {showPromptSuggestions && !disabled && !isSending && <QuickReplies onQuickReply={selectPrompt} />}
      <form onSubmit={handleSubmit} className="chat-input-bar">
        <div className="chat-input-shell">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Messaggio per Chef"
            placeholder="Scrivi a Chef…"
            className="chat-textarea input-bar-textarea"
            disabled={disabled || isSending}
            rows={1}
          />
          <button
            type="submit"
            disabled={!text.trim() || disabled || isSending}
            className="chat-send-button"
            aria-label="Invia messaggio"
          >
            <Send className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
};

InputBar.displayName = 'InputBar';
