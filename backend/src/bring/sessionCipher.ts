import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SessionCipher {
  seal: (ownerId: string, plaintext: string) => string;
  open: (ownerId: string, envelope: string) => string;
}

export const createSessionCipher = (hexKey: string): SessionCipher => {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('Bring encryption key is invalid');
  const key = Buffer.from(hexKey, 'hex');
  const aad = (ownerId: string) => Buffer.from(`ikuck:bring:v1:${ownerId}`, 'utf8');

  return {
    seal: (ownerId, plaintext) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(ownerId));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
    },
    open: (ownerId, envelope) => {
      try {
        if (envelope.length > 32768) throw new Error();
        const parts = envelope.split('.');
        if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
        const iv = Buffer.from(parts[1]!, 'base64url');
        const tag = Buffer.from(parts[2]!, 'base64url');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(aad(ownerId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('Bring session cannot be decrypted');
      }
    },
  };
};
