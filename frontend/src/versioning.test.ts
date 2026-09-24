import { describe, expect, it } from 'vitest';
import { createVersionMetadata } from './versioning';

describe('PWA version metadata', () => {
  it('creates stable release metadata for the manifest and diagnostics', () => {
    expect(createVersionMetadata('0.2.0', 'abc1234')).toEqual({
      name: 'iKuck',
      version: '0.2.0',
      buildId: 'abc1234',
    });
  });

  it('uses local for an empty build identifier', () => {
    expect(createVersionMetadata('0.2.0', '   ').buildId).toBe('local');
  });
});
