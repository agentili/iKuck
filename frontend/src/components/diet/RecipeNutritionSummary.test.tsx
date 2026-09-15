import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RecipeNutrition } from '@ikuck/shared/contracts';
import RecipeNutritionSummary from './RecipeNutritionSummary';

const incompleteNutrition: RecipeNutrition = {
  caloriesPerServing: 560,
  proteinGramsPerServing: 30,
  carbohydrateGramsPerServing: 78,
  fatGramsPerServing: 14,
  source: 'catalog_estimate',
  isComplete: false,
  missingNutrients: ['sodium'],
};

describe('RecipeNutritionSummary', () => {
  it('renders incomplete nutrients with Italian labels', () => {
    render(<RecipeNutritionSummary nutrition={incompleteNutrition} />);

    expect(screen.getByText(/Dati incompleti: mancano sodio/)).toBeVisible();
    expect(screen.queryByText(/mancano sodium/i)).not.toBeInTheDocument();
  });
});
