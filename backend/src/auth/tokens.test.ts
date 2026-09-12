import { describe, expect, it } from 'vitest';
import { createOpaqueToken, hashOpaqueToken } from './tokens.js';

describe('opaque authentication tokens', () => {
  it('generates a high-entropy raw token and a different persisted digest', () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();

    expect(first.raw).toHaveLength(64);
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toBe(hashOpaqueToken(first.raw));
    expect(first.hash).not.toContain(first.raw);
  });
});
