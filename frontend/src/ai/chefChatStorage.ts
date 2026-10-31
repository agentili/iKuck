import { readKeyValue, writeKeyValue, updateKeyValue } from '../storage/indexedDb';
import { getActiveDataScope, subscribeActiveDataScope } from '../sync/scopeContext';
import type { ChefChatTurn } from '@ikuck/shared/contracts';

const CHAT_MESSAGES_KEY_PREFIX = 'chef-chat-messages:';

export interface StoredChefChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

function scopeMessagesKey(scope: string): string {
  return `${CHAT_MESSAGES_KEY_PREFIX}${scope}`;
}

export async function loadChefChatMessages(scope: string): Promise<StoredChefChatMessage[]> {
  const key = scopeMessagesKey(scope);
  const stored = await readKeyValue<StoredChefChatMessage[]>(key);
  return stored ?? [];
}

export async function saveChefChatMessages(scope: string, messages: StoredChefChatMessage[]): Promise<void> {
  const key = scopeMessagesKey(scope);
  await writeKeyValue(key, messages);
}

export async function appendChefChatMessage(scope: string, message: StoredChefChatMessage): Promise<void> {
  const key = scopeMessagesKey(scope);
  await updateKeyValue<StoredChefChatMessage[]>(key, (current) => {
    const existing = current ?? [];
    return [...existing, message].slice(-100);
  });
}

export async function clearChefChatMessages(scope: string): Promise<void> {
  const key = scopeMessagesKey(scope);
  await writeKeyValue(key, []);
}

export function toChefChatTurn(message: StoredChefChatMessage): ChefChatTurn {
  return {
    role: message.role,
    content: message.content,
  };
}

export function subscribeToScopeChange(listener: (scope: string) => void): () => void {
  return subscribeActiveDataScope(() => listener(getActiveDataScope()));
}