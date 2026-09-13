import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PantryLot, SyncMutation } from '@ikuck/shared/contracts';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
  '0001_accounts_and_sync.sql',
);

describe('shared contracts and account migration', () => {
  it('keeps sync mutations entity-scoped and serializable', () => {
    const mutation: SyncMutation = {
      mutationId: 'mutation-1',
      deviceId: 'device-1',
      entityType: 'pantry_item',
      entityId: 'tomato',
      operation: 'upsert',
      payload: { id: 'tomato', label: 'Pomodoro', known: true },
      clientUpdatedAt: '2026-09-12T12:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(mutation))).toEqual(mutation);
  });

  it('keeps a presence-only pantry lot serializable', () => {
    const lot: PantryLot = {
      id: 'lot-pasta',
      ingredientId: 'pasta',
      label: 'Pasta',
      known: true,
      quantity: null,
      unit: null,
      expiresAt: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      updatedAt: '2026-09-13T10:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(lot))).toEqual(lot);
  });

  it('contains the account and sync tables in the first feature migration', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "sync_items"');
  });
});
