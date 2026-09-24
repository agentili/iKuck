import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
  '0004_houses_and_scoped_sync.sql',
);

describe('house and scoped sync migration', () => {
  it('creates house membership and scope columns without invitation tables', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "houses"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "house_memberships"');
    expect(migration).toContain('"scope_type"');
    expect(migration).toContain('"scope_id"');
    expect(migration).not.toContain('house_invitations');
  });

  it('registers the migration in Drizzle journal so deployment applies it', () => {
    const journalPath = join(dirname(migrationPath), 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };

    expect(journal.entries.map((entry) => entry.tag)).toContain('0004_houses_and_scoped_sync');
  });
});
