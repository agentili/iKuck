import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertStoredSyncMutation, parseSyncMutation } from './validation.js';

const fixturePath = (name: string): string => join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'shared',
  'sync-fixtures',
  name,
);

const readFixture = (name: string): unknown[] => JSON.parse(readFileSync(fixturePath(name), 'utf8')) as unknown[];

describe('sync mutation validation', () => {
  it('accepts every valid persisted mutation fixture', () => {
    expect(readFixture('valid.json').every((mutation) => parseSyncMutation(mutation) !== null)).toBe(true);
  });

  it('rejects every invalid mutation fixture', () => {
    expect(readFixture('invalid.json').every((mutation) => parseSyncMutation(mutation) === null)).toBe(true);
  });

  it('returns a normalized mutation without relying on unsafe payload casts', () => {
    const mutation = parseSyncMutation(readFixture('valid.json')[1]);

    expect(mutation).toMatchObject({
      entityType: 'pantry_lot',
      operation: 'upsert',
      payload: { id: 'lot-pasta', ingredientId: 'pasta' },
    });
  });

  it('rejects wrong-ID ai_consent upserts and deletes at transport and stored boundaries', () => {
    const malformedMutations = [
      {
        mutationId: 'wrong-consent-upsert',
        deviceId: 'device-1',
        entityType: 'ai_consent',
        entityId: 'wrong-profile',
        operation: 'upsert',
        payload: { enabled: false, updatedAt: '2026-09-24T12:00:00.000Z' },
        clientUpdatedAt: '2026-09-24T12:00:00.000Z',
      },
      {
        mutationId: 'wrong-consent-delete',
        deviceId: 'device-1',
        entityType: 'ai_consent',
        entityId: 'wrong-profile',
        operation: 'delete',
        payload: null,
        clientUpdatedAt: '2026-09-24T12:00:00.000Z',
      },
    ];

    for (const mutation of malformedMutations) {
      expect(parseSyncMutation(mutation)).toBeNull();
      expect(() => assertStoredSyncMutation(mutation)).toThrow();
    }
  });

  it('accepts Home provider markers only in trusted stored consent, never generic sync payloads', () => {
    const storedConsent = {
      mutationId: 'stored-home-consent',
      deviceId: 'api-ai-recipes',
      entityType: 'ai_consent',
      entityId: 'profile',
      operation: 'upsert',
      payload: { enabled: true, homeProvider: 'gemini', updatedAt: '2026-09-24T12:00:00.000Z' },
      clientUpdatedAt: '2026-09-24T12:00:00.000Z',
    };

    expect(assertStoredSyncMutation(storedConsent)).toMatchObject({ payload: { homeProvider: 'gemini' } });
    expect(parseSyncMutation(storedConsent)).toBeNull();
  });
});
