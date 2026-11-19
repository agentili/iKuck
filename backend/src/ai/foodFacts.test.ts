import { describe, expect, it } from 'vitest';
import { resolveFoodFacts, isGenericPastaProviderAlias } from './foodFacts.js';

describe('food facts resolution', () => {
  it.each([
    ['Riso e gambero', ['crustaceans']],
    ['Riso e gamberi', ['crustaceans']],
    ['Riso e cozza', ['molluscs']],
    ['Riso e vongole', ['molluscs']],
    ['Riso e arachidi', ['peanuts']],
    ['Riso e mandorle', ['nuts']],
    ['Riso e senape', ['mustard']],
  ] as const)('retains additive allergen facts for %s', (label, expected) => {
    const facts = resolveFoodFacts(label);
    expect(facts.identityComplete).toBe(true);
    expect(facts.allergenCoverage).toBe('complete');
    expect(facts.presentAllergens).toEqual(expected);
  });

  it.each([
    ['Gambero e cozze', ['crustaceans', 'molluscs'], []],
    ['Arachidi e mandorle', ['peanuts', 'nuts'], []],
    ['Grana e carote', ['milk'], ['eggs']],
    ['Mortadella e pistacchi', ['nuts'], ['sulphites']],
  ] as const)('unions additive facts across families for %s', (label, present, possible) => {
    const facts = resolveFoodFacts(label);
    expect(facts.identityComplete).toBe(true);
    expect(facts.presentAllergens).toEqual(present);
    expect(facts.possibleAllergens).toEqual(possible);
    expect(facts.diets.omnivore).toBe('compatible');
    if (label === 'Gambero e cozze') {
      expect(facts.presentAllergens).not.toContain('fish');
      expect(facts.diets.vegetarian).toBe('incompatible');
      expect(facts.diets.vegan).toBe('incompatible');
    }
    if (label === 'Arachidi e mandorle') expect(facts.presentAllergens).toEqual(['peanuts', 'nuts']);
    if (label === 'Grana e carote') expect(facts.diets.vegetarian).toBe('unknown');
    if (label === 'Mortadella e pistacchi') expect(facts.possibleAllergens).toContain('sulphites');
  });

  it('retains known hazards but leaves an unresolved additive mixture uncertain', () => {
    const facts = resolveFoodFacts('Riso e gamberi e miscela ignota');
    expect(facts.identityComplete).toBe(false);
    expect(facts.allergenCoverage).toBe('unknown');
    expect(facts.presentAllergens).toEqual(['crustaceans']);
    expect(facts.diets.omnivore).toBe('unknown');
  });

  it.each(['Latte di mandorla', 'Latte di soia', 'Noce moscata'])('does not split nonadditive phrase %s', (label) => {
    const facts = resolveFoodFacts(label);
    expect(facts.identityComplete).toBe(false);
    expect(facts.presentAllergens).toEqual([]);
    expect(facts.allergenCoverage).toBe('unknown');
  });

  it.each([
    ['Zucca', true],
    ['Mele', true],
    ['Quinoa', true],
  ])('has independent simple-food facts for %s', (label) => {
    const facts = resolveFoodFacts(label);
    expect(facts.identityComplete).toBe(true);
    expect(facts.allergenCoverage).toBe('complete');
    expect(facts.presentAllergens).toEqual([]);
    expect(facts.diets).toEqual({ omnivore: 'compatible', vegetarian: 'compatible', pescatarian: 'compatible', vegan: 'compatible' });
  });

  it('preserves the conservative Grana egg signal and Mortadella nut/sulphite risks as possible', () => {
    expect(resolveFoodFacts('Parmigiano')).toMatchObject({
      presentAllergens: ['milk'], possibleAllergens: ['eggs'], allergenCoverage: 'partial',
    });
    expect(resolveFoodFacts('Mortadella')).toMatchObject({
      presentAllergens: [], possibleAllergens: ['nuts', 'sulphites'], allergenCoverage: 'partial',
    });
  });

  it('recognizes only explicit potato and generic-pasta identities', () => {
    expect(resolveFoodFacts('Patate novelle').identityKey).toBe(resolveFoodFacts('Patate').identityKey);
    expect(resolveFoodFacts('Patate al pesto').identityComplete).toBe(false);
    expect(resolveFoodFacts('Pasta')).toMatchObject({
      presentAllergens: ['gluten'], possibleAllergens: ['eggs'], allergenCoverage: 'partial',
      diets: { omnivore: 'compatible', vegetarian: 'unknown', pescatarian: 'unknown', vegan: 'unknown' },
    });
    expect(isGenericPastaProviderAlias('Pasta di semola senza uova')).toBe(true);
    expect(isGenericPastaProviderAlias('Pasta all’uovo senza rischi')).toBe(false);
  });

  it.each([
    ['Straccetti di manzo', 'beef'],
    ['Carne macinata', 'ground-meat'],
  ] as const)('resolves the canonical simple meat label %s without inventing extra composition', (label, identity) => {
    expect(resolveFoodFacts(label)).toMatchObject({
      identityKey: identity,
      identityComplete: true,
      presentAllergens: [],
      possibleAllergens: [],
      allergenCoverage: 'complete',
      diets: { omnivore: 'compatible', vegetarian: 'incompatible', pescatarian: 'incompatible', vegan: 'incompatible' },
    });
  });
});
