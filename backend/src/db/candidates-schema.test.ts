import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { bringConnections, pantryCandidates } from './schema.js';

const migrationsPath = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

describe('pantry candidates Drizzle schema', () => {
  it('stores a per-connection recently watermark and snapshot', () => {
    const columns = getTableConfig(bringConnections).columns.map((column) => column.name);
    expect(columns).toContain('recently_watermark_at');
    expect(columns).toContain('recently_snapshot');
  });

  it('uniquely scopes a normalized candidate label to its house', () => {
    const config = getTableConfig(pantryCandidates);
    expect(config.columns.map((column) => column.name).sort()).toEqual([
      'checked_off_at', 'detected_at', 'expires_at', 'house_id', 'id', 'label', 'list_name',
      'normalized_label', 'raw_label', 'resolved_at', 'specification', 'status',
    ]);
    expect(config.indexes.map((index) => index.config.name)).toContain('pantry_candidates_house_normalized_label_unique');
  });

  it('registers an additive migration for candidate tables and watermarks', () => {
    const migration = readFileSync(join(migrationsPath, '0010_pantry_candidates.sql'), 'utf8');
    const journal = JSON.parse(readFileSync(join(migrationsPath, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(migration).toContain('recently_snapshot');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pantry_candidates"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "pantry_candidates_house_normalized_label_unique"');
    expect(migration).not.toContain('CREATE TABLE "users"');
    expect(journal.entries.map((entry) => entry.tag)).toContain('0010_pantry_candidates');
  });
});
