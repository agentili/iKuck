import { describe, expect, it } from 'vitest';
import { houseMemberships, houses, processedSyncMutations, syncItems } from './schema.js';

describe('house drizzle schema', () => {
  it('exports house tables and scope columns', () => {
    expect(houses).toBeDefined();
    expect(houseMemberships).toBeDefined();
    expect(syncItems.scopeType).toBeDefined();
    expect(syncItems.scopeId).toBeDefined();
    expect(processedSyncMutations.scopeType).toBeDefined();
    expect(processedSyncMutations.scopeId).toBeDefined();
  });
});
