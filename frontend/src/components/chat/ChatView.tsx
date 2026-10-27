import { useEffect, useRef, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DayIndicator } from './DayIndicator';
import { MessageList } from './MessageList';
import { QuickReplies } from './QuickReplies';
import { InputBar } from './InputBar';
import { RecipeDetailModal } from '../recipe/RecipeDetailModal';
import { useChatStore } from './chatStore';
import { useAuthStore } from '../../auth/authStore';
import type { ConnectionState } from '../../auth/authStore';
import { hydratePantryStore } from '../../store/localPantryStore';
import { fetchAiConsentStatus } from '../../ai/aiRecipeApi';

interface ChatViewProps {
  onStartCooking?: (recipe: any) => void;
  onOpenPantry?: () => void;
}

export const ChatView = ({ 
  onStartCooking, 
  onOpenPantry 
}: ChatViewProps) => {
  const navigate = useNavigate();
  const verified = useAuthStore((state) => state.user !== null && state.user.emailVerifiedAt.trim().length > 0 && state.csrfToken !== null);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);
  const connection = useAuthStore((state) => state.connection);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isGenerating = useChatStore((state) => state.isGenerating);
  const consentStatus = useChatStore((state) => state.consentStatus);
  const selectedProvider = useChatStore((state) => state.selectedProvider);

  const [modalRecipe, setModalRecipe] = useState<any>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const messageCount = useChatStore((state) => state.messages.length);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageCount]);

  // Initialize pantry and consent on mount
  const initConsent = useCallback(async () => {
    await hydratePantryStore();
    
    if (verified && user && csrfToken) {
      try {
        const status = await fetchAiConsentStatus();
        useChatStore.getState().setConsentStatus(
          status.consent.enabled && status.consent.homeProvider === status.selectedProvider 
            ? 'granted' 
            : status.consent.enabled 
              ? 'required' 
              : 'unknown'
        );
        useChatStore.getState().setSelectedProvider(status.selectedProvider);
      } catch {
        useChatStore.getState().setConsentStatus('unknown');
      }
    }
  }, [verified, user, csrfToken]);

  useEffect(() => {
    initConsent();
  }, [initConsent]);

  const handleSendMessage = (text: string) => {
    // Add user message
    useChatStore.getState().addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      type: 'text',
      timestamp: new Date(),
      content: text,
    });

    // Quick reply handlers for specific commands
    const lower = text.toLowerCase();
    
    if (lower.includes('veloce') || lower.includes('poco tempo') || lower.includes('15') || lower.includes('20')) {
      useChatStore.getState().handleQuickReply('fast');
      return;
    }
    if (lower.includes('vegetarian') || lower.includes('veg') || lower.includes('senza carne')) {
      useChatStore.getState().handleQuickReply('veg');
      return;
    }
    if (lower.includes('pollo') || lower.includes('carne')) {
      useChatStore.getState().handleQuickReply('custom', text);
      return;
    }
    if (lower.includes('pesce') || lower.includes('salmone')) {
      useChatStore.getState().handleQuickReply('custom', text);
      return;
    }
    if (lower.includes('dispensa') || lower.includes('cosa ho')) {
      useChatStore.getState().handleQuickReply('pantry');
      return;
    }
    if (lower.includes('altre') || lower.includes('altro') || lower.includes('altre idee')) {
      useChatStore.getState().handleQuickReply('more');
      return;
    }
    if (lower.includes('diario') || lower.includes('cotture') || lower.includes('storico')) {
      useChatStore.getState().handleQuickReply('diary');
      return;
    }

    // Default: simulate AI response
    setTimeout(() => {
      const response = {
        id: `ai-response-${Date.now()}`,
        role: 'assistant' as const,
        type: 'text' as const,
        timestamp: new Date(),
        content: `Ho capito: "${text}". Cerco qualcosa di adatto... 🤔\n\nProva a dirmi: "veloce", "vegetariano", "pollo", "pesce", "forno" o "svuotafrigo".`,
      };
      useChatStore.getState().addMessage(response);
    }, 800);
  };

  const handleQuickReply = (action: string) => {
    if (action === 'diary') {
      navigate('/dinner-diary');
      return;
    }
    if (action === 'shopping') {
      navigate('/shopping-list');
      return;
    }
    if (action === 'house') {
      navigate('/house');
      return;
    }
    useChatStore.getState().handleQuickReply(action as any);
  };

  const handleDayChange = (day: 'today' | 'yesterday' | 'dayBefore') => {
    useChatStore.getState().selectDay(day);
  };

  const handleStartCooking = (recipe: any) => {
    if (onStartCooking) onStartCooking(recipe);
  };

  const handleViewRecipe = (recipe: any) => {
    setModalRecipe(recipe);
    setIsModalOpen(true);
  };

  const handleSaveRecipe = (recipe: any) => {
    useChatStore.getState().addSavedRecipe(recipe);
  };

  const handleOpenPantry = () => {
    if (onOpenPantry) onOpenPantry();
    else navigate('/pantry');
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setModalRecipe(null);
  };

  const handleModalStartCooking = (recipe: any) => {
    setIsModalOpen(false);
    setModalRecipe(null);
    if (onStartCooking) onStartCooking(recipe);
  };

  // Show consent notice if not granted
  const showConsentNotice = verified && consentStatus !== 'granted';

  // Sync status color
  const getSyncStatusLabel = () => {
    switch (connection) {
      case 'online': return 'Online';
      case 'offline': return 'Offline';
      default: return 'Connessione...';
    }
  };

  const syncStatusStyle = (connection: ConnectionState) => {
    switch (connection) {
      case 'online': return 'var(--sc-sage)';
      case 'offline': return 'var(--sc-terracotta)';
      default: return 'var(--sc-ink-faint)';
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--sc-cream)]">
      {/* Day Indicator + Sync Status */}
      <div className="flex items-center justify-between px-4 py-2">
        <DayIndicator onDayChange={handleDayChange} />
        <div className="flex items-center gap-2 text-xs font-medium" style={{ color: syncStatusStyle(connection) }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: syncStatusStyle(connection) }} />
          <span>{getSyncStatusLabel()}</span>
        </div>
      </div>

      {/* Consent Notice */}
      {showConsentNotice && (
        <div className="mx-4 mt-2 mb-4 p-4 rounded-2xl border border-[var(--sc-peach-soft)] bg-[var(--sc-cream)]" role="alert">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--sc-terracotta)] text-[var(--sc-cream)]">
              🤖
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-bold text-[var(--sc-ink)]">Consenso AI per ricette</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--sc-ink-soft)]">
                Per generare ricette personalizzate, serve il tuo consenso per inviare ingredienti e profilo alimentare a <strong>{selectedProvider === 'openai' ? 'OpenAI' : selectedProvider === 'gemini' ? 'Gemini di Google' : 'il provider AI'}</strong>.
              </p>
              <button
                onClick={() => {
                  useChatStore.getState().setConsentStatus('granted');
                  useChatStore.getState().setSelectedProvider('openai');
                }}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--sc-terracotta)] px-4 py-2 font-bold text-[var(--sc-cream)] hover:bg-[var(--sc-terracotta-strong)]"
              >
                Autorizza e genera
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <main className="flex-1 overflow-hidden" id="main-content">
        <MessageList
          onStartCooking={handleStartCooking}
          onViewRecipe={handleViewRecipe}
          onSaveRecipe={handleSaveRecipe}
        />
        <div ref={messagesEndRef} />
      </main>

      {/* Quick Replies */}
      <QuickReplies onQuickReply={handleQuickReply} />

      {/* Input Bar */}
      <InputBar
        onSendMessage={handleSendMessage}
        onVoiceInput={() => console.log('Voice input not implemented yet')}
        onScanner={handleOpenPantry}
        disabled={isGenerating}
      />

      {/* Recipe Detail Modal */}
      <RecipeDetailModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        recipe={modalRecipe}
        onStartCooking={handleModalStartCooking}
      />
    </div>
  );
};

ChatView.displayName = 'ChatView';