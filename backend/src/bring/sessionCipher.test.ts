import { describe, expect, it } from 'vitest';
import { createSessionCipher } from './sessionCipher.js';

const key = '11'.repeat(32);
const plaintext = JSON.stringify({ userId: 'synthetic-user', accessToken: 'synthetic-token' });

describe('Bring session cipher', () => {
  it('roundtrips with a fresh nonce and hides plaintext', () => {
    const cipher = createSessionCipher(key);
    const first = cipher.seal('owner-a', plaintext);
    expect(cipher.open('owner-a', first)).toBe(plaintext);
    expect(first).not.toContain('synthetic-token');
    expect(cipher.seal('owner-a', plaintext)).not.toBe(first);
  });

  it('rejects another owner, another key and modified ciphertext', () => {
    const cipher = createSessionCipher(key);
    const envelope = cipher.seal('owner-a', plaintext);
    expect(() => cipher.open('owner-b', envelope)).toThrow('Bring session cannot be decrypted');
    expect(() => createSessionCipher('22'.repeat(32)).open('owner-a', envelope)).toThrow('Bring session cannot be decrypted');
    const parts = envelope.split('.');
    parts[2] = Buffer.alloc(16, 0).toString('base64url');
    expect(() => cipher.open('owner-a', parts.join('.'))).toThrow('Bring session cannot be decrypted');
  });

  it.each(['', 'not-a-key', '11'.repeat(31)])('rejects invalid encryption configuration', (value) => {
    expect(() => createSessionCipher(value)).toThrow('Bring encryption key is invalid');
  });
});
