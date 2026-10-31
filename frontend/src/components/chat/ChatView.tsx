import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuthStore } from '../../auth/authStore';
import { useChefChatStore } from '../../ai/chefChatStore';
import { InputBar } from './InputBar';
import { DailyRecipeCard } from './DailyRecipeCard';
import { getActiveDataScope, subscribeActiveDataScope } from '../../sync/scopeContext';

export const ChatView = () => {
  const scope = useSyncExternalStore(
    (listener) => subscribeActiveDataScope(() => listener()),
    getActiveDataScope,
    getActiveDataScope,
  );
  const connection = useAuthStore((state) => state.connection);
  const user = useAuthStore((state) => state.user);
  const csrfToken = useAuthStore((state) => state.csrfToken);

  const messages = useChefChatStore((state) => state.messages);
  const isSending = useChefChatStore((state) => state.isSending);
  const error = useChefChatStore((state) => state.error);
  const consentStatus = useChefChatStore((state) => state.consentStatus);
  const isConsentLoaded = useChefChatStore((state) => state.isConsentLoaded);
  const hasHydrated = useChefChatStore((state) => state.hasHydrated);
  const sendMessage = useChefChatStore((state) => state.sendMessage);
  const hydrate = useChefChatStore((state) => state.hydrate);
  const loadConsentStatus = useChefChatStore((state) => state.loadConsentStatus);
  const clearError = useChefChatStore((state) => state.clearError);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    void hydrate();
  }, [hydrate, scope]);

  useEffect(() => {
    if (user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null) {
      void loadConsentStatus();
    }
  }, [user, csrfToken, loadConsentStatus]);

  const isVerified = user !== null && user.emailVerifiedAt.trim().length > 0 && csrfToken !== null;
  const chatEnabled = isVerified && consentStatus?.consent.enabled === true && consentStatus?.consent.chatProvider !== undefined && consentStatus?.consent.chatPolicyVersion === 'chef-chat-v1';
  const canSend = hasHydrated && chatEnabled && !isSending;

  if (!hasHydrated) {
    return (
      <main id="main-content" className="mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-2xl flex-col bg-[var(--sc-cream)] pb-6" role="main">
        <div className="px-4 pt-3 text-sm text-[var(--sc-ink-soft)]" role="status">
          {connection === 'offline' ? 'Offline: puoi consultare i dati disponibili su questo dispositivo.' : connection === 'online' ? 'Online' : 'Connessione in corso…'}
        </div>
        <DailyRecipeCard />
        <section className="mt-auto flex-1 px-4 pt-4 flex flex-col" aria-label="Chef">
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[var(--sc-ink-soft)] text-center">Caricamento chat…</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-2xl flex-col bg-[var(--sc-cream)] pb-6" role="main">
      <div className="px-4 pt-3 text-sm text-[var(--sc-ink-soft)]" role="status">
        {connection === 'offline' ? 'Offline: puoi consultare i dati disponibili su questo dispositivo.' : connection === 'online' ? 'Online' : 'Connessione in corso…'}
      </div>

      <DailyRecipeCard />

      <section
        ref={scrollAreaRef}
        className="mt-auto flex-1 min-h-0 px-4 pt-4 flex flex-col overflow-hidden"
        aria-label="Chef"
      >
        <header className="flex-shrink-0">
          <h1 className="text-xl font-bold text-[var(--sc-ink)]">Chef</h1>
          {!isVerified && (
            <p className="mt-1 text-sm text-[var(--sc-ink-soft)]">
              Accedi con un account verificato per usare la chat con Chef.
            </p>
          )}
          {isVerified && !isConsentLoaded && (
            <p className="mt-1 text-sm text-[var(--sc-ink-soft)]">Verifica consenso AI…</p>
          )}
          {isVerified && isConsentLoaded && !chatEnabled && (
            <div className="mt-2 rounded-xl border border-[var(--sc-apricot-soft)] bg-[var(--sc-peach-soft)] p-3">
              <p className="text-sm font-medium text-[var(--sc-terracotta)]">
                La chat Chef richiede il consenso per l'invio dei dati al provider AI.
              </p>
              <p className="mt-1 text-xs text-[var(--sc-ink-soft)]">
                Vai a <a href="/cucina" className="underline font-medium">Cucina e ricette AI</a> per autorizzare la chat (provider: {consentStatus?.selectedProvider ?? 'non selezionato'}).
              </p>
            </div>
          )}
          {isVerified && isConsentLoaded && consentStatus?.consent.enabled && consentStatus?.consent.chatPolicyVersion !== 'chef-chat-v1' && (
            <div className="mt-2 rounded-xl border border-[var(--sc-apricot-soft)] bg-[var(--sc-peach-soft)] p-3">
              <p className="text-sm font-medium text-[var(--sc-terracotta)]">
                Il consenso per la chat AI non è aggiornato alla versione corrente.
              </p>
              <p className="mt-1 text-xs text-[var(--sc-ink-soft)]">
                Vai a <a href="/cucina" className="underline font-medium">Cucina e ricette AI</a> per riabilitare la chat.
              </p>
            </div>
          )}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto" role="log" aria-live="polite" aria-atomic="false">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 min-h-0 px-4 py-8 text-center">
              <p className="text-[var(--sc-ink-soft)] text-base mb-2">
                Ciao! Sono Chef, il tuo assistente di cucina.
              </p>
              <p className="text-[var(--sc-ink-faint)] text-sm max-w-xs">
                Chiedimi una ricetta, un consiglio sugli ingredienti o come organizzare la spesa.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((message) => (
                <div key={message.id} className="px-4">
                  <MessageBubble message={message} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div ref={messagesEndRef} />

        {error && (
          <div className="flex-shrink-0 px-4 pb-2" role="alert">
            <div className="rounded-xl bg-[var(--sc-coral-soft)] border border-[var(--sc-coral-soft)] p-3 text-sm font-medium text-[var(--sc-terracotta)] flex items-center justify-between gap-2">
              <span>{error}</span>
              <button type="button" onClick={clearError} className="text-[var(--sc-terracotta)] underline hover:no-underline">Chiudi</button>
            </div>
          </div>
        )}

        {hasHydrated && (
          <InputBar
            onSendMessage={sendMessage}
            disabled={!canSend}
          />
        )}
      </section>
    </main>
  );
};

ChatView.displayName = 'ChatView';

function MessageBubble({ message }: { message: { id: string; role: 'user' | 'assistant'; content: string; timestamp: Date; isOptimistic?: boolean } }) {
  const isUser = message.role === 'user';
  const formatTime = (date: Date) => date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  if (isUser) {
    return (
      <div
        className="chat-bubble-user max-w-[85%] ml-auto animate-slide-up"
        style={{
          backgroundColor: 'var(--sc-terracotta)',
          color: 'var(--sc-cream)',
          borderRadius: 'var(--sc-radius-bubble)',
          borderBottomRightRadius: '6px',
          padding: '14px 18px',
          opacity: message.isOptimistic ? 0.7 : 1,
        }}
      >
        <p className="whitespace-pre-wrap leading-relaxed" style={{ fontFamily: 'DM Sans, system-ui, sans-serif', fontSize: '0.9375rem', lineHeight: 1.5 }}>
          {message.content}
        </p>
        <p className="mt-2 text-[var(--sc-cream)]/70 text-xs text-right" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
          {formatTime(message.timestamp)}
        </p>
      </div>
    );
  }

  return (
    <div
      className="chat-bubble-assistant max-w-[85%] animate-slide-up"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        backgroundColor: 'var(--sc-cream)',
        color: 'var(--sc-ink)',
        borderRadius: 'var(--sc-radius-bubble)',
        borderBottomLeftRadius: '6px',
        padding: '14px 18px',
        border: '1px solid var(--sc-peach-soft)',
        boxShadow: 'var(--sc-shadow-soft)',
      }}
    >
      <p className="whitespace-pre-wrap text-[var(--sc-ink)] leading-relaxed" style={{ fontFamily: 'DM Sans, system-ui, sans-serif', fontSize: '0.9375rem', lineHeight: 1.5 }}>
        {message.content}
      </p>
      <p className="mt-2 text-[var(--sc-ink-faint)] text-xs text-right" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
        {formatTime(message.timestamp)}
      </p>
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as any).__useChefChatStore = useChefChatStore;
}