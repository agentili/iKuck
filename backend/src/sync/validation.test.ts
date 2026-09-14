import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSyncMutation } from './validation.js';

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
});
