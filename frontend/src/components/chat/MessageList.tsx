import { memo } from 'react';
import { MessageBubble } from './MessageBubble';
import { useChatStore } from './chatStore';

interface MessageListProps {
  onSaveDraft?: (recipe: any) => void;
  onDiscardDraft?: (id: string) => void;
  onStartCooking?: (recipe: any) => void;
  onViewRecipe?: (recipe: any) => void;
  onSaveRecipe?: (recipe: any) => void;
}

export const MessageList = memo(({ 
  onSaveDraft = () => {},
  onDiscardDraft = () => {},
  onStartCooking = () => {},
  onViewRecipe = () => {},
  onSaveRecipe = () => {}
}: MessageListProps) => {
  const messages = useChatStore((state) => state.messages);
  const isGenerating = useChatStore((state) => state.isGenerating);
  const addDraft = useChatStore((state) => state.addDraft);
  const removeDraft = useChatStore((state) => state.removeDraft);
  const addSavedRecipe = useChatStore((state) => state.addSavedRecipe);

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3" role="log" aria-live="polite" aria-atomic="false">
      {messages.map((message) => (
        <div key={message.id} className="px-4">
          <MessageBubble
            message={message}
            onSaveDraft={onSaveDraft || addDraft}
            onDiscardDraft={onDiscardDraft || removeDraft}
            onStartCooking={onStartCooking}
            onViewRecipe={onViewRecipe}
            onSaveRecipe={onSaveRecipe || addSavedRecipe}
          />
        </div>
      ))}
      {isGenerating && (
        <div className="px-4" aria-live="polite">
          <MessageBubble
            message={{ id: 'typing', role: 'assistant', type: 'typing', timestamp: new Date() } as any}
          />
        </div>
      )}
    </div>
  );
});

MessageList.displayName = 'MessageList';