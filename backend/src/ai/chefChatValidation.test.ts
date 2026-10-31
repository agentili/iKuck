import { describe, expect, it } from 'vitest';
import { parseChefChatRequest } from './chefChatValidation.js';

describe('chef chat request validation', () => {
  it('accepts complete user/assistant turns and a trimmed message', () => {
    expect(parseChefChatRequest({ message: ' ciao ', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }))
      .toEqual({ message: 'ciao', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  });
  it('rejects incomplete turns, privileged roles and extra properties', () => {
    for (const body of [
      { message: 'x', history: [{ role: 'user', content: 'a' }] },
      { message: 'x', history: [{ role: 'system', content: 'a' }, { role: 'assistant', content: 'b' }] },
      { message: 'x', history: [], userId: 'forged' },
    ]) expect(parseChefChatRequest(body)).toBeNull();
  });
  it('rejects per-message, turn and total length limits rather than truncating', () => {
    expect(parseChefChatRequest({ message: 'x'.repeat(2001), history: [] })).toBeNull();
    expect(parseChefChatRequest({ message: 'x', history: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) })).toBeNull();
    expect(parseChefChatRequest({ message: 'x'.repeat(2000), history: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })) })).toBeNull();
  });
});
