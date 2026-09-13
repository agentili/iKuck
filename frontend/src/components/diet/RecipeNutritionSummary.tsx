import type { RecipeNutrition } from '@ikuck/shared/contracts';

interface RecipeNutritionSummaryProps {
  nutrition: RecipeNutrition;
}

const formatValue = (value: number | null, suffix: string): string => value === null ? `n/d ${suffix}` : `${value} ${suffix}`;

export default function RecipeNutritionSummary({ nutrition }: RecipeNutritionSummaryProps) {
  const sourceLabel = nutrition.source === 'usda' ? 'Valori USDA aggiornati' : 'Stima indicativa';
  const incompleteLabel = nutrition.missingNutrients.length > 0
    ? `Dati incompleti: mancano ${nutrition.missingNutrients.join(', ')}`
    : null;

  return (
    <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-semibold">
        <span>{formatValue(nutrition.caloriesPerServing, 'kcal')}</span>
        <span>{formatValue(nutrition.proteinGramsPerServing, 'g proteine')}</span>
        <span>{formatValue(nutrition.carbohydrateGramsPerServing, 'g carboidrati')}</span>
        <span>{formatValue(nutrition.fatGramsPerServing, 'g grassi')}</span>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 text-xs font-bold text-amber-800">
        <span>{sourceLabel}</span>
        {incompleteLabel !== null && <span>· {incompleteLabel}</span>}
      </p>
    </div>
  );
}
