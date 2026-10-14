import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './crypto.js';

describe('authentication crypto', () => {
  it('verifies an Argon2id password hash and rejects a different password', async () => {
    const hash = await hashPassword('Correct horse battery staple!');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'Correct horse battery staple!')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });
});
