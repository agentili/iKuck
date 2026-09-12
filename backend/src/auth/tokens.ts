import { createHash, randomBytes } from 'node:crypto';

export interface OpaqueToken {
  raw: string;
  hash: string;
}

export const hashOpaqueToken = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex');

export const createOpaqueToken = (): OpaqueToken => {
  const raw = randomBytes(48).toString('base64url');
  return { raw, hash: hashOpaqueToken(raw) };
};
