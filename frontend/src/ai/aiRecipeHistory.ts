import type { GeneratedRecipe } from '@ikuck/shared/contracts';
import { RECIPE_MAX_INGREDIENTS } from '@ikuck/shared/limits';

export type ProposedAiRecipe = Pick<GeneratedRecipe, 'title' | 'ingredients'>;

export interface AiRecipeProposalGeneration {
  userId: string;
  epoch: number | null;
}

export const AI_RECIPE_PROPOSAL_HISTORY_LIMIT = 50;
export const aiRecipeProposalHistoryKey = (userId: string): string => `ikuck.ai-recipe-proposals:${userId}`;
export const aiRecipeProposalRevocationKey = (userId: string): string => `ikuck.ai-recipe-proposal-revocation:${userId}`;

const REVOCATION_EVENT = 'ikuck:ai-recipe-proposal-revoked';
const REVOCATION_CHANNEL = 'ikuck:ai-recipe-proposal-revocation';
const currentEpochByUser = new Map<string, number>();

const parseEpoch = (value: string | null): number | null => {
  if (value === null) return 0;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
};

const currentEpoch = (userId: string): number | null => {
  const memoryEpoch = currentEpochByUser.get(userId) ?? 0;
  try {
    const storedEpoch = parseEpoch(window.localStorage.getItem(aiRecipeProposalRevocationKey(userId)));
    return storedEpoch === null ? null : Math.max(memoryEpoch, storedEpoch);
  } catch {
    return null;
  }
};

const removeProposalHistory = (userId: string): boolean => {
  try {
    window.localStorage.removeItem(aiRecipeProposalHistoryKey(userId));
    return true;
  } catch {
    return false;
  }
};

const withProposalHistoryLock = async <T>(userId: string, action: () => T): Promise<{ available: boolean; value?: T }> => {
  if (typeof navigator === 'undefined' || !('locks' in navigator) || navigator.locks === undefined) {
    return { available: false };
  }
  try {
    const value = await navigator.locks.request(`ikuck:ai-recipe-proposals:${userId}`, { mode: 'exclusive' }, action);
    return { available: true, value };
  } catch {
    return { available: true };
  }
};

const removeProposalHistorySafely = async (userId: string): Promise<boolean> => {
  const result = await withProposalHistoryLock(userId, () => removeProposalHistory(userId));
  // Without Web Locks this app never writes proposal history, so direct removal is safe.
  return result.available ? result.value === true : removeProposalHistory(userId);
};

const isProposedRecipe = (value: unknown): value is ProposedAiRecipe => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { title?: unknown; ingredients?: unknown };
  return typeof candidate.title === 'string'
    && candidate.title.trim().length > 0
    && candidate.title.length <= 120
    && Array.isArray(candidate.ingredients)
    && candidate.ingredients.length > 0
    && candidate.ingredients.length <= RECIPE_MAX_INGREDIENTS
    && candidate.ingredients.every((ingredient: unknown) => (
      typeof ingredient === 'object'
      && ingredient !== null
      && 'name' in ingredient
      && typeof ingredient.name === 'string'
      && ingredient.name.trim().length > 0
      && ingredient.name.length <= 120
      && 'amount' in ingredient
      && typeof ingredient.amount === 'string'
      && ingredient.amount.trim().length > 0
      && ingredient.amount.length <= 80
    ));
};

export const captureAiRecipeProposalGeneration = (userId: string): AiRecipeProposalGeneration => ({
  userId,
  epoch: currentEpoch(userId),
});

export const isAiRecipeProposalGenerationCurrent = (generation: AiRecipeProposalGeneration): boolean => (
  generation.epoch !== null && currentEpoch(generation.userId) === generation.epoch
);

