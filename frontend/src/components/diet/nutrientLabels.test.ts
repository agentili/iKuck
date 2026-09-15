import { describe, expect, it } from 'vitest';
import { labelMissingNutrients, labelNutrient } from './nutrientLabels';

describe('nutrient labels', () => {
  it('localizes supported nutrient identifiers and keeps unknown values readable', () => {
    expect(labelNutrient('sodium')).toBe('sodio');
    expect(labelNutrient('fiber')).toBe('fibre');
    expect(labelNutrient('unknown_value')).toBe('nutriente unknown value');
    expect(labelMissingNutrients(['sodium', 'unknown_value'])).toBe('sodio, nutriente unknown value');
  });
});
