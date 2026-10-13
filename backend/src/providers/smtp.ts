import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';
import { ProviderRequestError, ProviderTimeoutError, type EmailMessage, type EmailProvider } from './types.js';

export interface SmtpMailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export interface SmtpTransport {
  sendMail: (message: SmtpMailMessage) => Promise<{ messageId?: string }>;
}

export type SmtpTransportFactory = (options: SMTPTransportOptions) => SmtpTransport;

export interface SmtpProviderOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  timeoutMs?: number;
  createTransport?: SmtpTransportFactory;
}

const DEFAULT_TIMEOUT_MS = 10000;
const TIMEOUT_ERROR_CODES = ['ETIMEOUT', 'ETIMEDOUT'];

const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && TIMEOUT_ERROR_CODES.includes(code);
};

export const createSmtpEmailProvider = ({
  host,
  port,
  secure,
  user,
  pass,
  from,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createTransport: buildTransport = createTransport,
}: SmtpProviderOptions): EmailProvider => {
  const transport = buildTransport({
    host,
    port,
    secure,
    // TLS is mandatory: implicit TLS on port 465, STARTTLS on any other port.
    requireTLS: !secure,
    auth: user !== undefined && pass !== undefined ? { user, pass } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });

  return {
    send: async (message: EmailMessage) => {
      try {
        const info = await transport.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          html: message.html,
        });
        return { messageId: info.messageId ?? '' };
      } catch (error) {
        if (isTimeoutError(error)) throw new ProviderTimeoutError('email');
        // The transport error may echo server responses that repeat credentials, so it is dropped.
        throw new ProviderRequestError('email');
      }
    },
  };
};