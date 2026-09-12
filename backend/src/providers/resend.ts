import type { EmailMessage, EmailProvider } from './types.js';

export class ProviderRequestError extends Error {
  readonly code = 'provider_request_failed' as const;

  constructor(readonly provider: 'resend', readonly status: number) {
    super(`${provider} provider request failed`);
    this.name = 'ProviderRequestError';
  }
}

interface ResendProviderOptions {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
}

export const createResendEmailProvider = ({ apiKey, from, fetch: request = globalThis.fetch }: ResendProviderOptions): EmailProvider => ({
  send: async (message: EmailMessage) => {
    const response = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
      }),
    });

    if (!response.ok) throw new ProviderRequestError('resend', response.status);

    const payload = await response.json() as { id?: unknown };
    if (typeof payload.id !== 'string' || payload.id.length === 0) {
      throw new ProviderRequestError('resend', response.status);
    }

    return { messageId: payload.id };
  },
});
