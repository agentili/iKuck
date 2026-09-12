import { describe, expect, it, vi } from 'vitest';
import { createResendEmailProvider } from '../providers/resend.js';
import { hashPassword, verifyPassword } from './crypto.js';

describe('authentication crypto and email provider', () => {
  it('verifies an Argon2id password hash and rejects a different password', async () => {
    const hash = await hashPassword('Correct horse battery staple!');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'Correct horse battery staple!')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('sends verification mail through the Resend HTTP boundary', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }),
    );
    const provider = createResendEmailProvider({
      apiKey: 'test-key',
      from: 'no-reply@ikuck.example',
      fetch,
    });

    await expect(provider.send({
      to: 'user@example.com',
      subject: 'Verify',
      html: '<p>Verify</p>',
    })).resolves.toEqual({ messageId: 'email-1' });

    expect(fetch).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }));
  });
});
