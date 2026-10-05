import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { houseMemberships, houses, processedSyncMutations, s2sServiceCredentials, s2sServiceGrants, syncItems } from './schema.js';

describe('house drizzle schema', () => {
  it('keeps historical grants for a membership compatible with the additive migration', () => {
    const membership = getTableConfig(s2sServiceGrants).columns.find((column) => column.name === 'sponsor_membership_id');
    expect(membership?.isUnique).toBe(false);
  });

  it('mirrors S2S migration constraints and indexes in the Drizzle schema', () => {
    const grants = getTableConfig(s2sServiceGrants);
    const credentials = getTableConfig(s2sServiceCredentials);
    expect(grants.checks.map((item) => item.name).sort()).toEqual([
      's2s_service_grants_expires_at_check',
      's2s_service_grants_scope_check',
      's2s_service_grants_service_id_check',
    ]);
    expect(grants.indexes.map((item) => item.config.name).sort()).toEqual([
      's2s_service_grants_house_idx',
      's2s_service_grants_sponsor_idx',
    ]);
    expect(credentials.checks.map((item) => item.name).sort()).toEqual([
      's2s_service_credentials_expires_at_check',
      's2s_service_credentials_key_id_check',
      's2s_service_credentials_secret_digest_check',
    ]);
    expect(credentials.indexes.map((item) => item.config.name)).toEqual(['s2s_service_credentials_grant_idx']);
  });

  it('exports house tables and scope columns', () => {
    expect(houses).toBeDefined();
    expect(houseMemberships).toBeDefined();
    expect(syncItems.scopeType).toBeDefined();
    expect(syncItems.scopeId).toBeDefined();
    expect(processedSyncMutations.scopeType).toBeDefined();
    expect(processedSyncMutations.scopeId).toBeDefined();
  });
});
