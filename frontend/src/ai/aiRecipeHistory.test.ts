import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiRecipeProposalHistoryKey,
  aiRecipeProposalRevocationKey,
  captureAiRecipeProposalGeneration,
  clearAiRecipeProposalHistory,
  storeAiRecipeProposalHistory,
} from './aiRecipeHistory';

const userId = 'user-race';
const proposal = {
  title: 'Ceci croccanti',
  ingredients: [{ name: 'Ceci', amount: '240 g' }],
};

describe('AI recipe proposal history revocation', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      } as unknown as LockManager,
    });
  });

  it('does not leave a stale history write behind when revocation lands during storage persistence', async () => {
    const generation = captureAiRecipeProposalGeneration(userId);
    const historyKey = aiRecipeProposalHistoryKey(userId);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let revokeBeforeHistoryWrite = true;

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key: string, value: string) {
      if (this === localStorage && key === historyKey && revokeBeforeHistoryWrite) {
        revokeBeforeHistoryWrite = false;
        clearAiRecipeProposalHistory(userId);
      }
      originalSetItem(key, value);
    });

    expect(await storeAiRecipeProposalHistory(generation, [proposal])).toBe(false);
    expect(localStorage.getItem(historyKey)).toBeNull();
  });

  it('removes proposal history before persisting the revocation epoch', async () => {
    const generation = captureAiRecipeProposalGeneration(userId);
    const historyKey = aiRecipeProposalHistoryKey(userId);
    const epochKey = aiRecipeProposalRevocationKey(userId);
    await storeAiRecipeProposalHistory(generation, [proposal]);
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let rejectedPrematureEpochWrite = false;

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key: string, value: string) {
      if (this === localStorage && key === epochKey && localStorage.getItem(historyKey) !== null) {
        rejectedPrematureEpochWrite = true;
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    });

    const cleared = await clearAiRecipeProposalHistory(userId);

    expect(rejectedPrematureEpochWrite).toBe(false);
    expect(cleared).toBe(true);
    expect(localStorage.getItem(epochKey)).toBe(String((generation.epoch ?? 0) + 1));
    expect(localStorage.getItem(historyKey)).toBeNull();
  });
});
