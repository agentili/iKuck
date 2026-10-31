import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAuthStore } from '../auth/authStore';
import { subscribeToScopeChange } from './chefChatStorage';
import {
  loadChefChatMessages,
  appendChefChatMessage,
  toChefChatTurn,
} from './chefChatStorage';
import { sendChefChatMessage, fetchChefChatConsentStatus, errorMessage, type ChefChatConsentStatus } from './chefChatApi';
import type { ChefChatRequest } from '@ikuck/shared/contracts';

export interface ChefChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isOptimistic?: boolean;
}

export interface ChefChatState {
  messages: ChefChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  error: string | null;
  consentStatus: ChefChatConsentStatus | null;
  isConsentLoaded: boolean;
  hasHydrated: boolean;
  currentScope: string;

  sendMessage: (content: string) => Promise<void>;
  loadMessages: () => Promise<void>;
  loadConsentStatus: () => Promise<void>;
  setError: (error: string | null) => void;
  clearError: () => void;
  hydrate: () => Promise<void>;
}

let hydrationPromise: Promise<void> | null = null;
let hydrationGeneration = 0;
let hydratedScope: ReturnType<typeof getActiveDataScope> | null = null;

import { getActiveDataScope } from '../sync/scopeContext';

function isVerifiedUser(): { user: { id: string; csrfToken: string }; verified: boolean } {
  const state = useAuthStore.getState();
  const verified = state.user !== null && state.user.emailVerifiedAt.trim().length > 0 && state.csrfToken !== null;
  return {
    user: verified ? { id: state.user!.id, csrfToken: state.csrfToken! } : null as any,
    verified,
  };
}

const useChefChatStore = create<ChefChatState>()(
  devtools(
    (set, get) => {
      return {
        messages: [],
        isLoading: false,
        isSending: false,
        error: null,
        consentStatus: null,
        isConsentLoaded: false,
        hasHydrated: false,
        currentScope: getActiveDataScope(),

        sendMessage: async (content: string) => {
          const { user, verified } = isVerifiedUser();
          if (!verified || !user) {
            set({ error: 'Autenticazione richiesta per usare la chat Chef.' });
            return;
          }

          const consentStatus = get().consentStatus;
          if (!consentStatus?.consent.enabled || !consentStatus?.consent.chatProvider || consentStatus?.consent.chatPolicyVersion !== 'chef-chat-v1') {
            set({ error: 'Il consenso per la chat AI è richiesto. Autorizzalo nella sezione Ricette AI.' });
            return;
          }

          const scope = getActiveDataScope();
          const userMessage: ChefChatMessage = {
            id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: 'user',
            content,
            timestamp: new Date(),
            isOptimistic: true,
          };

          const messages = [...get().messages, userMessage];
          set({ messages, isSending: true, error: null });

          await appendChefChatMessage(scope, {
            id: userMessage.id,
            role: 'user',
            content,
            timestamp: userMessage.timestamp.toISOString(),
          });

          try {
            const history = get().messages
              .filter((m) => m.role !== 'user' || m.content !== content)
              .map((m) => toChefChatTurn({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp.toISOString() }));
            history.push({ role: 'user', content });

            const request: ChefChatRequest = { message: content, history };
            const response = await sendChefChatMessage(request, user.csrfToken);

            const assistantMessage: ChefChatMessage = {
              id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: 'assistant',
              content: response.reply,
              timestamp: new Date(),
            };

            const updatedMessages = [...get().messages].map((m) =>
              m.id === userMessage.id ? { ...m, isOptimistic: false } : m
            );
            updatedMessages.push(assistantMessage);

            set({ messages: updatedMessages, isSending: false });

            await appendChefChatMessage(scope, {
              id: assistantMessage.id,
              role: 'assistant',
              content: response.reply,
              timestamp: assistantMessage.timestamp.toISOString(),
            });
          } catch (error) {
            const errMsg = errorMessage(error);
            set({ error: errMsg, isSending: false });

            const errorMessageObj: ChefChatMessage = {
              id: `error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: 'assistant',
              content: errMsg,
              timestamp: new Date(),
            };

            const updatedMessages = [...get().messages].map((m) =>
              m.id === userMessage.id ? { ...m, isOptimistic: false } : m
            );
            updatedMessages.push(errorMessageObj);
            set({ messages: updatedMessages });

            await appendChefChatMessage(scope, {
              id: errorMessageObj.id,
              role: 'assistant',
              content: errMsg,
              timestamp: errorMessageObj.timestamp.toISOString(),
            });
          }
        },

        loadMessages: async () => {
          const scope = getActiveDataScope();
          const stored = await loadChefChatMessages(scope);
          const messages: ChefChatMessage[] = stored.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.timestamp),
          }));
          set({ messages, currentScope: scope });
        },

        loadConsentStatus: async () => {
          const { verified } = isVerifiedUser();
          if (!verified) {
            set({ consentStatus: null, isConsentLoaded: true });
            return;
          }

          try {
            const consentStatus = await fetchChefChatConsentStatus();
            set({ consentStatus, isConsentLoaded: true });
          } catch {
            set({ consentStatus: null, isConsentLoaded: true });
          }
        },

        setError: (error: string | null) => set({ error }),

        clearError: () => set({ error: null }),

        hydrate: async () => {
          for (;;) {
            const activeScope = getActiveDataScope();
            const activeGeneration = hydrationGeneration;
            if (get().hasHydrated && hydratedScope === activeScope) return;

            if (hydrationPromise === null) {
              const hydrationScope = activeScope;
              const hydrationGenerationAtStart = activeGeneration;

              const currentPromise = (async () => {
                try {
                  await Promise.all([
                    get().loadMessages(),
                    get().loadConsentStatus(),
                  ]);
                  if (getActiveDataScope() !== hydrationScope || hydrationGeneration !== hydrationGenerationAtStart) return;
                  set({ hasHydrated: true });
                  hydratedScope = hydrationScope;
                } catch (error) {
                  console.error('Chef chat hydration failed:', error);
                  if (getActiveDataScope() === hydrationScope && hydrationGeneration === hydrationGenerationAtStart) {
                    set({ hasHydrated: true, error: 'Impossibile caricare la chat. Riprova.' });
                    hydratedScope = hydrationScope;
                  }
                }
              })();

              hydrationPromise = currentPromise;
            }

            const pendingHydration = hydrationPromise;
            if (pendingHydration !== null) await pendingHydration;

            if (
              getActiveDataScope() === activeScope &&
              hydrationGeneration === activeGeneration &&
              get().hasHydrated &&
              hydratedScope === activeScope
            ) return;
          }
        },
      };
    },
    { name: 'chef-chat-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeToScopeChange((scope) => {
    hydrationGeneration += 1;
    hydratedScope = null;
    useChefChatStore.setState({
      hasHydrated: false,
      messages: [],
      consentStatus: null,
      isConsentLoaded: false,
      error: null,
      currentScope: scope,
    });
    void useChefChatStore.getState().hydrate();
  });
}

export { useChefChatStore };

if (typeof window !== 'undefined') {
  (window as any).__useChefChatStore = useChefChatStore;
}