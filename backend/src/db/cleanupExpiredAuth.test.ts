import { describe, expect, it, vi } from 'vitest';
import { cleanupExpiredAuth } from './cleanupExpiredAuth.js';

describe('cleanupExpiredAuth', () => {
  it('reports expired records without deleting them in dry-run mode', async () => {
    const execute = vi.fn().mockResolvedValue([
      { table_name: 'auth_sessions', count: '2' },
      { table_name: 'email_verification_tokens', count: '3' },
      { table_name: 'password_reset_tokens', count: '1' },
    ]);

    const result = await cleanupExpiredAuth(
      { execute },
      { now: new Date('2026-09-14T12:00:00.000Z'), dryRun: true },
    );

    expect(result).toEqual({
      dryRun: true,
      sessions: 2,
      verificationTokens: 3,
      passwordResetTokens: 1,
      total: 6,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('deletes only expired records and returns the affected counts', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ id: 'session-1' }, { id: 'session-2' }])
      .mockResolvedValueOnce([{ id: 'verification-1' }])
      .mockResolvedValueOnce([]);

    const result = await cleanupExpiredAuth(
      { execute },
      { now: new Date('2026-09-14T12:00:00.000Z') },
    );

    expect(result).toEqual({
      dryRun: false,
      sessions: 2,
      verificationTokens: 1,
      passwordResetTokens: 0,
      total: 3,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
