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
          aria-label={reply.label}
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
});

QuickReplies.displayName = 'QuickReplies';