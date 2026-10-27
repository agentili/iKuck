import { memo } from 'react';
import { useChatStore } from './chatStore';

interface QuickRepliesProps {
  onQuickReply?: (action: string) => void;
}

export const QuickReplies = memo(({ onQuickReply }: QuickRepliesProps) => {
  const quickReplies = useChatStore((state) => state.quickReplies);
  const handleQuickReply = useChatStore((state) => state.handleQuickReply);

  const handleClick = (action: string) => {
    if (onQuickReply) {
      onQuickReply(action);
    } else {
      handleQuickReply(action as any);
    }
  };

  return (
    <div className="flex flex-wrap gap-2 justify-center px-4 pb-4" role="group" aria-label="Risposte rapide">
      {quickReplies.map((reply) => (
        <button
          key={reply.id}
          onClick={() => handleClick(reply.action)}
          className="chat-quick-reply"
          style={{
            backgroundColor: 'var(--sc-peach-soft)',
            color: 'var(--sc-terracotta)',
            border: '1px solid var(--sc-apricot-soft)',
            borderRadius: 'var(--sc-radius-pill)',
            padding: '10px 16px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s',
            fontFamily: 'DM Sans, system-ui, sans-serif',
          }}
          aria-label={reply.label}
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
});

QuickReplies.displayName = 'QuickReplies';