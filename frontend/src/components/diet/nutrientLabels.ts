const NUTRIENT_LABELS: Record<string, string> = {
  calories: 'calorie',
  calcium: 'calcio',
  carbohydrate: 'carboidrati',
  carbohydrates: 'carboidrati',
  cholesterol: 'colesterolo',
  fat: 'grassi',
  fiber: 'fibre',
  iron: 'ferro',
  potassium: 'potassio',
  protein: 'proteine',
  sodium: 'sodio',
  sugar: 'zuccheri',
};

export const labelNutrient = (nutrient: string): string => {
  const normalized = nutrient.trim().toLowerCase();
  return NUTRIENT_LABELS[normalized] ?? `nutriente ${normalized.replace(/[_-]+/g, ' ')}`;
};

export const labelMissingNutrients = (nutrients: readonly string[]): string => (
  nutrients.map(labelNutrient).join(', ')
);
