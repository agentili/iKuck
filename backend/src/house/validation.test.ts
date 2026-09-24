import { describe, expect, it } from 'vitest';
import { houseNameSchema, houseRoleSchema, memberEmailSchema } from './validation.js';

describe('house validation', () => {
  it('normalizes member email before lookup', () => {
    expect(memberEmailSchema.parse('  Person@Example.COM ')).toBe('person@example.com');
  });

  it('rejects an invalid or oversized house name', () => {
    expect(() => houseNameSchema.parse('')).toThrow();
    expect(() => houseNameSchema.parse('x'.repeat(81))).toThrow();
  });

  it('accepts only the supported house roles', () => {
    expect(houseRoleSchema.parse('admin')).toBe('admin');
    expect(houseRoleSchema.parse('member')).toBe('member');
    expect(() => houseRoleSchema.parse('owner')).toThrow();
  });
});
