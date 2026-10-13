import { describe, expect, it, vi } from 'vitest';
import { createSmtpEmailProvider, type SmtpTransportFactory } from './smtp.js';
import { ProviderRequestError, ProviderTimeoutError } from './types.js';

type SendMailMock = ReturnType<typeof vi.fn>;
type TransportStub = { factory: SmtpTransportFactory; createTransport: SendMailMock; sendMail: SendMailMock };

const baseOptions = {
  host: 'smtp.example',
  port: 587,
  secure: false,
  from: 'no-reply@ikuck.example',
} as const;

const message = { to: 'user@example.com', subject: 'Verify', html: '<p>Verify</p>' } as const;

const transportStub = (sendMail: SendMailMock): TransportStub => {
  const createTransport = vi.fn(() => ({ sendMail }));
  return {
    factory: createTransport as unknown as SmtpTransportFactory,
    createTransport: createTransport as unknown as SendMailMock,
    sendMail,
  };
};

const resolvingTransport = (): TransportStub =>
  transportStub(vi.fn().mockResolvedValue({ messageId: 'smtp-1' }));

const rejectingTransport = (error: unknown): TransportStub =>
  transportStub(vi.fn().mockRejectedValue(error));

describe('createSmtpEmailProvider', () => {
  it('builds a transport without opening a connection', () => {
    expect(() => createSmtpEmailProvider(baseOptions)).not.toThrow();
  });

  it('sends the message through the SMTP transport boundary', async () => {
    const { factory, createTransport, sendMail } = resolvingTransport();
    const provider = createSmtpEmailProvider({ ...baseOptions, createTransport: factory });

    await expect(provider.send(message)).resolves.toEqual({ messageId: 'smtp-1' });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    }));
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@ikuck.example',
      to: 'user@example.com',
      subject: 'Verify',
      html: '<p>Verify</p>',
    });
  });

  it('maps a transport timeout to a stable provider timeout error', async () => {
    const { factory } = rejectingTransport(Object.assign(new Error('Greeting never received'), { code: 'ETIMEOUT' }));
    const provider = createSmtpEmailProvider({ ...baseOptions, createTransport: factory });

    await expect(provider.send(message)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('maps a transport failure to a stable provider error without leaking the password', async () => {
    const { factory } = rejectingTransport(new Error('535 5.7.8 Authentication failed with password sup3r-secret'));
    const provider = createSmtpEmailProvider({
      ...baseOptions,
      createTransport: factory,
      user: 'smtp-user',
      pass: 'sup3r-secret',
    });

    const failure = await provider.send(message).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderRequestError);
    expect(failure).toMatchObject({ code: 'provider_error', provider: 'email' });
    expect((failure as Error).message).not.toContain('sup3r-secret');
    expect((failure as Error).message).not.toContain('535 5.7.8');
  });

  it('only configures authentication when user and password are both present', async () => {
    const withoutPassword = resolvingTransport();
    createSmtpEmailProvider({ ...baseOptions, createTransport: withoutPassword.factory, user: 'smtp-user' });
    expect(withoutPassword.createTransport).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));

    const authenticated = resolvingTransport();
    createSmtpEmailProvider({
      ...baseOptions,
      createTransport: authenticated.factory,
      user: 'smtp-user',
      pass: 'app-pass',
    });
    expect(authenticated.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'smtp-user', pass: 'app-pass' },
    }));
  });

  it('switches to implicit TLS on port 465', async () => {
    const { factory, createTransport } = resolvingTransport();
    createSmtpEmailProvider({ ...baseOptions, port: 465, secure: true, createTransport: factory });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      port: 465,
      secure: true,
      requireTLS: false,
    }));
  });
});