import { expect, it } from 'vitest';
import config from '../../vitest.config.js';

it('serializes test files that migrate the shared integration database', () => {
  expect(config.test?.fileParallelism).toBe(false);
});