export const loadAiRecipeProposalHistory = (generation: AiRecipeProposalGeneration): ProposedAiRecipe[] => {
  if (!isAiRecipeProposalGenerationCurrent(generation)) return [];
  try {
    const stored = window.localStorage.getItem(aiRecipeProposalHistoryKey(generation.userId));
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      // Older arrays cannot be tied to a post-revocation generation.
      if (generation.epoch !== 0) return [];
      return parsed.filter(isProposedRecipe).slice(-AI_RECIPE_PROPOSAL_HISTORY_LIMIT);
    }
    if (typeof parsed !== 'object' || parsed === null || !('epoch' in parsed) || !('recipes' in parsed)) return [];
    const history = parsed as { epoch: unknown; recipes: unknown };
    return history.epoch === generation.epoch && Array.isArray(history.recipes)
      ? history.recipes.filter(isProposedRecipe).slice(-AI_RECIPE_PROPOSAL_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
};

export const storeAiRecipeProposalHistory = async (
  generation: AiRecipeProposalGeneration,
  recipes: ProposedAiRecipe[],
): Promise<boolean> => {
  const result = await withProposalHistoryLock(generation.userId, () => {
    if (!isAiRecipeProposalGenerationCurrent(generation)) return false;
    try {
      window.localStorage.setItem(aiRecipeProposalHistoryKey(generation.userId), JSON.stringify({
        epoch: generation.epoch,
        recipes: recipes.slice(-AI_RECIPE_PROPOSAL_HISTORY_LIMIT),
      }));
    } catch {
      // The component can keep this history in memory while storage is unavailable.
    }
    if (!isAiRecipeProposalGenerationCurrent(generation)) {
      // Revocation can advance the epoch while localStorage is being written.
      removeProposalHistory(generation.userId);
      return false;
    }
    return true;
  });
  // Fail closed for persistent history if cross-tab locking is unavailable or fails.
  return result.available && result.value === true;
};

export const clearAiRecipeProposalHistory = async (userId: string): Promise<boolean> => {
  const nextEpoch = Math.min(Number.MAX_SAFE_INTEGER, (currentEpoch(userId) ?? currentEpochByUser.get(userId) ?? 0) + 1);
  currentEpochByUser.set(userId, nextEpoch);
  const clearAndPersistEpoch = (): boolean => {
    // Free quota from the private proposals before writing the revocation marker.
    const historyRemoved = removeProposalHistory(userId);
    let epochPersisted = false;
    try {
      window.localStorage.setItem(aiRecipeProposalRevocationKey(userId), String(nextEpoch));
      epochPersisted = true;
    } catch {
      // The in-memory epoch still invalidates work in this tab if storage is unavailable.
    }
    return historyRemoved && epochPersisted;
  };
  const result = await withProposalHistoryLock(userId, clearAndPersistEpoch);
  const cleared = result.available ? result.value === true : clearAndPersistEpoch();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REVOCATION_EVENT, { detail: { userId, epoch: nextEpoch } }));
  }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(REVOCATION_CHANNEL);
      channel.postMessage({ userId, epoch: nextEpoch });
      channel.close();
    }
  } catch {
    // Same-tab and storage events remain the fallback paths.
  }
  return cleared;
};

export const subscribeToAiRecipeProposalRevocation = (
  userId: string,
  onRevoke: () => void,
): (() => void) => {
  let observedEpoch = currentEpoch(userId) ?? -1;
  const observe = (epoch: number): void => {
    if (epoch <= observedEpoch) return;
    observedEpoch = epoch;
    currentEpochByUser.set(userId, Math.max(currentEpochByUser.get(userId) ?? 0, epoch));
    void removeProposalHistorySafely(userId);
    onRevoke();
  };
  const onSameTabRevocation = (event: Event): void => {
    const detail = (event as CustomEvent<{ userId?: unknown; epoch?: unknown }>).detail;
    if (detail?.userId !== userId || typeof detail.epoch !== 'number' || !Number.isSafeInteger(detail.epoch)) return;
    observe(detail.epoch);
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== aiRecipeProposalRevocationKey(userId)) return;
    const epoch = parseEpoch(event.newValue);
    if (epoch !== null) observe(epoch);
  };
  const onBroadcast = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== 'object' || event.data === null) return;
    const message = event.data as { userId?: unknown; epoch?: unknown };
    if (message.userId !== userId || typeof message.epoch !== 'number' || !Number.isSafeInteger(message.epoch)) return;
    observe(message.epoch);
  };

  if (typeof window === 'undefined') return () => undefined;
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(REVOCATION_CHANNEL);
      channel.addEventListener('message', onBroadcast);
    }
  } catch {
    channel = null;
  }
  window.addEventListener(REVOCATION_EVENT, onSameTabRevocation);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(REVOCATION_EVENT, onSameTabRevocation);
    window.removeEventListener('storage', onStorage);
    channel?.close();
  };
};
