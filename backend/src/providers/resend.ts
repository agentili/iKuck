import { FetchTimeoutError, fetchWithTimeout } from './fetchWithTimeout.js';
import { ProviderTimeoutError, type EmailMessage, type EmailProvider } from './types.js';

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
  timeoutMs?: number;
}

export const createResendEmailProvider = ({
  apiKey,
  from,
  fetch: request = globalThis.fetch,
  timeoutMs = 10000,
}: ResendProviderOptions): EmailProvider => ({
  send: async (message: EmailMessage) => {
    let response: Response;
    try {
      response = await fetchWithTimeout(request, 'https://api.resend.com/emails', {
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
      }, timeoutMs);
    } catch (error) {
      if (error instanceof FetchTimeoutError) throw new ProviderTimeoutError('resend');
      throw new ProviderRequestError('resend', 0);
    }

    if (!response.ok) throw new ProviderRequestError('resend', response.status);

    let payload: { id?: unknown };
    try {
      payload = await response.json() as { id?: unknown };
    } catch {
      throw new ProviderRequestError('resend', response.status);
    }
    if (typeof payload.id !== 'string' || payload.id.length === 0) {
      throw new ProviderRequestError('resend', response.status);
    }

    return { messageId: payload.id };
  },
});
